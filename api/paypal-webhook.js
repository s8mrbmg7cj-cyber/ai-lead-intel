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
      // Starter never visits /setup, so make sure a paid Starter gets
      // provisioned even if they closed the browser and never returned to the
      // site. The provision lock + idempotency make this safe alongside the
      // identical hook in onboarding-return.js.
      if ((client.plan || '').toLowerCase() === 'starter') {
        try { await autoProvisionStarter(client); }
        catch (e) { console.error('[paypal-webhook] auto-provision error:', e.message); }
      }
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
      // Notify the owner (push + email) that a subscription went inactive —
      // unless this client was already marked cancelled (e.g. they cancelled
      // from the account page, which already sent the alert).
      if ((client.status || '').toLowerCase() !== 'cancelled') {
        await sendCancelAlert(client, eventType);
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

// ── Notify the owner when a subscription goes inactive ──
// Fires a push via ntfy (NTFY_TOPIC) and an email via Resend (RESEND_API_KEY
// + NOTIFY_EMAIL). Both are best-effort — failures are logged, never thrown,
// so a notification problem can't break webhook processing.
async function sendCancelAlert(client, eventType) {
  const biz = client.business_name || client.client_slug || 'A client';
  const labelMap = {
    'BILLING.SUBSCRIPTION.CANCELLED': 'cancelled their subscription',
    'BILLING.SUBSCRIPTION.EXPIRED': 'subscription expired',
    'BILLING.SUBSCRIPTION.SUSPENDED': 'subscription was suspended',
    'PAYMENT.SALE.DENIED': 'had a payment fail',
  };
  const what = labelMap[eventType] || 'went inactive';
  const title =
    (eventType === 'BILLING.SUBSCRIPTION.CANCELLED' || eventType === 'BILLING.SUBSCRIPTION.EXPIRED')
      ? 'Client cancelled'
      : (eventType === 'PAYMENT.SALE.DENIED' ? 'Payment failed' : 'Client paused');
  const numberNote = client.twilio_number ? ` Their number ${client.twilio_number} was freed.` : '';
  const msg = `${biz} ${what}.${numberNote}`;

  // Push via ntfy (Title header kept plain ASCII; emoji goes in Tags).
  const topic = process.env.NTFY_TOPIC;
  if (topic) {
    try {
      await fetch(`https://ntfy.sh/${topic}`, {
        method: 'POST',
        headers: { Title: title, Priority: 'high', Tags: 'warning' },
        body: msg,
      });
    } catch (e) { console.error('[paypal-webhook] ntfy cancel alert failed:', e.message); }
  }

  // Email via Resend.
  const resendKey = process.env.RESEND_API_KEY;
  const to = process.env.NOTIFY_EMAIL;
  if (resendKey && to) {
    try {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'AI Lead Intel <hello@aileadintel.com>',
          to: [to],
          subject: `${title} — ${biz}`,
          text: `${msg}\n\nEvent: ${eventType}\nClient: ${client.client_slug || ''}`,
        }),
      });
    } catch (e) { console.error('[paypal-webhook] cancel email failed:', e.message); }
  }

  console.log('[paypal-webhook] cancel alert sent:', title, '-', biz);
}

// ── Starter auto-provision (backup path) ──
// Mirrors onboarding-return.js. A one-time lock (provision_requested_at)
// guarantees only one of the two ever provisions a given client.
async function autoProvisionStarter(client) {
  const secret = process.env.SUPABASE_WEBHOOK_SECRET || '';
  if (!secret) {
    console.error('[paypal-webhook] SUPABASE_WEBHOOK_SECRET missing — cannot auto-provision');
    return;
  }
  if (client.twilio_number && client.vapi_phone_number_id) {
    console.log('[paypal-webhook] already provisioned:', client.client_slug);
    return;
  }
  const url = (process.env.SUPABASE_URL || '').replace(/\/$/, '');

  // One-time lock: only matches while provision_requested_at IS NULL.
  try {
    const r = await fetch(`${url}/rest/v1/clients?id=eq.${client.id}&provision_requested_at=is.null`, {
      method: 'PATCH',
      headers: { ...sbHeaders(), 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify({ provision_requested_at: new Date().toISOString() }),
    });
    const rows = await r.json().catch(() => []);
    if (!r.ok || !Array.isArray(rows) || rows.length === 0) {
      console.log('[paypal-webhook] provision lock not acquired (already started elsewhere) —', client.client_slug);
      return;
    }
  } catch (e) {
    console.error('[paypal-webhook] provision lock error:', e.message);
    return;
  }

  let result = null;
  try {
    const pr = await fetch('https://aileadintel.com/api/provision', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-secret': secret },
      body: JSON.stringify({ client_slug: client.client_slug }),
    });
    result = await pr.json().catch(() => ({}));
    if (!pr.ok) console.error('[paypal-webhook] provision failed:', pr.status, JSON.stringify(result).slice(0, 300));
  } catch (e) {
    console.error('[paypal-webhook] provision call threw:', e.message);
  }

  const number = result && result.number;
  if (number) {
    console.log('[paypal-webhook] ✅ starter provisioned:', client.client_slug, number);
    await sendStarterLiveEmail(client, number);
  } else {
    await alertOwnerStarterProblem(
      `URGENT: Starter client ${client.business_name || client.client_slug} PAID but auto-provisioning FAILED` +
      ` (${(result && result.error) || 'unknown error'}). Set them up manually ASAP.`
    );
  }
}

// Email the Starter customer their live AI number + how to forward to it.
async function sendStarterLiveEmail(client, number) {
  const key = process.env.RESEND_API_KEY;
  const to = client.notify_email;
  if (!key || !to) {
    console.warn('[paypal-webhook] starter live email skipped (missing RESEND_API_KEY or notify_email)');
    return;
  }
  const pretty = String(number).replace(/^\+1(\d{3})(\d{3})(\d{4})$/, '($1) $2-$3');
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'AI Lead Intel <hello@aileadintel.com>',
        to: [to],
        subject: `Your AI receptionist is live — your number is ${pretty}`,
        text: [
          `Great news — your AI receptionist for ${client.business_name || 'your business'} is set up and answering calls right now.`,
          ``,
          `Your AI's phone number: ${pretty}`,
          ``,
          `Try it: call the number above and talk to your AI. You'll get a summary email at this address the moment the call ends.`,
          ``,
          `To connect your existing business number, forward it to ${pretty}:`,
          `- Most carriers: dial *72, then ${pretty}, and press call. (Dial *73 to turn forwarding off later.)`,
          `- Or simply use ${pretty} as your business line on Google, your website, and your cards.`,
          ``,
          `Questions or want a hand? Just reply to this email.`,
          ``,
          `— AI Lead Intel`,
        ].join('\n'),
      }),
    });
    console.log('[paypal-webhook] ✅ starter live email sent to', to);
  } catch (e) {
    console.error('[paypal-webhook] starter live email failed:', e.message);
  }
}

// Urgent owner alert (push + email) when a paid Starter could not be provisioned.
async function alertOwnerStarterProblem(message) {
  const topic = process.env.NTFY_TOPIC;
  if (topic) {
    try {
      await fetch(`https://ntfy.sh/${topic}`, {
        method: 'POST',
        headers: { Title: 'Starter provisioning problem', Priority: 'urgent', Tags: 'rotating_light' },
        body: message,
      });
    } catch (e) { console.error('[paypal-webhook] ntfy alert failed:', e.message); }
  }
  const key = process.env.RESEND_API_KEY;
  const to = process.env.NOTIFY_EMAIL;
  if (key && to) {
    try {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'AI Lead Intel <hello@aileadintel.com>',
          to: [to],
          subject: 'URGENT: Starter provisioning failed',
          text: message,
        }),
      });
    } catch (e) { console.error('[paypal-webhook] alert email failed:', e.message); }
  }
}
