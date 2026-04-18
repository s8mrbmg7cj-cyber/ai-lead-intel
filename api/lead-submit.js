// api/lead-submit.js
// POST /api/lead-submit
// Called when someone fills out the landing page form
// Saves lead, sends immediate SMS, starts AI front desk conversation

import { getAIResponse } from "../lib/frontdesk.js";

function normalizePhone(raw) {
  if (!raw) return "";
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
  if (digits.length === 10) return "+1" + digits;
  return "+" + digits;
}

// In-memory store for conversations (use Supabase/Redis in production)
const conversations = new Map();
const leads = new Map();

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).json({ ok: true });
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { name, phone, business_type } = req.body || {};

  if (!name || !phone) {
    return res.status(400).json({ error: "Name and phone required" });
  }

  const normalizedPhone = normalizePhone(phone);
  const leadId = Date.now().toString();
  const timestamp = new Date().toISOString();

  // Save lead
  const lead = { id: leadId, name, phone: normalizedPhone, business_type, timestamp, status: "new" };
  leads.set(leadId, lead);
  conversations.set(normalizedPhone, []);

  console.log("LEAD SUBMITTED:", name, normalizedPhone, business_type);

  // Send immediate SMS via Twilio
  const immediateMsg = "Hey " + name + "! Thanks for reaching out. I'm your AI assistant — what can I help you with today?";
  
  const smsSent = await sendSMS(normalizedPhone, immediateMsg);

  // Store first AI message in conversation
  if (smsSent) {
    conversations.set(normalizedPhone, [
      { role: "assistant", content: immediateMsg }
    ]);
  }

  // Email notification to owner
  await notifyOwner({ name, phone: normalizedPhone, business_type });

  return res.status(200).json({
    success: true,
    lead_id: leadId,
    message: "Lead captured and initial SMS sent",
  });
}

async function sendSMS(to, body) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;
  const from       = process.env.TWILIO_PHONE_NUMBER;

  if (!accountSid || !authToken || !from) {
    console.log("SMS MOCK: would send to", to, ":", body);
    return true; // Mock success for testing
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
      subject: "New Lead: " + name + " (" + business_type + ")",
      html: "<p><strong>Name:</strong> " + name + "</p><p><strong>Phone:</strong> " + phone + "</p><p><strong>Business type:</strong> " + business_type + "</p>",
    });
  } catch (err) {
    console.log("EMAIL ERROR:", err.message);
  }
}

// Export for use in sms-reply handler
export { conversations, leads, sendSMS };
