// lib/dispatch.js — the pure half of the one-tap contractor blast.
//
// Everything here is a pure function so scripts/verify-dispatch.mjs can test
// every branch with no network, no Twilio and no deploy. The alternative is
// what bit this codebase before: a guard that is only "read carefully" is a
// guard that has never run, and `vercel logs` on this project shows request
// lines only, so a console.error is a comment.
//
// WHY THIS FILE EXISTS AT ALL: a lead lands, and Andrew has to send the same
// sentence to three plumbers. Done by hand that is three minutes of retyping
// per job, every job, forever, and it happens at the exact moment speed is the
// entire product (three contractors already sent that homeowner to voicemail
// today; being the first human to call back IS the thing being sold). So the
// fan-out is the one part of the loop worth automating first.

import { createHash } from "node:crypto";

// ---------------------------------------------------------------- phone ----
// One copy. match-intake.js has its own older copy of this; verify-dispatch
// asserts the two agree on a shared table of cases, so they cannot drift into
// disagreeing about whether a number is sendable.
export function normalizePhone(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
  if (digits.length === 10) return "+1" + digits;
  return "";
}

// A US number whose area code or exchange starts with 0 or 1 cannot be dialled.
// Twilio rejects these with a 400 and still counts the attempt, so catching
// them here keeps a typo from looking like "the blast half-failed".
export function isSendable(e164) {
  return /^\+1[2-9]\d{2}[2-9]\d{6}$/.test(String(e164 || ""));
}

// ----------------------------------------------------------------- auth ----
// These endpoints spend real money and can get a sending number blocked, so an
// unauthenticated one is an open SMS relay. There is no DISPATCH_KEY env var on
// purpose: setting one is a manual Vercel step, and the last manual Vercel step
// (NOTIFY_SMS_TO) has gone undone for weeks, which is exactly how a feature
// ships "done" and is dead. So the repo stores only the SHA-256 of the key.
// The key itself lives in one bookmarked URL and in localStorage on one phone,
// and never appears in git, in a log line, or in any response body.
export const KEY_HASH = "4e48ce21a85c522c067c81a1a9afb40d722d9ec156b0bc14a6ebb52bd0848dba";

export function keyOk(presented, expected = KEY_HASH) {
  const s = String(presented || "");
  // Length floor. HONEST NOTE: this adds no security. The digest comparison
  // below already rejects "" and every short string — a mutation test confirms
  // that deleting this line changes nothing observable. It stays only as a
  // cheap early-out. Do NOT read it as the thing protecting this endpoint; the
  // digest compare is. (A guard whose comment claims protection it does not
  // provide is how nobody ever checks the real one.)
  if (s.length < 16) return false;
  const got = createHash("sha256").update(s).digest("hex");
  // Length-equal strings, so a plain === leaks nothing useful here; the hash is
  // public anyway. Compared on the digest so the key is never held for long.
  return got.length === expected.length && got === expected;
}

// ----------------------------------------------------------- the message ---
// What the three contractors get. Deliberately does NOT contain the
// homeowner's name or number: "first to say yes gets it" only works if the
// losers cannot simply call them anyway. That is also the thing that makes the
// lead worth $75 instead of nothing.
//
// Deliberately does NOT say "vetted", "licensed" or "insured" about anybody —
// nobody has checked, and saying it is how you end up in a lawsuit. There is a
// test that fails if those words appear.
export function blastText({ service, zip, urgency, details, callbackPhone, firstTime }) {
  const bits = [`${service} job — ${zip}.`];
  if (urgency && !/not specified/i.test(urgency)) bits.push(urgency + ".");
  const d = String(details || "").trim();
  if (d) bits.push(`"${d.length > 120 ? d.slice(0, 117) + "..." : d}"`);
  bits.push(`First to reply YES gets the homeowner's number.`);
  if (callbackPhone) bits.push(`— Andrew, ${pretty(callbackPhone)}`);
  // Opt-out language only on a contractor's first message. Carriers want it
  // present; repeating it on every job wastes a segment and reads like spam.
  if (firstTime) bits.push("Reply STOP to opt out.");
  return bits.join(" ");
}

// What the winning contractor gets once Andrew hands the job over.
export function handoffText({ name, phone, service, zip, details, callbackPhone }) {
  const bits = [
    `It's yours — ${service}, ${zip}.`,
    `${name}: ${pretty(phone)}.`,
  ];
  const d = String(details || "").trim();
  if (d) bits.push(`"${d.length > 120 ? d.slice(0, 117) + "..." : d}"`);
  bits.push("Please call them in the next 20 minutes.");
  if (callbackPhone) bits.push(`Any problems, ${pretty(callbackPhone)}.`);
  return bits.join(" ");
}

// What the homeowner gets, so the contractor's call isn't from a stranger.
export function homeownerText({ company, callbackPhone }) {
  const bits = [
    `${company} is calling you in the next 20 minutes about the job.`,
    `If they don't, text me and I'll get someone else.`,
  ];
  if (callbackPhone) bits.push(`— Andrew, ${pretty(callbackPhone)}`);
  return bits.join(" ");
}

export function pretty(e164) {
  const d = String(e164 || "").replace(/\D/g, "");
  const t = d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
  if (t.length !== 10) return String(e164 || "");
  return `(${t.slice(0, 3)}) ${t.slice(3, 6)}-${t.slice(6)}`;
}

// ------------------------------------------------------------ recipients ---
// Dedupe by NUMBER, never by name. One contractor is on the bench twice under
// "Mike" and "Mike's Plumbing" the moment a bench is edited by a human, and
// sending the same job twice to one phone is how a bench gets a STOP.
export function prepareRecipients(list, { max = 6 } = {}) {
  const out = [];
  const rejected = [];
  const seen = new Set();
  for (const c of Array.isArray(list) ? list : []) {
    const name = String(c?.name || "").trim();
    const e164 = normalizePhone(c?.phone);
    if (!isSendable(e164)) {
      rejected.push({ name: name || String(c?.phone || "?"), reason: "not a dialable US mobile" });
      continue;
    }
    if (seen.has(e164)) {
      rejected.push({ name: name || e164, reason: "same number already on this blast" });
      continue;
    }
    seen.add(e164);
    out.push({ name: name || pretty(e164), phone: e164, firstTime: !!c?.firstTime });
    if (out.length >= max) break;
  }
  return { recipients: out, rejected };
}

// ---------------------------------------------------------- lead parsing ---
// Reads back the exact string api/match-intake.js `summarize()` pushes to ntfy.
// verify-dispatch.mjs builds its fixtures by IMPORTING that summarize(), not by
// pasting a copy of its output, so if the notification format ever changes the
// test fails instead of the dispatch page silently showing an empty lead.
export function parseLead(message, title = "", meta = {}) {
  const text = String(message || "");
  const lines = text.split("\n").map((l) => l.trim());

  const head = (lines[0] || "").split(" - ");
  const service = (head[0] || "").trim();
  const zip = (head[1] || "").trim();

  let name = "";
  let phone = "";
  // "Name  +13035550134" — two spaces, and a name can itself contain spaces.
  const m = (lines[1] || "").match(/^(.*?)\s{2,}(\+?\d[\d\s().-]{7,})$/);
  if (m) {
    name = m[1].trim();
    phone = normalizePhone(m[2]);
  }

  const when = (lines.find((l) => l.startsWith("When:")) || "").replace("When:", "").trim();
  const ref = (lines.find((l) => l.startsWith("Referred by:")) || "").replace("Referred by:", "").trim();
  const details = (lines.find((l) => /^".*"$/.test(l)) || "").replace(/^"|"$/g, "").trim();

  // A lead with no callable number is not a lead. Say so rather than render a
  // dead card that looks actionable.
  const usable = !!(service && phone);
  return {
    id: meta.id || "",
    at: meta.time ? meta.time * 1000 : 0,
    service, zip, name, phone,
    urgency: when,
    details,
    referred_by: ref,
    emergency: /emergency/i.test(when) || /emergency/i.test(title),
    usable,
  };
}

// A health alert is not a job. The same ntfy topic carries both, and showing
// "AI Lead Intel health alert" as a dispatchable lead is the kind of thing that
// makes a tool get closed and never reopened.
export function isLeadNotification(n) {
  const title = String(n?.title || "");
  const msg = String(n?.message || "");
  if (n?.event && n.event !== "message") return false;
  if (/health (alert|check)/i.test(title) || /health check/i.test(msg)) return false;
  return /\bjob\b/i.test(title) || /CALL THEM BACK WITHIN 10 MINUTES/.test(msg);
}
