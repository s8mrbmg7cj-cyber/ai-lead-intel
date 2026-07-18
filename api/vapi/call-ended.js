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
    // USAGE CAP — margin protection (best-effort, never blocks)
    // ─────────────────────────────────────────────

    await checkUsageCap({ client, callData });

    // ─────────────────────────────────────────────
    // SEND CLIENT EMAIL
    // ─────────────────────────────────────────────

    // Vapi's structured extraction (name, callback number, service, etc.) —
    // kept separate from callData so the DB insert is unaffected.
    const structured = (message.analysis && message.analysis.structuredData) || {};

    await sendClientEmail({ client, callData, leadAnalysis, structured });

    // ─────────────────────────────────────────────
    // PHONE PUSH ALERT (every captured lead)
    // ─────────────────────────────────────────────
    // Buzz the owner's phone on every lead via their own private ntfy topic —
    // email still fired above as the backup. HOT leads are marked urgent.

    await sendPushNotification({ client, callData, leadAnalysis, structured });

    // ─────────────────────────────────────────────
    // INSTANT SMS LEAD ALERT (owner's cell)
    // ─────────────────────────────────────────────
    // Text the owner the moment a lead comes in — name, number, and a short
    // summary of what the caller wanted — sent FROM their own AI number so it
    // reads like it's from their receptionist. Email above is the full backup.
    // Best-effort: never blocks or fails the webhook.

    await sendLeadTextAlert({ client, callData, leadAnalysis, structured });

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
// USAGE CAP — margin protection
// ─────────────────────────────────────────────
// Each plan includes a monthly allowance of calls + talk minutes. The AI NEVER
// stops answering (we never want to drop a real customer's lead), but the
// moment usage crosses the included amount we fire ONE alert to the owner so
// they know they're in overage territory. Best-effort: any failure here is
// swallowed so it can never break the webhook or block a lead.

const USAGE_CAPS = {
  starter: { minutes: 250, calls: 100 },
  pro: { minutes: 600, calls: 240 },
};

async function checkUsageCap({ client, callData }) {
  try {
    const plan = client.plan === "pro" ? "pro" : "starter";
    const cap = USAGE_CAPS[plan];
    if (!cap) return;

    // Start of the current calendar month, UTC.
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();

    const url =
      `${process.env.SUPABASE_URL}/rest/v1/calls` +
      `?client_uuid=eq.${client.id}` +
      `&created_at=gte.${monthStart}` +
      `&select=duration_seconds`;

    const resp = await fetch(url, {
      headers: {
        apikey: process.env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      },
    });
    const rows = await resp.json().catch(() => []);
    if (!Array.isArray(rows)) return;

    const totalCalls = rows.length;
    const totalSec = rows.reduce((s, r) => s + (r.duration_seconds || 0), 0);
    const capSec = cap.minutes * 60;

    // Usage BEFORE this call (subtract the one we just saved) so we only alert
    // on the single call that actually crosses the line — never repeatedly.
    const thisSec = callData.duration_seconds || 0;
    const prevSec = totalSec - thisSec;
    const prevCalls = totalCalls - 1;

    const crossedMinutes = prevSec < capSec && totalSec >= capSec;
    const crossedCalls = prevCalls < cap.calls && totalCalls >= cap.calls;

    if (!crossedMinutes && !crossedCalls) return;

    const usedMin = Math.round(totalSec / 60);
    const reason = crossedCalls
      ? `${totalCalls} calls this month (plan includes ${cap.calls})`
      : `${usedMin} talk minutes this month (plan includes ${cap.minutes})`;

    await sendUsageCapAlert({ client, plan, reason, totalCalls, usedMin, cap });
  } catch (err) {
    console.error("USAGE CAP CHECK FAILED:", err);
  }
}

async function sendUsageCapAlert({ client, plan, reason, totalCalls, usedMin, cap }) {
  const biz = client.business_name || "your business";

  // Push to the owner's private topic (same one used for lead alerts).
  const topic = client.ntfy_topic || process.env.NTFY_TOPIC;
  if (topic) {
    try {
      await fetch(`https://ntfy.sh/${topic}`, {
        method: "POST",
        headers: {
          Title: `📊 ${biz} — monthly plan usage reached`,
          Priority: "default",
          Tags: "bar_chart",
        },
        body:
          `You've reached your ${plan.toUpperCase()} plan's included usage: ${reason}.\n\n` +
          `Your AI is still answering every call — no interruption. ` +
          `Reply to upgrade if this is your new normal.`,
      });
    } catch (err) {
      console.error("USAGE CAP PUSH FAILED:", err);
    }
  }

  // Email backup to the business owner + internal notify list.
  const resendKey = process.env.RESEND_API_KEY;
  if (resendKey) {
    const to = [client.notify_email].filter(Boolean);
    if (process.env.NOTIFY_EMAIL) {
      process.env.NOTIFY_EMAIL.split(",").map((e) => e.trim()).filter(Boolean).forEach((e) => to.push(e));
    }
    if (to.length) {
      try {
        await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${resendKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: `AI Lead Intel <hello@aileadintel.com>`,
            to,
            replyTo: "hello@aileadintel.com",
            subject: `You've reached your ${plan.toUpperCase()} plan's monthly usage`,
            html: `
  <div style="background:#f6f7f9;padding:24px 12px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
    <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:24px;">
      <div style="font-size:18px;font-weight:700;color:#111827;">You've reached your plan's included usage</div>
      <div style="font-size:14px;color:#374151;line-height:1.6;margin-top:10px;">
        Hi ${escapeHtml(biz)} — heads up, you've reached the usage included in your
        <strong>${plan.toUpperCase()}</strong> plan this month: <strong>${escapeHtml(reason)}</strong>.
      </div>
      <div style="font-size:14px;color:#374151;line-height:1.6;margin-top:12px;">
        <strong>Nothing is turned off.</strong> Your AI receptionist is still answering every call —
        we'd never let a real lead slip. This is just a friendly heads-up in case you'd like to move
        up to a plan with more room.
      </div>
      <div style="font-size:13px;color:#6b7280;margin-top:16px;">
        This month so far: ${totalCalls} calls · ~${usedMin} talk minutes
        (plan includes ${cap.calls} calls / ${cap.minutes} minutes).
      </div>
      <div style="font-size:13px;color:#9ca3af;margin-top:18px;">Just reply to this email to upgrade or ask a question.</div>
    </div>
  </div>`,
          }),
        });
      } catch (err) {
        console.error("USAGE CAP EMAIL FAILED:", err);
      }
    }
  }
}

// ─────────────────────────────────────────────
// EMAIL CLIENT
// ─────────────────────────────────────────────

async function sendClientEmail({ client, callData, leadAnalysis, structured = {} }) {
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

  // Prefer what the caller actually SAID (Vapi's structured extraction) over
  // raw call metadata. The caller ID is only a last resort for the phone.
  const callerId = callData.caller_number || "";
  const callbackRaw = (structured.callback_number || "").trim();
  const bestNumber = callbackRaw || callerId || "Unknown number";
  const phonePretty = prettyPhone(bestNumber);
  const leadName = (structured.caller_name || callData.caller_name || "").trim() || phonePretty;
  const service = (structured.service_requested || "").trim() || prettyIndustry(client.industry);
  const address = (structured.address || "").trim();
  const emailFound = (structured.email || "").trim() || extractEmailFromTranscript(callData.transcript);
  const duration = prettyDuration(callData.duration_seconds);
  const outcome = leadAnalysis.outcome || "Call handled";

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
            ${row("Phone", `<a href="tel:${escapeHtml(bestNumber)}" style="color:#c2410c;text-decoration:none;">${escapeHtml(phonePretty)}</a>`)}
            ${emailFound ? row("Email", escapeHtml(emailFound)) : ""}
            ${address ? row("Address", escapeHtml(address)) : ""}
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

async function sendPushNotification({ client, callData, leadAnalysis = {}, structured = {} }) {
  // Each client has their own private topic (set at onboarding). Fall back to
  // the global env topic only for legacy rows created before ntfy_topic existed.
  const topic = client.ntfy_topic || process.env.NTFY_TOPIC;
  if (!topic) {
    console.log("NO NTFY TOPIC for client:", client.business_name);
    return;
  }

  const isHot = leadAnalysis.score === "HOT";
  const bestNumber =
    (structured.callback_number || "").trim() ||
    callData.caller_number ||
    "Unknown number";
  const leadName =
    (structured.caller_name || callData.caller_name || "").trim() ||
    prettyPhone(bestNumber);
  const service =
    (structured.service_requested || "").trim() ||
    prettyIndustry(client.industry);

  const title = isHot
    ? `🔥 Hot Lead — ${service}`
    : `New Lead — ${service}`;

  // Name + number lead the alert (so the owner can call back instantly); a
  // summary of what the caller actually said follows underneath. ntfy caps very
  // long bodies, so the summary is trimmed to stay readable on a lock screen.
  // Falls back to the short outcome tag when no summary was produced.
  const summaryText = (callData.summary || "").trim();
  const shortSummary =
    summaryText.length > 280 ? summaryText.slice(0, 277) + "…" : summaryText;
  const body =
    `${leadName}\n` +
    `${prettyPhone(bestNumber)}\n\n` +
    (shortSummary || leadAnalysis.outcome || "Call handled");

  try {
    await fetch(`https://ntfy.sh/${topic}`, {
      method: "POST",
      headers: {
        Title: title,
        Priority: isHot ? "urgent" : "default",
        Tags: isHot ? "fire,phone" : "phone",
      },
      body,
    });
    console.log("PUSH SENT to", topic);
  } catch (err) {
    console.error("PUSH FAILED:", err);
  }
}

// ─────────────────────────────────────────────
// SMS LEAD ALERT (Twilio)
// ─────────────────────────────────────────────
// Sends a short branded text to the owner's cell (alert_sms_number, set at
// onboarding from their transfer/cell number). Sent FROM the client's own AI
// number so it looks like it's from their receptionist. If the number or
// Twilio creds are missing, it quietly no-ops — the email is the full backup.

function toE164(raw) {
  const d = String(raw || "").replace(/\D/g, "");
  if (!d) return "";
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d[0] === "1") return `+${d}`;
  if (String(raw).trim().startsWith("+")) return `+${d}`;
  return "";
}

async function sendLeadTextAlert({ client, callData, leadAnalysis = {}, structured = {} }) {
  const to = toE164(client.alert_sms_number || "");
  if (!to) {
    console.log("NO SMS ALERT NUMBER for client:", client.business_name);
    return;
  }

  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = toE164(client.twilio_number || process.env.TWILIO_PHONE_NUMBER || "");
  if (!sid || !token || !from) {
    console.log("SMS alert skipped — Twilio creds or from-number missing");
    return;
  }

  const isHot = leadAnalysis.score === "HOT";
  const bestNumber =
    (structured.callback_number || "").trim() ||
    callData.caller_number ||
    "Unknown number";
  const leadName =
    (structured.caller_name || callData.caller_name || "").trim() ||
    prettyPhone(bestNumber);
  const service =
    (structured.service_requested || "").trim() ||
    prettyIndustry(client.industry);
  const biz = client.business_name || "your business";

  const summaryText = (callData.summary || "").trim();
  const shortSummary =
    summaryText.length > 220 ? summaryText.slice(0, 217) + "…" : summaryText;

  const lines = [
    `${isHot ? "🔥 " : ""}New ${service} lead — ${biz}`,
    `${leadName}`,
    `${prettyPhone(bestNumber)}`,
  ];
  if (shortSummary) lines.push(`\n${shortSummary}`);
  const body = lines.join("\n");

  try {
    const resp = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ To: to, From: from, Body: body }),
      }
    );
    if (!resp.ok) {
      console.error("SMS ALERT FAILED:", resp.status, await resp.text());
    } else {
      console.log("SMS ALERT SENT to owner");
    }
  } catch (err) {
    console.error("SMS ALERT ERROR:", err.message);
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
