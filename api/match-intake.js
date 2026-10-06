// api/match-intake.js — homeowner intake for /match
//
// A homeowner says what's broken; this gets it onto Andrew's phone in seconds.
//
// DELIBERATELY DOES NOT TOUCH SUPABASE. Every Supabase project on this account
// is paused (free tier pauses after ~7 days idle), so a write would throw
// ENOTFOUND and a lead would evaporate. ntfy needs no credentials at all and
// is therefore the one channel that cannot be dead, which is why it is primary.
//
// The response reports WHICH channels landed. That is not debug noise -- a 200
// with a friendly "thanks, we'll be in touch" while all three alerts failed is
// how this exact codebase hid a dead database for a month. If nothing lands we
// return 502 and the page tells the homeowner so, because a silently dropped
// lead is worse than an error message.

import { parseNotifyTo } from "../lib/notify-to.js";

export const SERVICES = [
  "Plumbing",
  "Heating / Furnace",
  "Air conditioning",
  "Roofing",
  "Electrical",
  "Water heater",
  "Water damage / Mold",
  "Appliance repair",
  "Garage door",
  "Windows",
  "Gutters",
  "Siding",
  "Painting",
  "Drywall",
  "Flooring",
  "Concrete / Driveway",
  "Fencing",
  "Deck / Patio",
  "Tree removal",
  "Landscaping",
  "Pest control",
  "Chimney / Fireplace",
  "Locksmith",
  "Handyman / Odd jobs",
  "Something else",
];

export const URGENCIES = ["Emergency - today", "This week", "Next few weeks", "Just getting prices"];

const MAX = { name: 80, phone: 25, zip: 12, details: 600, referred_by: 80 };

export function normalizePhone(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
  if (digits.length === 10) return "+1" + digits;
  return "";
}

// Returns { ok: true, lead } or { ok: false, field, error }.
// Pure, so scripts/verify-match-intake.mjs can test every reject branch
// without a network or a deploy -- the handler's guards are otherwise
// unreachable from this machine, and an untestable guard is just a comment.
export function validate(body) {
  const b = body || {};

  // Honeypot. A real browser never fills a field it cannot see, so anything
  // here is a bot. Reported as ok so the bot gets a cheerful 200 and stops.
  if (String(b.website || "").trim()) return { ok: false, field: "website", error: "bot", silent: true };

  const name = String(b.name || "").trim();
  if (name.length < 2) return { ok: false, field: "name", error: "Please enter your name." };

  const phone = normalizePhone(b.phone);
  if (!phone) {
    return { ok: false, field: "phone", error: "That phone number doesn't look right — 10 digits please." };
  }

  const service = String(b.service || "").trim();
  if (!SERVICES.includes(service)) {
    // Never echo the submitted value back into the page. This string is
    // rendered as text by the client, but the habit is what keeps it safe.
    return { ok: false, field: "service", error: "Pick what you need help with." };
  }

  const zip = String(b.zip || "").trim();
  if (!/^\d{5}$/.test(zip)) return { ok: false, field: "zip", error: "Please enter your 5-digit ZIP code." };

  const urgency = String(b.urgency || "").trim();
  if (urgency && !URGENCIES.includes(urgency)) {
    return { ok: false, field: "urgency", error: "Pick a timeframe." };
  }

  for (const [k, limit] of Object.entries(MAX)) {
    if (String(b[k] || "").length > limit) {
      return { ok: false, field: k, error: `That's longer than we can accept (${limit} characters).` };
    }
  }

  return {
    ok: true,
    lead: {
      name,
      phone,
      service,
      zip,
      urgency: urgency || "Not specified",
      details: String(b.details || "").trim(),
      referred_by: String(b.referred_by || "").trim(),
      at: new Date().toISOString(),
    },
  };
}

export function summarize(lead) {
  const lines = [
    `${lead.service} - ${lead.zip}`,
    `${lead.name}  ${lead.phone}`,
    `When: ${lead.urgency}`,
  ];
  if (lead.details) lines.push(`"${lead.details}"`);
  if (lead.referred_by) lines.push(`Referred by: ${lead.referred_by}`);
  lines.push("", "CALL THEM BACK WITHIN 10 MINUTES. That is the whole product.");
  return lines.join("\n");
}

async function pushNtfy(lead) {
  const topic = process.env.NTFY_TOPIC || "mcr-leads-andrew-2025";
  const r = await fetch(`https://ntfy.sh/${topic}`, {
    method: "POST",
    headers: {
      Title: `${lead.service} job - ${lead.zip}`,
      Priority: lead.urgency.startsWith("Emergency") ? "urgent" : "high",
      Tags: "house,rotating_light",
      // Tapping the notification dials the homeowner. One tap, no copying.
      Click: `tel:${lead.phone}`,
    },
    body: summarize(lead),
  });
  if (!r.ok) throw new Error(`ntfy HTTP ${r.status}: ${(await r.text()).slice(0, 120)}`);
}

async function emailAndrew(lead) {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("RESEND_API_KEY not set");

  // Fall back rather than skip: with Supabase down the inbox is the only
  // durable copy of a lead, so "no valid recipient" must not mean "no record".
  const { to, rejected, usedFallback } = parseNotifyTo(
    process.env.NOTIFY_EMAIL,
    "andrew3333422@gmail.com"
  );
  if (to.length === 0) throw new Error("no valid recipient in NOTIFY_EMAIL and no usable fallback");

  const { Resend } = await import("resend");
  const resend = new Resend(key);
  const { error } = await resend.emails.send({
    from: "Home Match <hello@aileadintel.com>",
    to,
    replyTo: to[0],
    subject: `${lead.urgency.startsWith("Emergency") ? "EMERGENCY " : ""}${lead.service} - ${lead.zip} - ${lead.name}`,
    text: summarize(lead),
  });
  if (error) throw new Error(`resend: ${error.message || JSON.stringify(error)}`);

  // Partial delivery is not delivery. If NOTIFY_EMAIL held three addresses and
  // two were malformed, "email: ok" would hide that two inboxes never got it.
  if (rejected.length || usedFallback) {
    return {
      note:
        `sent to ${to.length}` +
        (rejected.length ? `, ${rejected.length} entr(ies) in NOTIFY_EMAIL are not valid addresses` : "") +
        (usedFallback ? ", used the hardcoded fallback because NOTIFY_EMAIL had nothing usable" : ""),
    };
  }
}

async function smsAndrew(lead) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_PHONE_NUMBER;
  const to = normalizePhone(process.env.NOTIFY_SMS_TO);
  if (!sid || !token || !from) throw new Error("Twilio credentials not set");
  if (!to) throw new Error("NOTIFY_SMS_TO not set (add your own mobile in Vercel to get a text too)");

  const { default: twilio } = await import("twilio");
  await twilio(sid, token).messages.create({ body: summarize(lead), from, to });
}

const CHANNELS = [
  ["push", pushNtfy],
  ["email", emailAndrew],
  ["sms", smsAndrew],
];

// The reason a channel failed has to travel in the RESPONSE. `vercel logs` on
// this project shows request lines only -- console.error is invisible from this
// machine -- so a log is a comment. But this is an anonymous public endpoint,
// so the reason gets scrubbed of anything that identifies a person or a secret
// first. Keep the shape of the error, lose the contents.
export function scrub(detail) {
  return String(detail || "unknown")
    .replace(/[\w.+-]+@[\w.-]+\.\w+/g, "<email>")
    .replace(/\+?\d[\d\s().-]{8,}\d/g, "<phone>")
    .replace(/\b(re_|SK|AC|sk_|sb_)[A-Za-z0-9_-]{6,}/g, "<key>")
    .slice(0, 180);
}

export default async function handler(req, res) {
  const allowed = ["https://aileadintel.com", "https://www.aileadintel.com", "https://ai-lead-intel.vercel.app"];
  if (allowed.includes(req.headers.origin)) {
    res.setHeader("Access-Control-Allow-Origin", req.headers.origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const v = validate(req.body);
  if (!v.ok) {
    if (v.silent) return res.status(200).json({ ok: true, delivered: ["push"] });
    return res.status(400).json({ error: v.error, field: v.field });
  }

  const results = await Promise.all(
    CHANNELS.map(async ([name, fn]) => {
      try {
        const out = await fn(v.lead);
        return { name, ok: true, note: out && out.note };
      } catch (e) {
        // Unwrap .cause -- undici's entire .message for a network failure is
        // the useless string "fetch failed", and throwing the real reason away
        // is what cost a month here before.
        let root = e;
        for (let i = 0; i < 5 && root && root.cause; i++) root = root.cause;
        const detail = [root?.code, root?.message || String(e)].filter(Boolean).join(": ");
        console.error(`MATCH-INTAKE ${name} FAILED:`, detail);
        return { name, ok: false, detail };
      }
    })
  );

  const delivered = results.filter((r) => r.ok).map((r) => (r.note ? `${r.name} (${r.note})` : r.name));
  const failed = results.filter((r) => !r.ok);

  // Log the lead itself last, so even a total alert failure leaves the details
  // somewhere a human could eventually dig them out of.
  console.log("MATCH-INTAKE LEAD:", JSON.stringify(v.lead), "delivered:", delivered.join(",") || "NONE");

  if (delivered.length === 0) {
    return res.status(502).json({
      error: "We couldn't get your request through. Please try again in a moment.",
      delivered,
      failed: failed.map((f) => `${f.name}: ${scrub(f.detail)}`),
    });
  }

  return res.status(200).json({
    ok: true,
    delivered,
    // Scrubbed reasons, so a half-broken notifier is diagnosable from one curl
    // instead of sitting unnoticed behind a cheerful 200.
    failed: failed.map((f) => `${f.name}: ${scrub(f.detail)}`),
  });
}
