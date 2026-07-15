// api/stripe-webhook.js
// SOURCE OF TRUTH for payment status. Stripe calls this directly when a
// Checkout completes, a subscription renews, is cancelled, or a payment fails —
// independent of whether the customer ever returns to the site. Matches the
// client by client_reference_id / metadata.client_slug (= client_slug) that
// createCheckoutRedirect() stamps on the session + subscription, falling back
// to the Stripe subscription id stored in payment_external_id.
//
// Required env vars:
//   STRIPE_SECRET_KEY        sk_live_... (used to look up subscriptions if needed)
//   STRIPE_WEBHOOK_SECRET    whsec_...   (from the Stripe dashboard endpoint)
//   SUPABASE_URL, SUPABASE_SERVICE_KEY
//   SUPABASE_WEBHOOK_SECRET  (to call /api/provision for Starter auto-provision)
//   VAPI_PRIVATE_KEY (optional, for cleanup) · NTFY_TOPIC / RESEND_API_KEY /
//   NOTIFY_EMAIL (owner alerts)
//
// If STRIPE_WEBHOOK_SECRET is unset, signature verification is SKIPPED (with a
// warning) so you can do an initial test — set it before real customers.

import crypto from 'crypto';

// Stripe signature verification needs the RAW request body, so turn off
// Vercel's automatic JSON body parsing for this route.
export const config = { api: { bodyParser: false }, maxDuration: 30 };

const STRIPE_BASE = 'https://api.stripe.com/v1';

// Events that mean "this client is paying" → active.
// checkout.session.completed  = they finished checkout (incl. starting a trial)
// invoice.paid / invoice.payment_succeeded = a renewal cleared
const PAID_EVENTS = new Set([
  'checkout.session.completed',
  'invoice.paid',
  'invoice.payment_succeeded',
]);
// Events that mean "this client is no longer paying" → inactive.
const INACTIVE_EVENTS = new Set([
  'customer.subscription.deleted',
  'invoice.payment_failed',
]);

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

// Verify the Stripe-Signature header against the raw body (no SDK needed).
// Header format: "t=<unix>,v1=<hexsig>[,v1=<hexsig>...]".
function verifyStripeSignature(rawBody, sigHeader, secret) {
  if (!sigHeader) return false;
  const parts = Object.fromEntries(
    sigHeader.split(',').map((kv) => {
      const i = kv.indexOf('=');
      return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
    })
  );
  const timestamp = parts.t;
  if (!timestamp) return false;
  const signedPayload = `${timestamp}.${rawBody.toString('utf8')}`;
  const expected = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
  // The header can carry multiple v1 signatures (comma-separated); accept any match.
  const provided = sigHeader
    .split(',')
    .filter((kv) => kv.trim().startsWith('v1='))
    .map((kv) => kv.trim().slice(3));
  const exp = Buffer.from(expected, 'hex');
  for (const sig of provided) {
    try {
      const got = Buffer.from(sig, 'hex');
      if (got.length === exp.length && crypto.timingSafeEqual(got, exp)) {
        // Reject events older than 5 minutes to blunt replay attacks.
        const age = Math.abs(Date.now() / 1000 - Number(timestamp));
        return age < 300;
      }
    } catch (_) { /* bad hex → skip */ }
  }
  return false;
}

function sbHeaders() {
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY;
  return { apikey: key, Authorization: `Bearer ${key}` };
}

// Find the client this event belongs to: by client_slug first, then by the
// Stripe id (subscription id or checkout session id) we stored in
// payment_external_id.
async function findClient(slug, externalId) {
  const url = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const enc = encodeURIComponent;
  if (slug) {
    const r = await fetch(`${url}/rest/v1/clients?client_slug=eq.${enc(slug)}&select=*&limit=1`, { headers: sbHeaders() });
    if (r.ok) { const rows = await r.json().catch(() => []); if (rows[0]) return { client: rows[0], by: 'client_slug' }; }
  }
  if (externalId) {
    const r = await fetch(`${url}/rest/v1/clients?payment_external_id=eq.${enc(externalId)}&select=*&limit=1`, { headers: sbHeaders() });
    if (r.ok) { const rows = await r.json().catch(() => []); if (rows[0]) return { client: rows[0], by: 'payment_external_id' }; }
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
  if (!r.ok) console.error('[stripe-webhook] client patch failed:', r.status, await r.text().catch(() => ''));
  else console.log('[stripe-webhook] client updated:', clientId, JSON.stringify(patch));
}

// Ask Stripe for a subscription's metadata.client_slug when an event (e.g. an
// invoice) doesn't carry it inline. Best-effort — returns '' on any failure.
async function fetchSubscriptionSlug(subscriptionId) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key || !subscriptionId) return '';
  try {
    const r = await fetch(`${STRIPE_BASE}/subscriptions/${encodeURIComponent(subscriptionId)}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!r.ok) return '';
    const sub = await r.json().catch(() => ({}));
    return (sub && sub.metadata && sub.metadata.client_slug) || '';
  } catch (_) { return ''; }
}

// Pull { slug, externalId, subscriptionId } out of whatever object this event carries.
function extractIds(eventType, obj) {
  const meta = obj.metadata || {};
  let slug = meta.client_slug || obj.client_reference_id || '';
  let subscriptionId = '';
  if (eventType === 'checkout.session.completed') {
    subscriptionId = typeof obj.subscription === 'string' ? obj.subscription : (obj.subscription && obj.subscription.id) || '';
  } else if (eventType.startsWith('invoice.')) {
    subscriptionId = typeof obj.subscription === 'string' ? obj.subscription : (obj.subscription && obj.subscription.id) || '';
  } else if (eventType.startsWith('customer.subscription.')) {
    subscriptionId = obj.id || '';
  }
  return { slug, subscriptionId };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const raw = await readRawBody(req);
  const sigHeader = req.headers['stripe-signature'];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  // Verify authenticity (skipped only if STRIPE_WEBHOOK_SECRET unset, for testing).
  if (secret) {
    if (!verifyStripeSignature(raw, sigHeader, secret)) {
      console.error('[stripe-webhook] REJECTED — bad signature');
      return res.status(400).json({ error: 'Invalid signature' });
    }
  } else {
    console.warn('[stripe-webhook] STRIPE_WEBHOOK_SECRET not set — SKIPPING verification (set it before launch).');
  }

  let event;
  try { event = JSON.parse(raw.toString('utf8')); }
  catch { console.warn('[stripe-webhook] unparseable body'); return res.status(200).json({ received: true }); }

  const eventType = event.type;
  console.log('[stripe-webhook] event:', eventType, 'id:', event.id);

  if (!PAID_EVENTS.has(eventType) && !INACTIVE_EVENTS.has(eventType)) {
    return res.status(200).json({ received: true, ignored: eventType });
  }

  try {
    const obj = (event.data && event.data.object) || {};
    let { slug, subscriptionId } = extractIds(eventType, obj);
    // Invoices/subscription events may not inline the slug — resolve via Stripe.
    if (!slug && subscriptionId) slug = await fetchSubscriptionSlug(subscriptionId);

    const { client, by } = await findClient(slug, subscriptionId);
    if (!client) {
      console.error('[stripe-webhook] NO CLIENT MATCH — slug:', slug, 'subId:', subscriptionId);
      return res.status(200).json({ received: true, matched: false });
    }
    console.log('[stripe-webhook] matched client', client.client_slug, 'by', by);

    if (PAID_EVENTS.has(eventType)) {
      const patch = {
        payment_status: 'paid',
        payment_pending: false,
        status: 'active',
        active: true,
        paid_at: new Date().toISOString(),
      };
      // Replace the stored checkout-session id with the real subscription id so
      // renewals / cancellations (which only carry the sub id) match later.
      if (subscriptionId) patch.payment_external_id = subscriptionId;
      await patchClient(client.id, patch);

      // Starter never visits /setup, so make sure a paid Starter gets
      // provisioned even if they closed the browser and never returned. The
      // provision lock + idempotency make this safe alongside the identical
      // hook in onboarding-return.js.
      if ((client.plan || '').toLowerCase() === 'starter') {
        try { await autoProvisionStarter({ ...client, payment_external_id: subscriptionId || client.payment_external_id }); }
        catch (e) { console.error('[stripe-webhook] auto-provision error:', e.message); }
      }
    } else if (INACTIVE_EVENTS.has(eventType)) {
      const isCancel = eventType === 'customer.subscription.deleted';
      await patchClient(client.id, {
        status: isCancel ? 'cancelled' : 'paused',
        payment_status: isCancel ? 'cancelled' : 'failed',
        payment_pending: false,
        active: false,
      });
      // On a hard cancel, release the phone number back to the pool and clean
      // up Vapi so the number can be reused and we don't orphan assistants.
      // (A failed invoice is left intact in case the client's card recovers.)
      if (isCancel) await releaseNumberAndCleanup(client);
      // Notify the owner unless this client already self-cancelled from /account
      // (that path already sent the alert).
      if ((client.status || '').toLowerCase() !== 'cancelled') {
        await sendCancelAlert(client, eventType);
      }
    }

    return res.status(200).json({ received: true, processed: eventType });
  } catch (err) {
    console.error('[stripe-webhook] ERROR:', err.message);
    return res.status(200).json({ received: true, error: err.message }); // ack to avoid retry storm
  }
}

// ── Release a cancelled client's number + clean up Vapi ──
async function releaseNumberAndCleanup(client) {
  const VAPI_BASE = 'https://api.vapi.ai';
  const VAPI_PRIVATE_KEY = process.env.VAPI_PRIVATE_KEY;
  const url = process.env.SUPABASE_URL;

  if (VAPI_PRIVATE_KEY) {
    const vapiDel = async (path) => {
      try {
        const r = await fetch(`${VAPI_BASE}${path}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${VAPI_PRIVATE_KEY}` },
        });
        if (!r.ok && r.status !== 404) console.error('[stripe-webhook] vapi delete failed', path, r.status, await r.text().catch(() => ''));
        else console.log('[stripe-webhook] vapi deleted', path);
      } catch (e) { console.error('[stripe-webhook] vapi delete error', path, e.message); }
    };
    if (client.vapi_phone_number_id) await vapiDel(`/phone-number/${client.vapi_phone_number_id}`);
    if (client.vapi_assistant_id)    await vapiDel(`/assistant/${client.vapi_assistant_id}`);
  }

  if (client.twilio_number) {
    try {
      const r = await fetch(`${url}/rest/v1/phone_pool?phone_number=eq.${encodeURIComponent(client.twilio_number)}`, {
        method: 'PATCH',
        headers: { ...sbHeaders(), 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ client_id: null, assigned_at: null, vapi_phone_number_id: null }),
      });
      if (!r.ok) console.error('[stripe-webhook] pool release failed:', r.status, await r.text().catch(() => ''));
      else console.log('[stripe-webhook] number released to pool:', client.twilio_number);
    } catch (e) { console.error('[stripe-webhook] pool release error:', e.message); }
  }

  await patchClient(client.id, {
    twilio_number: null,
    vapi_phone_number_id: null,
    vapi_assistant_id: null,
    setup_complete: false,
  });
}

// ── Notify the owner when a subscription goes inactive ──
async function sendCancelAlert(client, eventType) {
  const biz = client.business_name || client.client_slug || 'A client';
  const labelMap = {
    'customer.subscription.deleted': 'cancelled their subscription',
    'invoice.payment_failed': 'had a payment fail',
  };
  const what = labelMap[eventType] || 'went inactive';
  const title = eventType === 'customer.subscription.deleted' ? 'Client cancelled' : 'Payment failed';
  const numberNote = client.twilio_number ? ` Their number ${client.twilio_number} was freed.` : '';
  const msg = `${biz} ${what}.${numberNote}`;

  const topic = process.env.NTFY_TOPIC;
  if (topic) {
    try {
      await fetch(`https://ntfy.sh/${topic}`, {
        method: 'POST',
        headers: { Title: title, Priority: 'high', Tags: 'warning' },
        body: msg,
      });
    } catch (e) { console.error('[stripe-webhook] ntfy cancel alert failed:', e.message); }
  }

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
    } catch (e) { console.error('[stripe-webhook] cancel email failed:', e.message); }
  }
  console.log('[stripe-webhook] cancel alert sent:', title, '-', biz);
}

// ── Starter auto-provision (backup path) ──
// Mirrors onboarding-return.js. A one-time lock (provision_requested_at)
// guarantees only one of the two ever provisions a given client.
async function autoProvisionStarter(client) {
  const secret = process.env.SUPABASE_WEBHOOK_SECRET || '';
  if (!secret) {
    console.error('[stripe-webhook] SUPABASE_WEBHOOK_SECRET missing — cannot auto-provision');
    await alertOwnerStarterProblem(
      `URGENT: Starter client ${client.business_name || client.client_slug} PAID but auto-provision could not run — the SUPABASE_WEBHOOK_SECRET environment variable is missing in Vercel. Add it, then set this client up manually.`
    );
    return;
  }
  if (client.twilio_number && client.vapi_phone_number_id) {
    console.log('[stripe-webhook] already provisioned:', client.client_slug);
    return;
  }
  const url = (process.env.SUPABASE_URL || '').replace(/\/$/, '');

  try {
    const r = await fetch(`${url}/rest/v1/clients?id=eq.${client.id}&provision_requested_at=is.null`, {
      method: 'PATCH',
      headers: { ...sbHeaders(), 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify({ provision_requested_at: new Date().toISOString() }),
    });
    const rows = await r.json().catch(() => []);
    if (!r.ok) {
      const detail = JSON.stringify(rows).slice(0, 250);
      console.error('[stripe-webhook] provision lock PATCH failed:', r.status, detail);
      await alertOwnerStarterProblem(
        `URGENT: Starter client ${client.business_name || client.client_slug} PAID but the provision lock failed (${r.status}: ${detail}). ` +
        `If this mentions provision_requested_at, run this in Supabase: alter table clients add column if not exists provision_requested_at timestamptz; ` +
        `Then set this client up manually.`
      );
      return;
    }
    if (!Array.isArray(rows) || rows.length === 0) {
      console.log('[stripe-webhook] provision lock not acquired (already started elsewhere) —', client.client_slug);
      return;
    }
  } catch (e) {
    console.error('[stripe-webhook] provision lock error:', e.message);
    await alertOwnerStarterProblem(
      `URGENT: Starter client ${client.business_name || client.client_slug} PAID but the provision lock threw an error (${e.message}). Set them up manually.`
    );
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
    if (!pr.ok) console.error('[stripe-webhook] provision failed:', pr.status, JSON.stringify(result).slice(0, 300));
  } catch (e) {
    console.error('[stripe-webhook] provision call threw:', e.message);
  }

  const number = result && result.number;
  if (number) {
    console.log('[stripe-webhook] ✅ starter provisioned:', client.client_slug, number);
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
    console.warn('[stripe-webhook] starter live email skipped (missing RESEND_API_KEY or notify_email)');
    return;
  }
  const pretty = String(number).replace(/^\+1(\d{3})(\d{3})(\d{4})$/, '($1) $2-$3');
  const digits = String(number).replace(/[^\d]/g, '').replace(/^1/, '');
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
          `To connect your existing business number, forward it to your AI. Dial the code for your carrier from your business phone, then press call:`,
          `- Verizon, US Cellular & most landlines: dial *72${digits}   (to turn off later: *73)`,
          `- AT&T: dial *21*${digits}#   (to turn off later: #21#)`,
          `- T-Mobile, Metro, Mint: dial **21*${digits}#   (to turn off later: ##21#)`,
          `- Internet/VoIP phone systems (Spectrum, Xfinity, RingCentral, etc.): turn on call forwarding in your provider's app or settings instead.`,
          `After dialing, call your business number from another phone — your AI should pick up.`,
          ``,
          `Or skip forwarding entirely and use ${pretty} as your business line on Google, your website, and your cards.`,
          ``,
          `Manage or cancel your subscription anytime at: https://aileadintel.com/account`,
          `(First time? Create your login here: https://aileadintel.com/create-password?plan=starter&slug=${client.client_slug || ''}&email=${encodeURIComponent(to)})`,
          ``,
          `Questions or want a hand? Just reply to this email.`,
          ``,
          `— AI Lead Intel`,
        ].join('\n'),
      }),
    });
    console.log('[stripe-webhook] ✅ starter live email sent to', to);
  } catch (e) {
    console.error('[stripe-webhook] starter live email failed:', e.message);
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
    } catch (e) { console.error('[stripe-webhook] ntfy alert failed:', e.message); }
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
    } catch (e) { console.error('[stripe-webhook] alert email failed:', e.message); }
  }
}
