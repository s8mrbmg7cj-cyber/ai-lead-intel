// api/sms-reply.js — v2
// Twilio calls this when a lead replies to any SMS
// AI front desk picks up and keeps conversation going

import { getAIResponse, isConverted } from "../lib/frontdesk.js";

function normalizePhone(raw) {
  if (!raw) return "";
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
  if (digits.length === 10) return "+1" + digits;
  return "+" + digits;
}

async function sendSMS(to, body, from) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;

  if (!accountSid || !authToken) {
    console.log("SMS MOCK reply to", to, ":", body);
    return;
  }

  try {
    const { default: twilio } = await import("twilio");
    const client = twilio(accountSid, authToken);
    await client.messages.create({ body, from, to });
  } catch (err) {
    console.log("SMS REPLY ERROR:", err.message);
  }
}

// Store lead data for context (in production use Supabase)
const leadStore = global._leadStore || new Map();
global._leadStore = leadStore;

export default async function handler(req, res) {
  res.setHeader("Content-Type", "text/xml");
  if (req.method !== "POST") return res.status(405).send("<Response></Response>");

  const from   = normalizePhone(req.body?.From || "");
  const to     = req.body?.To || process.env.TWILIO_PHONE_NUMBER || "";
  const message = req.body?.Body || "";

  console.log("SMS REPLY from", from, ":", message);

  // Get lead data if we have it
  const leadData = leadStore.get(from) || {};

  // Get AI response
  const aiReply = await getAIResponse({
    phone: from,
    message,
    leadData,
  });

  // Send reply
  await sendSMS(from, aiReply, to);

  // Check if converted
  if (isConverted(from)) {
    console.log("LEAD CONVERTED:", from, "— payment link sent");
  }

  // Return empty TwiML (already sent via REST API)
  return res.status(200).send("<Response></Response>");
}

// Export leadStore so lead-submit can save lead data
export { leadStore };
