export const config = {
  maxDuration: 30,
};
import crypto from "crypto";

// ─────────────────────────────────────────────
// VERIFY THE REQUEST IS REALLY FROM VAPI
// ─────────────────────────────────────────────
// Vapi sends the secret you configured (assistant.server.secret) as a plain
// header called `x-vapi-secret`. Older setups used an HMAC in `x-vapi-signature`.
// We accept either, and — so first-time testing isn't blocked — we allow the
// request through if no VAPI_WEBHOOK_SECRET is configured yet (with a warning).
// Set VAPI_WEBHOOK_SECRET in Vercel (provision.js sends the same value to Vapi)
// to lock this down before real clients.
function verifyVapi(req) {
  const secret = process.env.VAPI_WEBHOOK_SECRET;

  if (!secret) {
    console.warn("VAPI_WEBHOOK_SECRET not set — skipping webhook auth (set it before launch).");
    return true;
  }

  // 1) Plain shared-secret header (Vapi's default).
  const headerSecret = req.headers["x-vapi-secret"];
  if (headerSecret && headerSecret === secret) return true;

  // 2) HMAC signature fallback (older scheme).
  const signature = req.headers["x-vapi-signature"];
  if (signature) {
    try {
      const rawBody = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
      const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
      if (signature === expected) return true;
    } catch (err) {
      console.error("Signature check error:", err);
    }
  }

  console.error("Webhook auth failed — no matching x-vapi-secret or x-vapi-signature.");
  return false;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!verifyVapi(req)) {
    return res.status(401).json({ error: "Invalid webhook auth" });
  }

  try {
    const payload = req.body;
    const messageType = payload?.message?.type;

    if (messageType !== "end-of-call-report") {
      return res.status(200).json({ received: true });
    }

    const message = payload.message;
    const call = message.call || {};
    const customer = call.customer || {};

    const assistantId = call.assistantId || call.assistant?.id || null;

    console.log("CALL ENDED — assistant:", assistantId);

    // ─────────────────────────────────────────────
    // LOOK UP CLIENT
    // ─────────────────────────────────────────────

    const client = await getClientByAssistantId(assistantId);

    if (!client) {
      console.error("NO CLIENT FOUND FOR ASSISTANT:", assistantId);
      return res.status(200).json({ success: false, error: "No matching client" });
    }

    console.log("CLIENT FOUND:", client.business_name);

    // Don't process calls for cancelled/inactive clients — no dashboard entry,
    // no email. (A cancelled client's assistant should already be removed, but
    // this is a safety net so a lingering call can't be logged or emailed.)
    const clientStatus = (client.status || '').toLowerCase();
    if (clientStatus === 'cancelled' || clientStatus === 'paused' || client.active === false) {
      console.log("CLIENT INACTIVE — skipping log/email:", client.business_name, clientStatus);
      return res.status(200).json({ received: true, skipped: "client_inactive" });
    }

    const transcript = message.transcript || formatTranscript(message.messages);

    const callData = {
      vapi_call_id: call.id,
      assistant_id: assistantId,
      phone_number_id: call.phoneNumberId || null,
      caller_number: customer.number || call.customer?.number || "Unknown",
      caller_name: customer.name || null,
      duration_seconds: Math.round(call.duration || message.durationSeconds || 0),
      call_status: call.status || "ended",
      ended_reason: message.endedReason || call.endedReason || "unknown",
      transcript,
      summary: message.summary || message.analysis?.summary || null,
      recording_url: message.recordingUrl || call.recordingUrl || null,
      raw_payload: payload,
      client_uuid: client.id,
    };

    // ─────────────────────────────────────────────
    // LEAD ANALYSIS
    // ─────────────────────────────────────────────

    const leadAnalysis = analyzeLead(transcript);

    callData.lead_score = leadAnalysis.score;
    callData.outcome = leadAnalysis.outcome;
    callData.asked_for_transfer = leadAnalysis.askedForTransfer;
    callData.asked_for_pricing = leadAnalysis.askedForPricing;

    // ─────────────────────────────────────────────
    // SAVE CALL
    // ─────────────────────────────────────────────

    await saveToSupabase(callData);

    // ─────────────────────────────────────────────
    // SEND CLIENT EMAIL
    // ─────────────────────────────────────────────

    await sendClientEmail({ client, callData, leadAnalysis });

    // ─────────────────────────────────────────────
    // HOT LEAD ALERT
    // ─────────────────────────────────────────────

    if (leadAnalysis.score === "HOT") {
      await sendPushNotification({ client, callData });
    }

    return res.status(200).json({
      success: true,
      client: client.business_name,
      lead_score: leadAnalysis.score,
    });
  } catch (error) {
    console.error("WEBHOOK ERROR:", error);
    return res.status(200).json({ error: error.message });
  }
}

// ─────────────────────────────────────────────
// CLIENT LOOKUP
// ─────────────────────────────────────────────
// FIX: provision.js stores the Vapi assistant id in `vapi_assistant_id`, not
// `assistant_id`. Query that column first, and fall back to the legacy column
// for any older rows so nothing breaks either way.

async function getClientByAssistantId(assistantId) {
  if (!assistantId) return null;

  const base = `${process.env.SUPABASE_URL}/rest/v1/clients`;
  const headers = {
    apikey: process.env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
  };

  // Primary: the column provision actually writes.
  let resp = await fetch(`${base}?vapi_assistant_id=eq.${assistantId}&select=*`, { headers });
  let data = await resp.json().catch(() => []);
  if (Array.isArray(data) && data.length > 0) return data[0];

  // Fallback: legacy column, in case any old rows used it.
  resp = await fetch(`${base}?assistant_id=eq.${assistantId}&select=*`, { headers });
  data = await resp.json().catch(() => []);
  if (Array.isArray(data) && data.length > 0) return data[0];

  return null;
}

// ─────────────────────────────────────────────
// SAVE CALL
// ─────────────────────────────────────────────

async function saveToSupabase(callData) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/calls`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      apikey: process.env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(callData),
  });

  if (!response.ok) {
    const err = await response.text();
    console.error("SUPABASE SAVE FAILED:");
    console.error(err);
    throw new Error("Failed saving call");
  }

  console.log("CALL SAVED");
}

// ─────────────────────────────────────────────
// EMAIL CLIENT
// ─────────────────────────────────────────────

async function sendClientEmail({ client, callData, leadAnalysis }) {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) {
    console.log("NO RESEND KEY");
    return;
  }

  const biz = client.business_name || "your business";

  // ── Presentation-only mappings. The stored lead_score (HOT/WARM/COLD/NONE)
  //    and all analysis logic are untouched — this just translates them for
  //    display in the email.
  const priorityMap = { HOT: "High", WARM: "Medium", COLD: "Low", NONE: "Low" };
  const priority = priorityMap[leadAnalysis.score] || "Low";
  const priorityColors = {
    High: { bg: "#fff1e8", border: "#ff6a00", text: "#c2410c" },
    Medium: { bg: "#fef9ec", border: "#f59e0b", text: "#92400e" },
    Low: { bg: "#f4f4f5", border: "#d4d4d8", text: "#52525b" },
  };
  const pc = priorityColors[priority];

  const service = prettyIndustry(client.industry);
  const callerNumber = callData.caller_number || "Unknown number";
  const phonePretty = prettyPhone(callerNumber);
  const leadName = (callData.caller_name || "").trim() || phonePretty;
  const duration = prettyDuration(callData.duration_seconds);
  const outcome = leadAnalysis.outcome || "Call handled";
  const emailFound = extractEmailFromTranscript(callData.transcript);

  const action =
    priority === "High"
      ? "📞 Call back within 15 minutes — this caller showed strong buying intent."
      : priority === "Medium"
        ? "📞 Call back today while the inquiry is still fresh."
        : "No urgent action needed — review when convenient.";

  const row = (label, value) => `
            <tr>
              <td style="padding:7px 0;font-size:13px;color:#6b7280;width:150px;vertical-align:top;">${label}</td>
              <td style="padding:7px 0;font-size:14px;color:#111827;font-weight:600;">${value}</td>
            </tr>`;

  const html = `
  <div style="background:#f6f7f9;padding:24px 12px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
    <div style="max-width:600px;margin:0 auto;">
      <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:14px;overflow:hidden;">
        <div style="padding:20px 24px;border-bottom:1px solid #f0f0f2;">
          <div style="font-size:18px;font-weight:700;color:#111827;">🚨 New Lead Captured</div>
          <div style="font-size:13px;color:#6b7280;margin-top:2px;">${escapeHtml(biz)} · answered by your AI receptionist</div>
        </div>
        <div style="padding:20px 24px;">
          <span style="display:inline-block;background:${pc.bg};border:1px solid ${pc.border};color:${pc.text};font-size:12px;font-weight:700;letter-spacing:0.04em;padding:5px 12px;border-radius:999px;">PRIORITY: ${priority.toUpperCase()}</span>
          <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin-top:14px;border-collapse:collapse;">
            ${row("Service Requested", escapeHtml(service))}
            ${row("Name", escapeHtml(leadName))}
            ${row("Phone", `<a href="tel:${escapeHtml(callerNumber)}" style="color:#c2410c;text-decoration:none;">${escapeHtml(phonePretty)}</a>`)}
            ${emailFound ? row("Email", escapeHtml(emailFound)) : ""}
            ${row("Call Duration", escapeHtml(duration))}
            ${row("Outcome", escapeHtml(outcome))}
          </table>
          <div style="margin-top:16px;background:#fff8f3;border:1px solid #ffd9bd;border-radius:10px;padding:12px 16px;font-size:14px;color:#111827;">
            <strong>Recommended action:</strong> ${escapeHtml(action)}
          </div>
        </div>
      </div>
      ${callData.summary ? `
      <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:14px;margin-top:14px;padding:20px 24px;">
        <div style="font-size:14px;font-weight:700;color:#111827;margin-bottom:8px;">Conversation Summary</div>
        <div style="font-size:14px;line-height:1.65;color:#374151;">${escapeHtml(callData.summary)}</div>
      </div>` : ""}
      ${callData.transcript ? `
      <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:14px;margin-top:14px;padding:20px 24px;">
        <details>
          <summary style="font-size:14px;font-weight:700;color:#111827;cursor:pointer;">Full Transcript</summary>
          <div style="white-space:pre-wrap;font-size:13px;line-height:1.6;color:#4b5563;border-left:3px solid #e5e7eb;padding-left:12px;margin-top:12px;">${escapeHtml(callData.transcript)}</div>
        </details>
      </div>` : ""}
      <div style="text-align:center;font-size:12px;color:#9ca3af;margin-top:18px;">AI Lead Intel · every call answered, every lead captured</div>
    </div>
  </div>`;

  // Subject mirrors the lead's importance — the 🔥 is reserved for genuine
  // buying intent so it never cries wolf on spam or hang-ups.
  const subject =
    priority === "High"
      ? `🔥 New ${service} Lead - ${leadName}`
      : priority === "Medium"
        ? `New ${service} Lead - ${leadName}`
        : `Call handled - ${leadName} — ${biz}`;

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: `${biz} via AI Lead Intel <hello@aileadintel.com>`,
      to: [client.notify_email],
      replyTo: "hello@aileadintel.com",
      subject,
      html,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    console.error("EMAIL FAILED:");
    console.error(err);
  } else {
    console.log("CLIENT EMAIL SENT");
  }
}

// ── Email presentation helpers (display formatting only) ──

function prettyIndustry(industry) {
  const s = String(industry || "").replace(/[_-]+/g, " ").trim();
  if (!s) return "Customer";
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

function prettyPhone(num) {
  const d = String(num || "").replace(/[^\d]/g, "").replace(/^1/, "");
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  return String(num || "Unknown");
}

function prettyDuration(seconds) {
  const s = Math.max(0, Math.round(seconds || 0));
  if (!s) return "—";
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m ? `${m}m ${r}s` : `${r}s`;
}

function extractEmailFromTranscript(transcript) {
  const m = String(transcript || "").match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  return m ? m[0] : null;
}

// ─────────────────────────────────────────────
// PUSH ALERTS
// ─────────────────────────────────────────────

async function sendPushNotification({ client, callData }) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) return;

  try {
    await fetch(`https://ntfy.sh/${topic}`, {
      method: "POST",
      headers: {
        Title: `🔥 High-Priority Lead - ${client.business_name}`,
        Priority: "high",
        Tags: "fire,phone",
      },
      body: `${client.business_name}\nCaller: ${callData.caller_number}`,
    });
    console.log("PUSH SENT");
  } catch (err) {
    console.error("PUSH FAILED:", err);
  }
}

// ─────────────────────────────────────────────
// LEAD ANALYZER
// ─────────────────────────────────────────────

function analyzeLead(transcript) {
  const t = (transcript || "").toLowerCase();

  const hotSignals = ["ready to book", "want to rent", "reserve", "sign up", "i'll take it", "move in"];
  const warmSignals = ["pricing", "price", "cost", "available", "availability", "hours", "how much"];

  const askedForTransfer = /human|manager|representative|real person/i.test(t);
  const askedForPricing = /price|pricing|cost|monthly/i.test(t);

  let score = "COLD";
  let outcome = "General inquiry";

  for (const signal of hotSignals) {
    if (t.includes(signal)) {
      score = "HOT";
      outcome = "Ready to buy";
      break;
    }
  }

  if (score !== "HOT") {
    let warmCount = 0;
    for (const signal of warmSignals) {
      if (t.includes(signal)) warmCount++;
    }
    if (warmCount >= 2) {
      score = "WARM";
      outcome = "Interested lead";
    }
  }

  if (!t || t.length < 40) {
    score = "NONE";
    outcome = "Short call";
  }

  return { score, outcome, askedForTransfer, askedForPricing };
}

// ─────────────────────────────────────────────
// TRANSCRIPT FORMATTER
// ─────────────────────────────────────────────

function formatTranscript(messages) {
  if (!messages || !Array.isArray(messages)) return "";
  return messages
    .filter((m) => m.role && m.message)
    .map((m) => {
      const role = m.role === "assistant" || m.role === "bot" ? "AI" : "Caller";
      return `${role}: ${m.message}`;
    })
    .join("\n");
}

// ─────────────────────────────────────────────
// ESCAPE HTML
// ─────────────────────────────────────────────

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
