// api/sms-reply.js
// POST /api/sms-reply
// Twilio calls this when a lead replies to our SMS
// AI front desk picks up the conversation and responds

import { getAIResponse, isBooked } from "../lib/frontdesk.js";

// Shared conversation store (in production, use Supabase)
// Key = phone number, Value = array of {role, content} messages
const conversations = global._conversations || new Map();
global._conversations = conversations;

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
    console.log("SMS MOCK reply to", to, ":", body);
    return;
  }

  const { default: twilio } = await import("twilio");
  const client = twilio(accountSid, authToken);
  await client.messages.create({ body, from, to });
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "text/xml");
  if (req.method !== "POST") return res.status(405).send("<Response></Response>");

  const from    = normalizePhone(req.body?.From || "");
  const message = req.body?.Body || "";
  const toNum   = req.body?.To || process.env.TWILIO_PHONE_NUMBER || "";

  console.log("SMS REPLY from", from, ":", message);

  // Get or create conversation history for this number
  if (!conversations.has(from)) {
    conversations.set(from, []);
  }
  const history = conversations.get(from);

  // Add the customer's message to history
  history.push({ role: "user", content: message });

  // Get AI response
  const aiReply = await getAIResponse({
    conversationHistory: history.slice(0, -1), // history before this message
    newMessage: message,
    businessName: process.env.BUSINESS_NAME || "our business",
    businessType: process.env.BUSINESS_TYPE || "service business",
  });

  // Add AI response to history
  history.push({ role: "assistant", content: aiReply });
  conversations.set(from, history);

  // Check if lead is booked
  if (isBooked(history)) {
    console.log("LEAD BOOKED:", from);
    // In production: update Supabase lead status, notify owner
  }

  // Send SMS reply (Twilio REST API — more reliable than TwiML for conversations)
  await sendSMS(from, aiReply);

  // Return empty TwiML (we already sent the reply via REST API above)
  return res.status(200).send("<Response></Response>");
}
