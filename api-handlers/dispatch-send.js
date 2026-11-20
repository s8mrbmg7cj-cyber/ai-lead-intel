// api/dispatch-send.js — the one tap that texts every contractor at once.
//
// This is the only endpoint in the repo that spends money on Andrew's behalf
// without a human reading each message first, so the rules are tighter:
//
//  1. Key-gated. An open SMS relay bills him and gets the number blocked.
//  2. Rate limited per key, not per IP — a phone roams between IPs and a
//     stuck retry loop would otherwise bill once per cell tower.
//  3. Hard cap of 6 recipients, enforced in lib/dispatch.js, tested.
//  4. PER-RECIPIENT results. "Sent" when two of three silently failed is the
//     same lie as "sent" when none did, and it is the exact failure this
//     codebase hid for a month behind a cheerful 200.
//
// Twilio is ALREADY live in production: a probe of /api/match-intake returned
// `sms: NOTIFY_SMS_TO not set`, which is the recipient missing, not the
// credentials. So this needs nothing added in Vercel to work.

import { rateLimit } from "../lib/rate-limit.js";
import {
  keyOk, prepareRecipients, blastText, handoffText, homeownerText,
  normalizePhone, isSendable,
} from "../lib/dispatch.js";

async function twilioClient() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_PHONE_NUMBER;
  if (!sid || !token || !from) {
    throw new Error("Twilio is not configured in this environment (SID / token / from number)");
  }
  const { default: twilio } = await import("twilio");
  return { client: twilio(sid, token), from };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const key = req.headers["x-dispatch-key"] || req.body?.k || "";
  if (!keyOk(key)) return res.status(401).json({ error: "bad or missing key" });

  const body = req.body || {};

  // 12 real sends per 10 minutes. A busy evening is 1-2 blasts; 12 never blocks
  // real work but caps what a stuck retry loop can cost. Previews are exempt —
  // every blast asks for one, so counting them would halve the real budget and
  // Andrew would hit a 429 on a night that was actually going well.
  if (body.dryRun !== true) {
    const limit = rateLimit("dispatch:send", 12, 600);
    if (!limit.ok) {
      res.setHeader("Retry-After", limit.retryAfter);
      return res.status(429).json({ error: "Too many sends in a row — wait a minute.", retryAfter: limit.retryAfter });
    }
  }
  const mode = String(body.mode || "blast");
  const lead = body.lead || {};
  const callbackPhone = normalizePhone(body.callbackPhone);

  let targets;
  let buildMessage;

  if (mode === "blast") {
    const prep = prepareRecipients(body.contractors);
    if (prep.recipients.length === 0) {
      return res.status(400).json({
        error: "No contractor on that list has a usable mobile number.",
        rejected: prep.rejected,
      });
    }
    targets = prep;
    // Note what is NOT passed: the homeowner's name and number. The race rule
    // only works if the losers cannot call them anyway, and that is also what
    // makes the lead worth $75. verify-dispatch asserts the stripping.
    buildMessage = (r) => blastText({
      service: lead.service, zip: lead.zip, urgency: lead.urgency,
      details: lead.details, callbackPhone, firstTime: r.firstTime,
    });
  } else if (mode === "handoff") {
    // The winner gets the homeowner. One recipient, deliberately.
    const prep = prepareRecipients([body.winner], { max: 1 });
    if (prep.recipients.length === 0) {
      return res.status(400).json({ error: "That contractor has no usable mobile number.", rejected: prep.rejected });
    }
    if (!isSendable(normalizePhone(lead.phone))) {
      return res.status(400).json({ error: "This lead has no callable homeowner number, so there is nothing to hand over." });
    }
    targets = prep;
    buildMessage = () => handoffText({
      name: lead.name, phone: normalizePhone(lead.phone), service: lead.service,
      zip: lead.zip, details: lead.details, callbackPhone,
    });
  } else if (mode === "notify-homeowner") {
    const prep = prepareRecipients([{ name: lead.name, phone: lead.phone }], { max: 1 });
    if (prep.recipients.length === 0) {
      return res.status(400).json({ error: "This lead has no callable homeowner number.", rejected: prep.rejected });
    }
    const company = String(body.company || "").trim();
    if (!company) return res.status(400).json({ error: "Say which company is calling them." });
    targets = prep;
    buildMessage = () => homeownerText({ company, callbackPhone });
  } else {
    return res.status(400).json({ error: `Unknown mode "${mode}"` });
  }

  // DRY RUN. The page asks for the exact text before showing the confirm sheet,
  // so that what Andrew approves is the real message rather than a second copy
  // built in the browser that could drift from this one. This MUST return
  // before Twilio is touched: an ignored dryRun flag would send every blast
  // twice and bill for both.
  if (body.dryRun === true) {
    return res.status(200).json({
      ok: true, dryRun: true, mode,
      preview: buildMessage(targets.recipients[0]),
      would_send_to: targets.recipients.map((r) => ({ name: r.name, phone: r.phone })),
      rejected: targets.rejected,
      sent: 0, failed: 0, results: [],
    });
  }

  let client, from;
  try {
    ({ client, from } = await twilioClient());
  } catch (e) {
    return res.status(503).json({ error: "Texting is not configured on the server.", detail: String(e.message || e) });
  }

  // Send in parallel; the point of the feature is that all three land at the
  // same second rather than over ninety seconds of thumb-typing.
  const results = await Promise.all(targets.recipients.map(async (r) => {
    const text = buildMessage(r);
    try {
      const msg = await client.messages.create({ body: text, from, to: r.phone });
      return { name: r.name, phone: r.phone, ok: true, sid: msg.sid, chars: text.length };
    } catch (e) {
      let root = e;
      for (let i = 0; i < 5 && root && root.cause; i++) root = root.cause;
      // Twilio's own codes are the useful part (21610 = that number replied
      // STOP, 21614 = landline). Pass them through so the page can say which.
      return {
        name: r.name, phone: r.phone, ok: false,
        code: root?.code ?? e?.code ?? null,
        detail: String(root?.message || e?.message || e).slice(0, 180),
      };
    }
  }));

  const sent = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);

  // A blast where every single message failed is NOT a success, and must not
  // return 200 — a cheerful 200 over a dead channel is how this exact codebase
  // hid a broken notifier for a month.
  const status = sent.length === 0 ? 502 : 200;

  return res.status(status).json({
    ok: sent.length > 0,
    mode,
    sent: sent.length,
    failed: failed.length,
    results,
    rejected: targets.rejected,
    preview: buildMessage(targets.recipients[0]),
  });
}
