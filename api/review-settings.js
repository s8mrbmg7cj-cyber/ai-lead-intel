// api/review-settings.js
//
// Backs the "Google Reviews" panel in the customer dashboard.
//   GET  ?client_slug=…  → current settings + sent/clicked/opted-out counts + recent rows
//   POST                 → save the Google review link, delay, and follow-up options
//
// Both require the signed-in owner of the client row. Reads go through the
// service key here rather than the browser's anon key so review_requests never
// needs a public RLS policy — end-customer phone numbers stay server-side, and
// the dashboard only ever sees the masked last-4.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY

import { rateLimit, getClientIp } from '../lib/rate-limit.js';
import { requireClientOwner } from '../lib/review-auth.js';
import { sb, sbCount, enc, isValidReviewLink, prettyPhone, reportError } from '../lib/review-requests.js';

const MAX_DELAY_HOURS = 168;
const RECENT_LIMIT = 15;

// `Number(x) || fallback` turns a legitimate saved 0 into the fallback, and
// `Number(null)` is 0 rather than NaN — so both the empty case and the zero
// case have to be tested explicitly.
function numOr(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function settingsOf(client) {
  return {
    enabled: client.review_requests_enabled === true,
    google_review_link: client.google_review_link || '',
    delay_hours: numOr(client.review_delay_hours, 2),
    follow_up_enabled: client.review_followup_enabled === true,
    follow_up_days: numOr(client.review_followup_days, 3),
  };
}

/** Last 4 digits only — the dashboard never needs the full customer number. */
function maskPhone(e164) {
  const d = String(e164 || '').replace(/\D/g, '');
  return d.length >= 4 ? `••• ${d.slice(-4)}` : '';
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (!['GET', 'POST'].includes(req.method)) {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ip = getClientIp(req);
  const limit = rateLimit(`review-settings:${ip}`, 120, 60 * 10);
  if (!limit.ok) {
    res.setHeader('Retry-After', String(limit.retryAfter));
    return res.status(429).json({ error: 'Too many requests' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  const clientSlug = req.method === 'GET'
    ? String(req.query?.client_slug || '')
    : String(body.client_slug || '');

  let client = null;
  try {
    const auth = await requireClientOwner(req, clientSlug);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
    client = auth.client;

    // ── SAVE ──
    if (req.method === 'POST') {
      const patch = {};

      if (body.google_review_link !== undefined) {
        const link = String(body.google_review_link || '').trim();
        if (link && !isValidReviewLink(link)) {
          return res.status(400).json({ error: 'That review link must be a full https:// web address.' });
        }
        patch.google_review_link = link || null;
      }

      if (body.delay_hours !== undefined) {
        const hours = Number(body.delay_hours);
        if (!Number.isFinite(hours) || hours < 0 || hours > MAX_DELAY_HOURS) {
          return res.status(400).json({ error: `Delay must be between 0 and ${MAX_DELAY_HOURS} hours.` });
        }
        patch.review_delay_hours = Math.round(hours);
      }

      if (body.follow_up_days !== undefined) {
        const days = Number(body.follow_up_days);
        if (!Number.isFinite(days) || days < 1 || days > 30) {
          return res.status(400).json({ error: 'Follow-up wait must be between 1 and 30 days.' });
        }
        patch.review_followup_days = Math.round(days);
      }

      if (body.follow_up_enabled !== undefined) {
        patch.review_followup_enabled = body.follow_up_enabled === true;
      }

      if (body.enabled !== undefined) {
        const turningOn = body.enabled === true;
        // Turning the feature on without a destination would queue texts that
        // can never send — refuse rather than create dead rows.
        const link = patch.google_review_link !== undefined
          ? patch.google_review_link
          : client.google_review_link;
        if (turningOn && !isValidReviewLink(link || '')) {
          return res.status(400).json({ error: 'Add your Google review link before turning review requests on.' });
        }
        patch.review_requests_enabled = turningOn;
      }

      if (Object.keys(patch).length === 0) {
        return res.status(400).json({ error: 'Nothing to save' });
      }

      const updated = await sb(`clients?id=eq.${enc(client.id)}`, {
        method: 'PATCH',
        prefer: 'return=representation',
        body: patch,
      });
      const row = Array.isArray(updated) ? updated[0] : updated;
      console.log('[review-settings] saved for', client.client_slug, Object.keys(patch).join(','));
      return res.status(200).json({ ok: true, settings: settingsOf(row || { ...client, ...patch }) });
    }

    // ── READ ──
    // Counts come from the database, not from the length of a capped page —
    // a client past the old limit=500 would have seen their totals silently
    // freeze. Only the short "recent" list is actually fetched.
    const base = `review_requests?client_id=eq.${enc(client.id)}`;
    const [total, pending, sentCount, clicked, optedOut, failed] = await Promise.all([
      sbCount(`${base}&select=id`),
      sbCount(`${base}&select=id&status=in.(pending,sending)`),
      sbCount(`${base}&select=id&status=in.(sent,clicked)`),
      sbCount(`${base}&select=id&clicked_at=not.is.null`),
      sbCount(`${base}&select=id&status=eq.opted_out`),
      sbCount(`${base}&select=id&status=eq.failed`),
    ]);

    const counts = { total, pending, sent: sentCount, clicked, opted_out: optedOut, failed };

    const rows = await sb(
      `review_requests?select=id,customer_name,customer_phone,status,scheduled_for,sent_at,clicked_at,follow_up_sent_at,created_at` +
      `&client_id=eq.${enc(client.id)}&order=created_at.desc&limit=${RECENT_LIMIT}`
    );
    const all = Array.isArray(rows) ? rows : [];

    const recent = all.slice(0, RECENT_LIMIT).map((r) => ({
      id: r.id,
      customer_name: r.customer_name || '',
      phone_masked: maskPhone(r.customer_phone),
      status: r.clicked_at ? 'clicked' : r.status,
      scheduled_for: r.scheduled_for,
      sent_at: r.sent_at,
      created_at: r.created_at,
    }));

    return res.status(200).json({
      ok: true,
      settings: settingsOf(client),
      counts,
      recent,
      sender: prettyPhone(client.twilio_number || ''),
    });
  } catch (err) {
    await reportError({ action: `review-settings/${req.method}`, error: err, clientSlug: client && client.client_slug });
    return res.status(500).json({ error: 'Could not load your review settings. Please refresh.' });
  }
}
