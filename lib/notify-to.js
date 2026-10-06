// lib/notify-to.js — turn NOTIFY_EMAIL into something Resend will accept.
//
// MEASURED 2026-10-06: the first live submission to /api/match-intake got
//
//   "resend: Invalid `to` field. The email address needs to follow the
//    `<email>` or `Name <<email>>` format."
//
// NOTIFY_EMAIL is set in Vercel, so every `process.env.NOTIFY_EMAIL || default`
// in this repo takes the env branch and then fails -- the default never runs.
// Resend v3 wants an ARRAY for multiple recipients; a comma-joined string is
// rejected outright. api/vapi/call-ended.js already splits on "," so the list
// shape is expected somewhere, while ten other senders pass the raw string.
// Each of those catches the error and logs it, and console.error is invisible
// from this machine, so owner alerts have been failing in silence.
//
// This is the one place that parses it. Returns both what it accepted and what
// it threw away, because "sent" with half the recipients silently dropped is
// the same lie as "sent" with none.

const EMAIL = /^[^\s@,<>]+@[^\s@,<>]+\.[A-Za-z]{2,}$/;

export function parseNotifyTo(raw, fallback = "") {
  const parts = String(raw ?? "")
    .split(/[,;]/)
    .map((s) =>
      s
        .trim()
        // Strip a surrounding quote or a "Name <addr>" wrapper -- both are
        // things a human typing into a Vercel env field actually does.
        .replace(/^["']|["']$/g, "")
        .replace(/^.*<([^>]+)>.*$/, "$1")
        .trim()
    )
    .filter(Boolean);

  const seen = new Set();
  const to = [];
  const rejected = [];
  for (const p of parts) {
    if (!EMAIL.test(p)) { rejected.push(p); continue; }
    const k = p.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    to.push(p);
  }

  let usedFallback = false;
  if (to.length === 0 && fallback && EMAIL.test(fallback)) {
    to.push(fallback);
    usedFallback = true;
  }

  return { to, rejected, usedFallback, candidates: parts.length };
}
