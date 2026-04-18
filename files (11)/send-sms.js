// api/send-sms.js
// POST /api/send-sms
// Manual SMS send — used by dashboard to send outreach messages

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).json({ ok: true });
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { to, message } = req.body || {};
  if (!to || !message) return res.status(400).json({ error: "to and message required" });

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;
  const from       = process.env.TWILIO_PHONE_NUMBER;

  // Mock mode — no Twilio configured
  if (!accountSid || !authToken || !from) {
    console.log("SMS MOCK: to=" + to + " msg=" + message);
    return res.status(200).json({ success: true, mock: true, to, message });
  }

  try {
    const { default: twilio } = await import("twilio");
    const client = twilio(accountSid, authToken);
    const result = await client.messages.create({ body: message, from, to });
    console.log("SMS SENT:", result.sid);
    return res.status(200).json({ success: true, sid: result.sid });
  } catch (err) {
    console.log("SMS ERROR:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
