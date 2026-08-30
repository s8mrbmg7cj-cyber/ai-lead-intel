// =====================================================================
//  lib/stripe-checkout.js  —  AI Lead Intel   (ESM)
//  Creates a Stripe Checkout Session (subscription mode) for onboarding and
//  returns the hosted checkout URL the customer is redirected to.
//
//  Talks to Stripe over plain fetch (form-encoded), matching how the rest of
//  this codebase calls PayPal / Supabase / Twilio / Resend — no SDK to install.
//
//  Required env vars (set in Vercel):
//    STRIPE_SECRET_KEY        sk_live_...  (or sk_test_... while testing)
//    STRIPE_STARTER_PRICE_ID  price_...    ($49/mo recurring price)
//    STRIPE_PRO_PRICE_ID      price_...    ($149/mo recurring price)
//  These two env vars are what actually decide the amount charged. Stripe's
//  "Default price" on the Product is IGNORED whenever a price id is sent, which
//  it always is here — so fixing a wrong charge means fixing the env var, not
//  the dashboard. Prices in Stripe are immutable: you cannot edit an amount,
//  only archive the old price and point the env var at a new one.
//  Optional (repeat-signup, no free trial):
//    STRIPE_STARTER_PRICE_NOTRIAL_ID, STRIPE_PRO_PRICE_NOTRIAL_ID
//    (if unset, the trial is simply omitted on the normal price)
//
//  Usage in api/onboarding-submit.js:
//    import { createCheckoutRedirect } from '../lib/stripe-checkout.js';
//    const sub = await createCheckoutRedirect({ plan, clientSlug, noTrial,
//      customerEmail, successUrl, cancelUrl });
//    if (!sub.ok) return res.status(502).json({ error: sub.error });
//    return res.status(200).json({ checkout_url: sub.redirect });
// =====================================================================

const STRIPE_BASE = 'https://api.stripe.com/v1';
const TRIAL_DAYS = 7;

// Flatten a nested object into Stripe's bracketed form-encoding, e.g.
//   { line_items: [{ price: 'x', quantity: 1 }] }
//   → line_items[0][price]=x & line_items[0][quantity]=1
function toForm(obj, prefix, out) {
  out = out || new URLSearchParams();
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    const field = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        if (item !== null && typeof item === 'object') toForm(item, `${field}[${i}]`, out);
        else out.append(`${field}[${i}]`, String(item));
      });
    } else if (value !== null && typeof value === 'object') {
      toForm(value, field, out);
    } else {
      out.append(field, String(value));
    }
  }
  return out;
}

export async function createCheckoutRedirect({
  plan,
  clientSlug,
  customerEmail,
  successUrl,
  cancelUrl,
  noTrial = false,
  env = process.env,
} = {}) {
  const selectedPlan = plan === 'pro' ? 'pro' : 'starter';
  const secret = (env.STRIPE_SECRET_KEY || '').trim();
  if (!secret) return { ok: false, error: 'Missing STRIPE_SECRET_KEY environment variable' };

  // Pick the recurring Price. Repeat signups (noTrial) use a no-trial price if
  // one is configured; otherwise we fall back to the normal price and just omit
  // the trial below, so nothing breaks before those optional prices exist.
  let priceId;
  if (noTrial) {
    priceId = selectedPlan === 'pro'
      ? (env.STRIPE_PRO_PRICE_NOTRIAL_ID || env.STRIPE_PRO_PRICE_ID)
      : (env.STRIPE_STARTER_PRICE_NOTRIAL_ID || env.STRIPE_STARTER_PRICE_ID);
  } else {
    priceId = selectedPlan === 'pro' ? env.STRIPE_PRO_PRICE_ID : env.STRIPE_STARTER_PRICE_ID;
  }
  priceId = (priceId || '').trim();
  if (!priceId) {
    const varName = selectedPlan === 'pro' ? 'STRIPE_PRO_PRICE_ID' : 'STRIPE_STARTER_PRICE_ID';
    return { ok: false, error: `Missing ${varName} environment variable` };
  }
  if (!/^price_/.test(priceId)) {
    return { ok: false, error: `Stripe price id must look like "price_..." (got "${priceId}") — you may have pasted a product id (prod_...) instead.` };
  }

  // subscription_data carries client_slug onto the Subscription itself, so every
  // future subscription event (renewals, cancellations) can be matched back to
  // this client even when it isn't a checkout.session event.
  const subscriptionData = { metadata: { client_slug: clientSlug || '' } };
  // Repeat signups only skip the trial if we DON'T have a dedicated no-trial
  // price. With a dedicated no-trial price, the price itself has no trial.
  const usingNoTrialPrice = noTrial && (
    selectedPlan === 'pro'
      ? !!env.STRIPE_PRO_PRICE_NOTRIAL_ID
      : !!env.STRIPE_STARTER_PRICE_NOTRIAL_ID
  );
  if (!noTrial) subscriptionData.trial_period_days = TRIAL_DAYS;
  // (usingNoTrialPrice → no trial field at all; noTrial w/o a special price → also no trial field)

  const payload = {
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    // client_reference_id + metadata let the webhook + return handler match the
    // Checkout Session to this client with certainty.
    client_reference_id: clientSlug || '',
    metadata: { client_slug: clientSlug || '' },
    subscription_data: subscriptionData,
    billing_address_collection: 'auto',
    allow_promotion_codes: true,
  };
  if (customerEmail) payload.customer_email = customerEmail;

  const form = toForm(payload);

  let resp;
  try {
    resp = await fetch(`${STRIPE_BASE}/checkout/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secret}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    });
  } catch (e) {
    return { ok: false, error: `Could not reach Stripe: ${e.message}` };
  }

  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = (json && json.error && json.error.message) || `Stripe error ${resp.status}`;
    return { ok: false, error: `Stripe checkout error: ${msg}` };
  }
  if (!json.url) return { ok: false, error: 'Stripe did not return a checkout URL', session: json };

  return { ok: true, redirect: json.url, sessionId: json.id };
}
