// api/fb-leads-webhook.js
//
// Receives Facebook/Instagram Lead Ads submissions and pushes them into the
// SAME notification pipeline as website leads (ntfy push -> Andrew's phone,
// email via Resend, save to Supabase). Mirrors api/lead-submit.js so a FB lead
// feels identical to an aileadintel.com lead.
//
// HOW FACEBOOK CALLS THIS:
//   1. GET  — one-time verification handshake. Facebook sends
//             ?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...
//             We echo hub.challenge back if the token matches FB_VERIFY_TOKEN.
//   2. POST — on every new lead. The body only contains a `leadgen_id`, NOT the
//             lead's answers. We call the Graph API with FB_PAGE_TOKEN to fetch
//             the actual field_data (name/email/phone/business).
//
// Required env vars:
//   FB_VERIFY_TOKEN  — any secret string you choose; paste the same value into
//                      Meta's webhook setup screen.
//   FB_PAGE_TOKEN    — long-lived Page access token with leads_retrieval scope.
//   (reuses) NTFY_TOPIC, RESEND_API_KEY, NOTIFY_EMAIL, SUPABASE_URL,
//            SUPABASE_SERVICE_KEY — same ones lead-submit.js already uses.

const NTFY_TOPIC = process.env.NTFY_TOPIC || "mcr-leads-andrew-2025";
const FB_VERIFY_TOKEN = process.env.FB_VERIFY_TOKEN || "";
const FB_PAGE_TOKEN = process.env.FB_PAGE_TOKEN || "";
const GRAPH_VERSION = "v21.0";

function normalizePhone(raw) {
  if (!raw) return "";
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
  if (digits.length === 10) return "+1" + digits;
  return "+" + digits;
}

// Pull the answers out of a fetched lead's field_data array.
// Facebook field names vary (full_name, email, phone_number, plus our custom
// "what type of business do you run?"), so match loosely.
function parseFieldData(fieldData) {
  const out = { name: "", email: "", phone: "", business_type: "" };
  for (const f of fieldData || []) {
    const key = String(f.name || "").toLowerCase();
    const val = Array.isArray(f.values) ? (f.values[0] || "") : (f.values || "");
    if (!val) continue;
    if (key.includes("full_name") || key === "name") out.name = val;
    else if (key.includes("first_name") && !out.name) out.name = val;
    else if (key.includes("email")) out.email = val;
    else if (key.includes("phone")) out.phone = val;
    else if (key.includes("business") || key.includes("type")) out.business_type = val;
  }
  return out;
}

// Fetch the real lead answers from the Graph API using the leadgen_id.
async function fetchLead(leadgenId) {
  if (!FB_PAGE_TOKEN) {
    console.log("[fb-leads] FB_PAGE_TOKEN missing — cannot fetch lead", leadgenId);
    return null;
  }
  try {
    const url = `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(leadgenId)}?fields=field_data,created_time&access_token=${encodeURIComponent(FB_PAGE_TOKEN)}`;
    const res = await fetch(url);
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.log("[fb-leads] Graph fetch error", res.status, JSON.stringify(json).slice(0, 300));
      return null;
    }
    return parseFieldData(json.field_data);
  } catch (err) {
    console.log("[fb-leads] Graph fetch exception:", err.message);
    return null;
  }
}

async function sendNtfyNotification({ name, phone, email, business_type }) {
  try {
    const body = `New Facebook Lead!
Name: ${name || "Not given"}
Business: ${business_type || "Not specified"}
Phone: ${phone || "Not given"}
Email: ${email || "Not given"}
Submitted: ${new Date().toLocaleString("en-US", { timeZone: "America/Chicago" })}`;

    const res = await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
      method: "POST",
      headers: {
        "Title": `New FB Lead: ${name || "Unknown"}`,
        "Priority": "high",
        "Tags": "bell,rotating_light",
        "Click": phone ? `tel:${phone}` : "",
      },
      body,
    });
    if (res.ok) { console.log("[fb-leads] NTFY SENT to", NTFY_TOPIC); return true; }
    console.log("[fb-leads] NTFY ERROR:", res.status, await res.text());
    return false;
  } catch (err) {
    console.log("[fb-leads] NTFY ERROR:", err.message);
    return false;
  }
}

async function notifyOwnerEmail({ name, phone, email, business_type }) {
  const RESEND_KEY = process.env.RESEND_API_KEY;
  const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL;
  if (!RESEND_KEY || !NOTIFY_EMAIL) {
    console.log("[fb-leads] EMAIL SKIPPED — missing RESEND_API_KEY or NOTIFY_EMAIL");
    return;
  }
  try {
    const { Resend } = await import("resend");
    const resend = new Resend(RESEND_KEY);
    await resend.emails.send({
      from: "AI Lead Intel <onboarding@resend.dev>",
      to: NOTIFY_EMAIL,
      subject: `New Facebook Lead: ${name || "Unknown"} (${business_type || "n/a"})`,
      html: `
        <div style="font-family:sans-serif;max-width:500px;background:#0d1422;color:#f0f4ff;padding:28px;border-radius:10px;">
          <h2 style="color:#ff8c00;margin:0 0 16px;">New Facebook Lead!</h2>
          <p><strong>Name:</strong> ${name || "Not given"}</p>
          <p><strong>Phone:</strong> ${phone ? `<a href="tel:${phone}" style="color:#ff8c00;">${phone}</a>` : "Not given"}</p>
          <p><strong>Email:</strong> ${email || "Not given"}</p>
          <p><strong>Business:</strong> ${business_type || "Not specified"}</p>
          <p style="margin-top:16px;color:rgba(240,244,255,0.6);">Came from your Facebook lead form. Call or text them fast while they're warm.</p>
        </div>
      `,
    });
    console.log("[fb-leads] EMAIL SENT to", NOTIFY_EMAIL);
  } catch (err) {
    console.log("[fb-leads] EMAIL ERROR:", err.message);
  }
}

async function saveLeadToSupabase({ name, phone, email, business_type }) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.log("[fb-leads] SUPABASE SKIPPED — missing url/key");
    return;
  }
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/leads`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SUPABASE_KEY,
        "Authorization": `Bearer ${SUPABASE_KEY}`,
        "Prefer": "return=minimal",
      },
      body: JSON.stringify({
        name,
        phone,
        business_type,
        source: "facebook_lead_ad",
        status: "new",
      }),
    });
    if (res.ok) console.log("[fb-leads] SUPABASE SAVED lead:", name);
    else console.log("[fb-leads] SUPABASE ERROR:", res.status, await res.text());
  } catch (err) {
    console.log("[fb-leads] SUPABASE ERROR:", err.message);
  }
}

export default async function handler(req, res) {
  // 1. GET — Facebook's verification handshake.
  if (req.method === "GET") {
    const q = req.query || {};
    const mode = q["hub.mode"];
    const token = q["hub.verify_token"];
    const challenge = q["hub.challenge"];
    if (mode === "subscribe" && token && token === FB_VERIFY_TOKEN) {
      console.log("[fb-leads] webhook verified");
      return res.status(200).send(challenge);
    }
    console.log("[fb-leads] webhook verify FAILED (token mismatch)");
    return res.status(403).send("Forbidden");
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // 2. POST — a new lead. Acknowledge Facebook FAST (must be < a few sec),
  //    then process. We still await so serverless doesn't kill it early.
  let body = req.body || {};
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (_) { body = {}; } }

  try {
    const entries = Array.isArray(body.entry) ? body.entry : [];
    const jobs = [];
    for (const entry of entries) {
      for (const change of (entry.changes || [])) {
        const v = change.value || {};
        const leadgenId = v.leadgen_id;
        if (!leadgenId) continue;
        jobs.push((async () => {
          const lead = await fetchLead(leadgenId);
          if (!lead) return;
          lead.phone = normalizePhone(lead.phone);
          console.log("[fb-leads] NEW FB LEAD:", lead.name, lead.phone, lead.business_type);
          await Promise.all([
            sendNtfyNotification(lead),
            notifyOwnerEmail(lead),
            saveLeadToSupabase(lead),
          ]);
        })());
      }
    }
    await Promise.all(jobs);
  } catch (err) {
    console.log("[fb-leads] processing error:", err.message);
  }

  // Always 200 so Facebook doesn't disable the webhook and retry-storm us.
  return res.status(200).json({ received: true });
}
