// api/review-request-create.js
//
// The business marks a job complete. We queue ONE Google review text to that
// job's customer, to be sent `review_delay_hours` later by api/review-request-send.js.
//
// A2P 10DLC: this endpoint is the consent gate. It refuses to queue anything
// unless the business explicitly attests, in this request, that the customer
// agreed to receive texts — and it writes who attested, when, and how into the
// row. No consent record, no message. There is deliberately no bulk import and
// no way to queue a number that isn't attached to a completed job.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY

import { rateLimit, getClientIp } from '../lib/rate-limit.js';
import { requireClientOwner } from '../lib/review-auth.js';
import {
  sb, enc, toE164, isValidReviewLink, makeClickToken, isOptedOut, reportError,
} from '../lib/review-requests.js';

const MAX_DELAY_HOURS = 168; // 7 days — beyond this it stops reading as transactional

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = getClientIp(req);
  const limit = rateLimit(`review-create:${ip}`, 60, 60 * 60); // 60 jobs / hour / IP
  if (!limit.ok) {
    res.setHeader('Retry-After', String(limit.retryAfter));
    return res.status(429).json({ error: 'Too many requests — slow down a moment.' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  let client = null;
  try {
    const auth = await requireClientOwner(req, body.client_slug);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
    client = auth.client;
    const user = auth.user;

    // ── Consent gate — hard stop, checked before anything else ──
    if (body.consent !== true) {
      return res.status(400).json({
        error: 'You must confirm this customer agreed to receive text messages before we can send one.',
      });
    }
    const consentMethod = String(body.consent_method || '').trim().slice(0, 80);
    if (!consentMethod) {
      return res.status(400).json({ error: 'Please tell us how this customer gave permission.' });
    }

    // ── Feature + settings must be configured ──
    if (client.review_requests_enabled !== true) {
      return res.status(400).json({ error: 'Review requests are turned off. Turn them on in your dashboard first.' });
    }
    const reviewLink = String(client.google_review_link || '').trim();
    if (!isValidReviewLink(reviewLink)) {
      return res.status(400).json({ error: 'Add your Google review link in your dashboard first.' });
    }

    // ── Customer details ──
    const customerName = String(body.customer_name || '').trim().slice(0, 120);
    const customerPhone = toE164(body.customer_phone);
    if (!customerPhone) {
      return res.status(400).json({ error: 'That phone number doesn\'t look right. Enter a 10-digit US mobile number.' });
    }

    // Never text a number that already said stop — even once, even years ago.
    if (await isOptedOut(customerPhone, client.id)) {
      return res.status(409).json({
        error: 'This customer previously replied STOP, so we can\'t text them. You can still ask them in person.',
        opted_out: true,
      });
    }

    // ── Idempotency: a double-tapped "Job complete" must not queue twice ──
    const existing = await sb(
      `review_requests?client_id=eq.${enc(client.id)}&customer_phone=eq.${enc(customerPhone)}` +
      `&status=in.(pending,sending)&select=id,scheduled_for&limit=1`
    );
    if (Array.isArray(existing) && existing[0]) {
      return res.status(200).json({
        ok: true,
        duplicate: true,
        id: existing[0].id,
        scheduled_for: existing[0].scheduled_for,
        message: 'A review request for this customer is already queued.',
      });
    }

    // 0 is a legitimate setting ("text them right away"), and `|| 2` would
    // silently turn it into a 2-hour delay. Note Number(null) is 0, not NaN,
    // so the empty case has to be tested before the numeric one.
    const rawDelay = client.review_delay_hours;
    const parsedDelay =
      (rawDelay === null || rawDelay === undefined || rawDelay === '') ? 2 : Number(rawDelay);
    const delayHours = Math.min(
      MAX_DELAY_HOURS,
      Math.max(0, Number.isFinite(parsedDelay) ? parsedDelay : 2)
    );
    const now = new Date();
    const scheduledFor = new Date(now.getTime() + delayHours * 3600000);

    let inserted;
    try {
      inserted = await sb('review_requests', {
        method: 'POST',
        prefer: 'return=representation',
        body: {
          client_id: client.id,
          customer_name: customerName || null,
          customer_phone: customerPhone,
          google_review_link: reviewLink,
          click_token: makeClickToken(),
          status: 'pending',
          // Consent evidence — this is what gets produced in an audit.
          consent_captured_at: now.toISOString(),
          consent_method: consentMethod,
          consent_captured_by: user.email || user.id,
          job_completed_at: now.toISOString(),
          scheduled_for: scheduledFor.toISOString(),
        },
      });
    } catch (err) {
      // 23505 = unique violation. The only unique constraints that can fire
      // here are review_requests_one_active_per_phone (the other tap of a
      // double tap won the race) and the click_token index (a 1-in-10^15
      // collision). Either way the customer already has a request queued, so
      // report it as the duplicate it is instead of a scary failure.
      if (/23505|duplicate key/i.test(err.message || '')) {
        const dupe = await sb(
          `review_requests?client_id=eq.${enc(client.id)}&customer_phone=eq.${enc(customerPhone)}` +
          `&status=in.(pending,sending)&select=id,scheduled_for&limit=1`
        );
        const d = Array.isArray(dupe) ? dupe[0] : null;
        return res.status(200).json({
          ok: true,
          duplicate: true,
          id: d && d.id,
          scheduled_for: d && d.scheduled_for,
          message: 'A review request for this customer is already queued.',
        });
      }
      throw err;
    }

    const row = Array.isArray(inserted) ? inserted[0] : inserted;
    console.log('[review-request-create] queued', row && row.id, 'for', client.client_slug, '→', scheduledFor.toISOString());

    return res.status(200).json({
      ok: true,
      id: row && row.id,
      scheduled_for: scheduledFor.toISOString(),
      delay_hours: delayHours,
    });
  } catch (err) {
    await reportError({ action: 'review-request-create', error: err, clientSlug: client && client.client_slug });
    return res.status(500).json({ error: 'Could not queue that review request. Please try again.' });
  }
}
