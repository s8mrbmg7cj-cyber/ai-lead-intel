// /lib/review-requests.js
//
// Shared helpers for the Google Review Request add-on. Used by:
//   api/review-request-create.js   (business marks a job complete)
//   api/review-request-send.js     (cron — sends the due texts)
//   api/review-click.js            (click tracking redirect)
//   api/review-settings.js         (dashboard settings + counts)
//   api/twilio-webhook.js          (STOP / HELP handling)
//
// House rules followed here: plain fetch against the Supabase REST API (no
// supabase-js), plain fetch against Twilio's form-encoded Messages endpoint,
// ntfy for push. No new dependencies.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY (or SUPABASE_SECRET_KEY),
//      TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER (fallback
//      sender), NTFY_TOPIC (fallback push topic), PUBLIC_BASE_URL (optional).

import { randomBytes } from 'node:crypto';

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY || '';

export const BASE_URL = (process.env.PUBLIC_BASE_URL || 'https://aileadintel.com').replace(/\/$/, '');

// A concatenated GSM-7 message carries 153 characters per segment, so 306 is
// the largest a 2-segment text can be. 320 looks like a rounder number but
// spills into a third segment — 50% more cost for a couple of characters of a
// long business name.
export const MAX_SMS_CHARS = 306;

// ─────────────────────────────────────────────
// SUPABASE REST
// ─────────────────────────────────────────────

/**
 * Minimal PostgREST helper. Mirrors the `sb()` pattern in api/twilio-webhook.js.
 * Throws on non-2xx so callers can decide whether to swallow or surface.
 */
export async function sb(path, { method = 'GET', body, prefer } = {}) {
  if (!SUPABASE_URL || !SERVICE_KEY) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY env var (check Vercel + Redeploy)');
  }
  const headers = {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json',
  };
  if (prefer) headers.Prefer = prefer;
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!resp.ok) throw new Error(`Supabase REST ${resp.status}: ${await resp.text()}`);
  const txt = await resp.text();
  return txt ? JSON.parse(txt) : null;
}

/**
 * Exact row count for a filter, without downloading the rows.
 *
 * Counting the length of a capped SELECT is wrong the moment an account passes
 * that cap — the dashboard would just quietly stop counting. PostgREST returns
 * the true total in the Content-Range header ("0-24/1337") when asked with
 * Prefer: count=exact, so this asks for zero rows and reads the header.
 */
export async function sbCount(path) {
  if (!SUPABASE_URL || !SERVICE_KEY) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY env var (check Vercel + Redeploy)');
  }
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'GET',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      Prefer: 'count=exact',
      Range: '0-0',
    },
  });
  if (!resp.ok) throw new Error(`Supabase REST ${resp.status}: ${await resp.text()}`);
  const total = String(resp.headers.get('content-range') || '').split('/')[1];
  const n = Number(total);
  return Number.isFinite(n) ? n : 0;
}

export const enc = (v) => encodeURIComponent(String(v == null ? '' : v));

// ─────────────────────────────────────────────
// PHONE VALIDATION (E.164, US/CA)
// ─────────────────────────────────────────────

/**
 * Strict E.164 normaliser for North American numbers. Returns '' when the
 * input can't be trusted — callers MUST treat '' as a hard validation failure
 * rather than trying to send anyway. Sending to a malformed number burns
 * deliverability and, on a 10DLC campaign, counts against us.
 */
export function toE164(raw) {
  const s = String(raw || '').trim();
  const digits = s.replace(/\D/g, '');

  let national;
  if (digits.length === 11 && digits.startsWith('1')) national = digits.slice(1);
  else if (digits.length === 10) national = digits;
  else return '';

  const areaCode = national.slice(0, 3);
  const exchange = national.slice(3, 6);

  // NANP rules: area code and exchange both start 2-9, and neither may be an
  // N11 service code (411, 911, ...). This rejects the bulk of typo'd numbers.
  if (!/^[2-9]/.test(areaCode) || !/^[2-9]/.test(exchange)) return '';
  if (/^[0-9]11$/.test(areaCode)) return '';

  return `+1${national}`;
}

/** Display-only formatter, matching formatPhone() in the dashboard. */
export function prettyPhone(num) {
  const m = String(num || '').match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : String(num || '');
}

// ─────────────────────────────────────────────
// REVIEW LINK VALIDATION
// ─────────────────────────────────────────────

/**
 * Only https links are allowed into an outbound SMS. Anything else (javascript:,
 * data:, http:) is rejected outright — this string ends up in a text message
 * and in a 302 Location header, so it is an open-redirect surface if unchecked.
 */
export function isValidReviewLink(raw) {
  const s = String(raw || '').trim();
  if (!s || s.length > 500) return false;
  try {
    const u = new URL(s);
    return u.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

/** Short, URL-safe, unguessable click token. 10 chars of base32-ish alphabet. */
export function makeClickToken() {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789'; // no l/o/0/1 — avoids read-aloud confusion
  const bytes = randomBytes(10);
  let out = '';
  for (let i = 0; i < 10; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

// ─────────────────────────────────────────────
// MESSAGE BUILDERS
// ─────────────────────────────────────────────
//
// EVERY outbound message must carry three things or the 10DLC campaign gets
// flagged: who is texting (business name), why (the review ask), and how to
// stop (STOP/HELP). Do not "simplify" these strings — they are the compliance
// surface, not copy.

const OPT_OUT_TAG = 'Reply STOP to opt out, HELP for help.';

// A single character outside the GSM-7 alphabet flips the WHOLE message to
// UCS-2, which cuts the segment size from 160 characters to 70 — so one curly
// apostrophe pasted into a business name can turn a 1-segment text into a
// 3-segment one and triple what every send costs. Business names are typed and
// pasted by users, so they are normalised rather than trusted.
const GSM_SUBSTITUTIONS = [
  [/[\u2018\u2019\u201B\u2032]/g, "'"],   // curly / prime apostrophes
  [/[\u201C\u201D\u201F\u2033]/g, '"'],   // curly quotes
  [/[\u2010-\u2015\u2212]/g, '-'],        // en/em dashes, minus
  [/\u2026/g, '...'],                     // ellipsis
  [/\u00A0/g, ' '],                       // non-breaking space
  [/[\u2022\u00B7]/g, '-'],               // bullets
  [/\u2122/g, '(TM)'],
  [/\u00AE/g, '(R)'],
];

// Every character GSM-7 can represent. Accented letters that ARE in here
// (é, ñ, ü, à, ö…) are deliberately preserved — only the ones that aren't get
// folded, so "José" stays intact while "Zoë" becomes "Zoe" rather than
// tripling the cost of the message.
const GSM_ALPHABET = new Set(
  ("@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡" +
   "ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà" +
   "^{}\\[~]|€").split('')
);

export function toGsmSafe(str) {
  let s = String(str == null ? '' : str);
  for (const [re, to] of GSM_SUBSTITUTIONS) s = s.replace(re, to);

  // Fold any remaining out-of-alphabet letter to its unaccented base (NFD
  // splits "ë" into "e" + combining diaeresis, which we then drop). Anything
  // still unrepresentable after that is removed outright.
  return [...s].map((ch) => {
    if (GSM_ALPHABET.has(ch)) return ch;
    const folded = ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    return [...folded].every((c) => GSM_ALPHABET.has(c)) ? folded : '';
  }).join('');
}

/** Trims a business name so the finished message always fits MAX_SMS_CHARS. */
function fitBusinessName(name, budget) {
  const s = toGsmSafe(name).trim() || 'our team';
  if (s.length <= budget) return s;
  // '...' rather than '…' — the ellipsis character is not in GSM-7.
  return s.slice(0, Math.max(1, budget - 3)).trim() + '...';
}

/**
 * First ask, sent `review_delay_hours` after the job is marked complete.
 * @param {{businessName: string, customerName?: string, link: string}} o
 */
export function buildReviewMessage({ businessName, customerName, link }) {
  const first = toGsmSafe(customerName).trim().split(/\s+/)[0] || '';
  const greeting = first ? `Hi ${first}, ` : '';
  // Budget = cap minus everything that isn't the business name.
  const fixed = `${greeting}thanks for choosing ! If we did a good job, would you mind leaving a quick Google review? ${link} ${OPT_OUT_TAG}`;
  const biz = fitBusinessName(businessName, MAX_SMS_CHARS - fixed.length);
  return `${greeting}thanks for choosing ${biz}! If we did a good job, would you mind leaving a quick Google review? ${link} ${OPT_OUT_TAG}`;
}

/**
 * The single, optional follow-up. Deliberately softer and explicitly final —
 * "last time we'll ask" is both good manners and good compliance evidence.
 */
export function buildFollowUpMessage({ businessName, customerName, link }) {
  const first = toGsmSafe(customerName).trim().split(/\s+/)[0] || '';
  const greeting = first ? `Hi ${first}, ` : '';
  // Plain hyphen, not an em dash: an em dash is outside GSM-7 and would force
  // the whole message to UCS-2 (70-char segments instead of 160).
  const fixed = `${greeting}just one quick nudge from  - a Google review really helps us out. Last time we'll ask! ${link} ${OPT_OUT_TAG}`;
  const biz = fitBusinessName(businessName, MAX_SMS_CHARS - fixed.length);
  return `${greeting}just one quick nudge from ${biz} - a Google review really helps us out. Last time we'll ask! ${link} ${OPT_OUT_TAG}`;
}

export function buildStopConfirmation(businessName) {
  const biz = fitBusinessName(businessName, 60);
  return `You're unsubscribed from ${biz} review requests and won't receive any more messages. Reply HELP for help.`;
}

export function buildHelpMessage(businessName) {
  const biz = fitBusinessName(businessName, 60);
  return `${biz} review requests, powered by AI Lead Intel. For help email hello@aileadintel.com. Msg&data rates may apply. Reply STOP to opt out.`;
}

// Carrier-standard keywords.
const STOP_WORDS = ['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'revoke', 'optout', 'opt-out'];
const HELP_WORDS = ['help', 'info'];

// Words that may accompany a keyword without changing its meaning, so that
// "stop please" and "unsubscribe me" still count.
const FILLER_WORDS = ['please', 'me', 'all', 'now', 'this', 'these', 'texts', 'text', 'texting',
  'messages', 'message', 'msgs', 'msg', 'thanks', 'thank', 'you', 'to', 'the', 'my', 'from', 'and'];

/**
 * Returns 'stop', 'help', or null.
 *
 * The keyword must be essentially the ENTIRE message — not merely present in
 * it. This matters: an HVAC customer texting "need help with my furnace" is a
 * lead, not a HELP request, and intercepting it would swallow the reply and
 * never log the lead. Same for "I want to cancel my appointment", which is an
 * appointment change, not an opt-out.
 *
 * This is not a compliance gap. Twilio's Advanced Opt-Out sits in front of us
 * and enforces the strict carrier standard (bare keyword) at the network
 * level; this function only decides whether WE also reply and write the
 * ledger. The carrier standard requires the bare keyword to work, which it
 * still does.
 */
export function classifyInbound(body) {
  const words = String(body || '').toLowerCase().replace(/[^a-z\s-]/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;

  const isKeywordMessage = (keywords) => {
    const hit = words.some((w) => keywords.includes(w));
    if (!hit) return false;
    // Every remaining word must be a keyword or harmless filler.
    return words.every((w) => keywords.includes(w) || FILLER_WORDS.includes(w));
  };

  if (isKeywordMessage(STOP_WORDS)) return 'stop';
  if (isKeywordMessage(HELP_WORDS)) return 'help';
  return null;
}

// ─────────────────────────────────────────────
// OPT-OUT LEDGER
// ─────────────────────────────────────────────

/**
 * True when this phone has opted out for this client. Checked immediately
 * before every send — the ledger is the last line of defence, so a failure to
 * read it must block the send rather than let it through.
 */
export async function isOptedOut(phone, clientId) {
  const rows = await sb(
    `sms_opt_outs?select=phone&phone=eq.${enc(phone)}&client_id=eq.${enc(clientId)}&limit=1`
  );
  return Array.isArray(rows) && rows.length > 0;
}

/** Records an opt-out and cancels every queued request for that number. */
export async function recordOptOut({ phone, clientId, source }) {
  await sb('sms_opt_outs?on_conflict=phone,client_id', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=minimal',
    body: { phone, client_id: clientId, source: source || 'sms_stop', opted_out_at: new Date().toISOString() },
  });

  const now = new Date().toISOString();

  // Kill anything NOT yet delivered so the cron can never pick it up later.
  // 'sent' is deliberately excluded: that message already went out, and
  // rewriting its status would erase the delivery record we may need as
  // evidence, and would corrupt the weekly summary counts.
  await sb(
    `review_requests?customer_phone=eq.${enc(phone)}&client_id=eq.${enc(clientId)}&status=in.(pending,sending)`,
    { method: 'PATCH', prefer: 'return=minimal', body: { status: 'opted_out', opted_out_at: now } }
  );

  // Already-sent rows keep their status but are stamped so they can never
  // qualify for a follow-up. follow_up_sent_at IS the follow-up lock, so this
  // closes the queue without destroying history. (sendDueFollowUps also
  // re-checks the ledger, but belt-and-braces: the row should never even be a
  // candidate again.)
  await sb(
    `review_requests?customer_phone=eq.${enc(phone)}&client_id=eq.${enc(clientId)}` +
    `&status=in.(sent,clicked)&follow_up_sent_at=is.null`,
    { method: 'PATCH', prefer: 'return=minimal', body: { follow_up_sent_at: now, opted_out_at: now } }
  );
}

// ─────────────────────────────────────────────
// TWILIO SEND
// ─────────────────────────────────────────────

/**
 * Sends one SMS over Twilio's REST API, form-encoded, exactly like the lead
 * alert in api/vapi/call-ended.js. Returns { ok, sid, error } — never throws,
 * because a single bad number must not abort a whole cron batch.
 */
export async function sendSms({ to, from, body }) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token || !from) {
    return { ok: false, sid: null, error: 'twilio_not_configured' };
  }
  try {
    const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: to, From: from, Body: body }),
    });
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return { ok: false, sid: null, error: `twilio_${resp.status}: ${json.message || 'send failed'}` };
    }
    return { ok: true, sid: json.sid || null, error: null };
  } catch (err) {
    return { ok: false, sid: null, error: String(err.message || err).slice(0, 200) };
  }
}

/** The number a client's review texts go out from. Their own AI line first. */
export function senderFor(client) {
  return toE164(client?.twilio_number || process.env.TWILIO_PHONE_NUMBER || '');
}

// ─────────────────────────────────────────────
// ERROR REPORTING
// ─────────────────────────────────────────────

/**
 * Server-side twin of api/report-error.js: push to ntfy, then log to error_log.
 * Best-effort by design — reporting a failure must never cause a second one.
 */
export async function reportError({ action, error, clientSlug }) {
  const message = String(error && error.message ? error.message : error || 'unknown').slice(0, 500);
  console.error(`[review-requests] ${action}:`, message);

  const topic = process.env.NTFY_TOPIC;
  if (topic) {
    try {
      await fetch('https://ntfy.sh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topic,
          title: 'Review requests — error',
          message: `Action: ${action}\nError: ${message}${clientSlug ? `\nCustomer: ${clientSlug}` : ''}`,
          priority: 4,
          tags: ['warning'],
        }),
      });
    } catch (_) {}
  }

  try {
    await sb('error_log', {
      method: 'POST',
      prefer: 'return=minimal',
      body: {
        page: 'api/review-requests',
        action: String(action || '').slice(0, 100),
        error_message: message,
        client_slug: clientSlug || null,
      },
    });
  } catch (_) {}
}
