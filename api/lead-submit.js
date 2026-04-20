// api/lead-submit.js — v2
// Handles form submissions from landing page
// Sends immediate AI text, starts conversation

import { getWelcomeMessage, getAIResponse } from "../lib/frontdesk.js";

function normalizePhone(raw) {
  if (!raw) return "";
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
  if (digits.length === 10) return "+1" + digits;
  return "+" + digits;
}

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

async function notifyOwner({ name, phone, business_type }) {
  const RESEND_KEY   = process.env.RESEND_API_KEY;
  const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL;
  if (!RESEND_KEY || !NOTIFY_EMAIL) return;

  try {
    const { Resend } = await import("resend");
    const resend = new Resend(RESEND_KEY);
    await resend.emails.send({
      from: "AI Lead Intel <onboarding@resend.dev>",
      to: NOTIFY_EMAIL,
      subject: `🔥 New Lead: ${name} (${business_type})`,
      html: `
        <div style="font-family:sans-serif;max-width:500px;background:#0d1422;color:#f0f4ff;padding:28px;border-radius:10px;">
          <h2 style="color:#ff8c00;margin:0 0 16px;">New Inbound Lead!</h2>
          <p><strong>Name:</strong> ${name}</p>
          <p><strong>Phone:</strong> ${phone}</p>
          <p><strong>Business:</strong> ${business_type}</p>
          <p style="margin-top:16px;color:rgba(240,244,255,0.6);">AI is texting them now. Check your Twilio inbox to monitor the conversation.</p>
        </div>
      `,
    });
  } catch (err) {
    console.log("EMAIL ERROR:", err.message);
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

  // Get welcome message from AI front desk
  const welcomeMsg = await getWelcomeMessage(leadData);

  // Send it
  const sent = await sendSMS(normalizedPhone, welcomeMsg);

  // Notify you
  await notifyOwner({ name, phone: normalizedPhone, business_type });

  return res.status(200).json({
    success: true,
    message: "Lead captured — AI texted them",
    sent,
  });
}
