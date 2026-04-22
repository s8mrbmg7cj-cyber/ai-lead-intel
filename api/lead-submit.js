// api/lead-submit.js — v4
// Handles form submissions from landing page
// - Sends ntfy push notification to Andrew's phone
// - Sends email notification to Andrew
// - Saves lead to Supabase
// - SMS-to-lead DISABLED until A2P approves (uncomment when ready)

import { getWelcomeMessage } from "../lib/frontdesk.js";

const NTFY_TOPIC = process.env.NTFY_TOPIC || "mcr-leads-andrew-2025";

function normalizePhone(raw) {
  if (!raw) return "";
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
  if (digits.length === 10) return "+1" + digits;
  return "+" + digits;
}

async function sendNtfyNotification({ name, phone, business_type }) {
  try {
    const body = `New Lead!
Name: ${name}
Business: ${business_type || "Not specified"}
Phone: ${phone}
Submitted: ${new Date().toLocaleString("en-US", { timeZone: "America/Chicago" })}`;

    const res = await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
      method: "POST",
      headers: {
        "Title": `New Lead: ${name}`,
        "Priority": "high",
        "Tags": "bell,rotating_light",
        "Click": `tel:${phone}`,
      },
      body,
    });

    if (res.ok) {
      console.log("NTFY SENT to", NTFY_TOPIC);
      return true;
    } else {
      console.log("NTFY ERROR:", res.status, await res.text());
      return false;
    }
  } catch (err) {
    console.log("NTFY ERROR:", err.message);
    return false;
  }
}

async function notifyOwnerEmail({ name, phone, business_type }) {
  const RESEND_KEY   = process.env.RESEND_API_KEY;
  const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL;
  if (!RESEND_KEY || !NOTIFY_EMAIL) {
    console.log("EMAIL SKIPPED — missing RESEND_API_KEY or NOTIFY_EMAIL");
    return;
  }

  try {
    const { Resend } = await import("resend");
    const resend = new Resend(RESEND_KEY);
    await resend.emails.send({
      from: "AI Lead Intel <onboarding@resend.dev>",
      to: NOTIFY_EMAIL,
      subject: `New Lead: ${name} (${business_type})`,
      html: `
        <div style="font-family:sans-serif;max-width:500px;background:#0d1422;color:#f0f4ff;padding:28px;border-radius:10px;">
          <h2 style="color:#ff8c00;margin:0 0 16px;">New Inbound Lead!</h2>
          <p><strong>Name:</strong> ${name}</p>
          <p><strong>Phone:</strong> <a href="tel:${phone}" style="color:#ff8c00;">${phone}</a></p>
          <p><strong>Business:</strong> ${business_type}</p>
          <p style="margin-top:16px;color:rgba(240,244,255,0.6);">Jump in and close them. When A2P approves, the AI will auto-text these leads too.</p>
        </div>
      `,
    });
    console.log("EMAIL SENT to", NOTIFY_EMAIL);
  } catch (err) {
    console.log("EMAIL ERROR:", err.message);
  }
}

async function saveLeadToSupabase({ name, phone, business_type }) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.log("SUPABASE SKIPPED — missing SUPABASE_URL or SUPABASE_SERVICE_KEY");
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
        source: "aileadintel.com",
        status: "new",
      }),
    });

    if (res.ok) {
      console.log("SUPABASE SAVED lead:", name);
    } else {
      console.log("SUPABASE ERROR:", res.status, await res.text());
    }
  } catch (err) {
    console.log("SUPABASE ERROR:", err.message);
  }
}

// DISABLED until A2P approves — uncomment the sendSMS call below when ready
async function sendSMS(to, body) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;
  const from       = process.env.TWILIO_PHONE_NUMBER;
  if (!accountSid || !authToken || !from) {
    console.log("SMS MOCK to", to, ":", body);
    return true;
  }
  try {
    const { default: twilio } = await import("twilio");
    const client = twilio(accountSid, authToken);
    await client.messages.create({ body, from, to });
    console.log("SMS SENT to", to);
    return true;
  } catch (err) {
    console.log("SMS ERROR:", err.message);
    return false;
  }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).json({ ok: true });
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { name, phone, business_type } = req.body || {};
  if (!name || !phone) return res.status(400).json({ error: "Name and phone required" });

  const normalizedPhone = normalizePhone(phone);
  const leadData = { name, phone: normalizedPhone, business_type };

  console.log("NEW LEAD:", name, normalizedPhone, business_type);

  // Fire all three notifications in parallel
  await Promise.all([
    sendNtfyNotification(leadData),
    notifyOwnerEmail(leadData),
    saveLeadToSupabase(leadData),
  ]);

  // ───────────────────────────────────────────────────────────
  // A2P GATE — when A2P 10DLC approves, uncomment the lines below
  // to start auto-texting leads. The getWelcomeMessage() function
  // generates an AI-crafted opener via lib/frontdesk.js.
  // ───────────────────────────────────────────────────────────
  //
  // const welcomeMsg = await getWelcomeMessage(leadData);
  // await sendSMS(normalizedPhone, welcomeMsg);

  return res.status(200).json({
    success: true,
    message: "Lead captured — notifications sent",
  });
}
