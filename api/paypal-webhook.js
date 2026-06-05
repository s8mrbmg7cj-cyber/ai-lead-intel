// api/paypal-webhook.js
// SOURCE OF TRUTH for payment status. PayPal calls this directly when a
// subscription is activated/cancelled/etc — independent of whether the
// customer ever returns to the site. Matches the client by the custom_id
// (= client_slug) that createSubscriptionRedirect() stamps onto the
// subscription, with the subscription id as a fallback.
//
// Required env vars:
//   PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET  (same app as onboarding)
//   PAYPAL_ENV          'live' | 'sandbox'  (defaults 'live')
//   PAYPAL_WEBHOOK_ID   from the PayPal dashboard webhook you create
//   SUPABASE_URL, SUPABASE_SERVICE_KEY
//
// If PAYPAL_WEBHOOK_ID is unset, signature verification is SKIPPED (with a
// warning) so you can do an initial test — set it before real customers.

export const config = { maxDuration: 30 };

const PAYPAL_ENV = process.env.PAYPAL_ENV || 'live';
const PAYPAL_BASE = PAYPAL_ENV === 'live'
  ? 'https://api-m.paypal.com'
  : 'https://api-m.sandbox.paypal.com';

const PAID_EVENTS = new Set([
  'BILLING.SUBSCRIPTION.ACTIVATED',
  'PAYMENT.SALE.COMPLETED', // recurring renewal — keep them active
]);
const INACTIVE_EVENTS = new Set([
  'BILLING.SUBSCRIPTION.CANCELLED',
  'BILLING.SUBSCRIPTION.SUSPENDED',
  'BILLING.SUBSCRIPTION.EXPIRED',
  'PAYMENT.SALE.DENIED',
]);

async function getAccessToken() {
  const id = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!id || !secret) throw new Error('Missing PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET');
  const auth = Buffer.from(`${id}:${secret}`).toString('base64');
  const r = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!r.ok) throw new Error(`PayPal token error ${r.status}: ${await r.text()}`);
  const j = await r.json();
  return j.access_token;
}

// Ask PayPal to confirm this event really came from PayPal.
async function verifyWithPayPal(req, event, accessToken) {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!webhookId) {
    console.warn('[paypal-webhook] PAYPAL_WEBHOOK_ID not set — SKIPPING verification (set it before launch).');
    return true;
  }
  const h = req.headers;
  const body = {
    auth_algo: h['paypal-auth-algo'],
    cert_url: h['paypal-cert-url'],
    transmission_id: h['paypal-transmission-id'],
    transmission_sig: h['paypal-transmission-sig'],
    transmission_time: h['paypal-transmission-time'],
    webhook_id: webhookId,
    webhook_event: event,
  };
  try {
    const r = await fetch(`${PAYPAL_BASE}/v1/notifications/verify-webhook-signature`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      console.error('[paypal-webhook] verify call failed:', r.status, await r.text());
      return false;
    }
    const j = await r.json();
    const ok = j.verification_status === 'SUCCESS';
    if (!ok) console.error('[paypal-webhook] verification_status:', j.verification_status);
    return ok;
  } catch (e) {
    console.error('[paypal-webhook] verify error:', e.message);
    return false;
  }
}

function sbHeaders() {
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY;
  return { apikey: key, Authorization: `Bearer ${key}` };
}

// Find the client this event belongs to: by custom_id (= client_slug) first,
// then by the subscription id we stored in payment_external_id at onboarding.
async function findClient(customId, subId) {
  const url = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const enc = encodeURIComponent;

  if (customId) {
    const r = await fetch(`${url}/rest/v1/clients?client_slug=eq.${enc(customId)}&select=*&limit=1`, { headers: sbHeaders() });
    if (r.ok) { const rows = await r.json().catch(() => []); if (rows[0]) return { client: rows[0], by: 'custom_id' }; }
  }
  if (subId) {
    const r = await fetch(`${url}/rest/v1/clients?payment_external_id=eq.${enc(subId)}&select=*&limit=1`, { headers: sbHeaders() });
    if (r.ok) { const rows = await r.json().catch(() => []); if (rows[0]) return { client: rows[0], by: 'subscription_id' }; }
  }
  return { client: null, by: null };
}

async function patchClient(clientId, patch) {
  const url = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const r = await fetch(`${url}/rest/v1/clients?id=eq.${clientId}`, {
    method: 'PATCH',
    headers: { ...sbHeaders(), 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(patch),
  });
  if (!r.ok) console.error('[paypal-webhook] client patch failed:', r.status, await r.text().catch(() => ''));
  else console.log('[paypal-webhook] client updated:', clientId, JSON.stringify(patch));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Parse body (Vercel usually parses JSON already).
  let event = req.body;
  if (typeof event === 'string') { try { event = JSON.parse(event); } catch { event = null; } }
  if (!event || !event.event_type) {
    console.warn('[paypal-webhook] no event_type in body');
    return res.status(200).json({ received: true }); // ack so PayPal doesn't retry-storm
  }

  const eventType = event.event_type;
  console.log('[paypal-webhook] event:', eventType, 'id:', event.id);

  try {
    // Verify authenticity (skipped only if PAYPAL_WEBHOOK_ID unset, for testing).
    let token = null;
    try { token = await getAccessToken(); } catch (e) { console.error('[paypal-webhook]', e.message); }
    if (token) {
      const valid = await verifyWithPayPal(req, event, token);
      if (!valid) {
        console.error('[paypal-webhook] REJECTED — failed verification');
        return res.status(200).json({ received: true, verified: false }); // ack, but do nothing
      }
    }

    // Only act on events we care about.
    if (!PAID_EVENTS.has(eventType) && !INACTIVE_EVENTS.has(eventType)) {
      return res.status(200).json({ received: true, ignored: eventType });
    }

    const resource = event.resource || {};
    const customId = resource.custom_id || resource.custom || null; // subscription events use custom_id
    const subId = resource.id || resource.billing_agreement_id || null; // sale events use billing_agreement_id

    const { client, by } = await findClient(customId, subId);
    if (!client) {
      console.error('[paypal-webhook] NO CLIENT MATCH — custom_id:', customId, 'subId:', subId);
      return res.status(200).json({ received: true, matched: false });
    }
    console.log('[paypal-webhook] matched client', client.client_slug, 'by', by);

    if (PAID_EVENTS.has(eventType)) {
      const patch = {
        payment_status: 'paid',
        payment_pending: false,
        status: 'active',
        active: true,
        paid_at: new Date().toISOString(),
      };
      if (subId) patch.payment_external_id = subId; // record/refresh the subscription id
      await patchClient(client.id, patch);
    } else if (INACTIVE_EVENTS.has(eventType)) {
      // Cancelled / suspended / expired / payment denied → mark inactive.
      const isCancel = eventType === 'BILLING.SUBSCRIPTION.CANCELLED' || eventType === 'BILLING.SUBSCRIPTION.EXPIRED';
      await patchClient(client.id, {
        status: isCancel ? 'cancelled' : 'paused',
        payment_status: eventType === 'PAYMENT.SALE.DENIED' ? 'failed' : 'cancelled',
        payment_pending: false,
        active: false,
      });
      // On a HARD cancel (cancelled/expired), release the phone number back to
      // the pool and clean up Vapi so the number can be reused by a new client
      // and we don't orphan assistants. (Suspended/denied are left intact in
      // case the client resumes.)
      if (isCancel) {
        await releaseNumberAndCleanup(client);
      }
    }

    return res.status(200).json({ received: true, processed: eventType });
  } catch (err) {
    console.error('[paypal-webhook] ERROR:', err.message);
    return res.status(200).json({ received: true, error: err.message }); // ack to avoid retry storm
  }
}

// ── Release a cancelled client's number + clean up Vapi ──
// 1) delete the Vapi phone-number import (so it can be re-imported later)
// 2) delete the Vapi assistant (avoid orphans)
// 3) free the number in phone_pool (client_id = null)
// 4) clear the client's number fields
async function releaseNumberAndCleanup(client) {
  const VAPI_BASE = 'https://api.vapi.ai';
  const VAPI_PRIVATE_KEY = process.env.VAPI_PRIVATE_KEY;
  const url = process.env.SUPABASE_URL;

  // 1 + 2: Vapi cleanup (best-effort; don't block on failures)
  if (VAPI_PRIVATE_KEY) {
    const vapiDel = async (path) => {
      try {
        const r = await fetch(`${VAPI_BASE}${path}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${VAPI_PRIVATE_KEY}` },
        });
        if (!r.ok && r.status !== 404) {
          console.error('[paypal-webhook] vapi delete failed', path, r.status, await r.text().catch(() => ''));
        } else {
          console.log('[paypal-webhook] vapi deleted', path);
        }
      } catch (e) { console.error('[paypal-webhook] vapi delete error', path, e.message); }
    };
    if (client.vapi_phone_number_id) await vapiDel(`/phone-number/${client.vapi_phone_number_id}`);
    if (client.vapi_assistant_id)    await vapiDel(`/assistant/${client.vapi_assistant_id}`);
  }

  // 3: free the number in the pool
  if (client.twilio_number) {
    try {
      const r = await fetch(`${url}/rest/v1/phone_pool?phone_number=eq.${encodeURIComponent(client.twilio_number)}`, {
        method: 'PATCH',
        headers: { ...sbHeaders(), 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ client_id: null, assigned_at: null }),
      });
      if (!r.ok) console.error('[paypal-webhook] pool release failed:', r.status, await r.text().catch(() => ''));
      else console.log('[paypal-webhook] number released to pool:', client.twilio_number);
    } catch (e) { console.error('[paypal-webhook] pool release error:', e.message); }
  }

  // 4: clear the client's number fields
  await patchClient(client.id, {
    twilio_number: null,
    vapi_phone_number_id: null,
    vapi_assistant_id: null,
    setup_complete: false,
  });
}
