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
  const caller = callData.caller_number || "Unknown number";
  const dur = callData.duration_seconds ? `${callData.duration_seconds}s` : "—";

  // Plain, personal, transactional layout — no marketing styling, no emoji,
  // single column, dark text on white. This reads as a 1:1 message to Gmail,
  // which keeps it in the Primary tab instead of Promotions.
  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#1a1a1a;max-width:560px;">
      <p>You got a new call at <strong>${escapeHtml(biz)}</strong>.</p>
      <p style="margin:0 0 4px;">Caller: <strong>${escapeHtml(caller)}</strong><br/>
      Lead: <strong>${escapeHtml(leadAnalysis.score)}</strong><br/>
      Outcome: ${escapeHtml(leadAnalysis.outcome || "—")}<br/>
      Length: ${escapeHtml(dur)}</p>
      ${callData.summary ? `<p style="margin:16px 0 4px;"><strong>Summary</strong><br/>${escapeHtml(callData.summary)}</p>` : ""}
      ${callData.transcript ? `<p style="margin:16px 0 4px;"><strong>Transcript</strong></p><div style="white-space:pre-wrap;color:#444;border-left:3px solid #ddd;padding-left:12px;">${escapeHtml(callData.transcript)}</div>` : ""}
      <p style="margin-top:20px;color:#666;font-size:13px;">— AI Lead Intel</p>
    </div>
  `;

  const callerShort = caller && caller !== "Unknown number" ? caller : "new caller";

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
      subject: `New call from ${callerShort} — ${biz}`,
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
        Title: `🔥 HOT LEAD - ${client.business_name}`,
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
