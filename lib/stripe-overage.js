// =====================================================================
//  lib/stripe-overage.js  —  AI Lead Intel   (ESM)
//
//  Bills a client for talk minutes used beyond their plan's included
//  allowance, by attaching an invoice item to their existing subscription.
//  Stripe automatically rolls pending invoice items into the customer's next
//  monthly invoice — so overage shows up as a line on their normal bill
//  instead of a surprise separate charge.
//
//  WHY invoice items instead of Stripe "metered billing": metered prices have
//  to be attached at subscription-creation time. Every existing subscriber
//  would have to be migrated. Invoice items work on any subscription that
//  already exists, including the ones already sold.
//
//  BILLED IN BLOCKS, NOT PER MINUTE. A per-minute charge would mean writing to
//  Stripe after nearly every call. Blocks mean one API write per 30 overage
//  minutes, and the customer sees a handful of clean line items rather than
//  ninety $0.25 rows.
//
//  DOUBLE-BILLING IS THE ONLY REAL RISK HERE, so every charge carries a
//  metadata key of `slug:YYYY-MM:blockN` and we list the customer's pending
//  invoice items and check for that exact key before creating anything. This
//  is idempotent across retries, redeploys, and Vapi sending the same
//  end-of-call webhook twice.
//
//  Env:
//    STRIPE_SECRET_KEY      required — no key means overage silently no-ops
//    OVERAGE_RATE_CENTS     optional — cents per extra talk minute (default 25)
// =====================================================================

const STRIPE_BASE = 'https://api.stripe.com/v1';

// Bill in half-hour chunks. See header for why.
export const BLOCK_MINUTES = 30;

// $0.35/minute. Vapi costs roughly $0.10/min, so overage runs ~70% margin —
// deliberately priced above the plan rate so heavy users are nudged toward
// upgrading rather than sitting in overage forever. Override with
// OVERAGE_RATE_CENTS.
const DEFAULT_RATE_CENTS = 35;

export function overageRateCents(env = process.env) {
  const n = parseInt(env.OVERAGE_RATE_CENTS, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RATE_CENTS;
}

// "2026-08" — the billing month an overage block belongs to.
export function billingMonthKey(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

async function stripeGet(path, secret) {
  const r = await fetch(`${STRIPE_BASE}${path}`, {
    headers: { Authorization: `Bearer ${secret}` },
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(json?.error?.message || `Stripe ${r.status}`);
  return json;
}

// The subscription knows its customer; we only store the subscription id.
async function customerForSubscription(subscriptionId, secret) {
  const sub = await stripeGet(`/subscriptions/${encodeURIComponent(subscriptionId)}`, secret);
  const cust = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
  return { customerId: cust || '', status: sub.status || '' };
}

// Which overage blocks have we already put on this customer's next invoice?
// Pending invoice items are the ones not yet attached to a finalized invoice,
// which is exactly the set that could collide with what we're about to add.
async function pendingOverageKeys(customerId, secret) {
  const keys = new Set();
  const res = await stripeGet(
    `/invoiceitems?customer=${encodeURIComponent(customerId)}&pending=true&limit=100`,
    secret
  );
  for (const item of res?.data || []) {
    const k = item?.metadata?.overage_key;
    if (k) keys.add(k);
  }
  return keys;
}

/**
 * Charge for any overage blocks this client has earned but not yet been billed.
 *
 * Safe to call after every single call — it works out what's already billed and
 * only writes the difference. Never throws.
 *
 * @param {object}  opts
 * @param {string}  opts.subscriptionId  Stripe subscription id (payment_external_id)
 * @param {string}  opts.clientSlug      used to build the idempotency metadata key
 * @param {number}  opts.overageMinutes  minutes used beyond the plan allowance
 * @param {string}  opts.planLabel       "STARTER" / "PRO", for the invoice description
 * @returns {Promise<{ok:boolean, charged:number, blocks:number, amountCents:number, reason?:string}>}
 *          `charged` = how many NEW blocks were billed by this call.
 */
export async function chargeOverage({
  subscriptionId,
  clientSlug,
  overageMinutes,
  planLabel = '',
  env = process.env,
  now = new Date(),
} = {}) {
  const out = { ok: false, charged: 0, blocks: 0, amountCents: 0 };

  const secret = (env.STRIPE_SECRET_KEY || '').trim();
  if (!secret) return { ...out, reason: 'no STRIPE_SECRET_KEY' };

  // Free pilots and manually-created clients have no subscription. They simply
  // aren't billable — that's a deliberate choice, not an error.
  if (!subscriptionId || !/^sub_/.test(subscriptionId)) {
    return { ...out, reason: 'client has no Stripe subscription' };
  }

  const blocks = Math.floor(Math.max(0, overageMinutes) / BLOCK_MINUTES);
  if (blocks < 1) return { ...out, ok: true, reason: 'below first billable block' };

  const rate = overageRateCents(env);
  const blockCents = rate * BLOCK_MINUTES;
  const month = billingMonthKey(now);

  try {
    const { customerId, status } = await customerForSubscription(subscriptionId, secret);
    if (!customerId) return { ...out, reason: 'subscription has no customer' };

    // Don't pile charges onto a subscription that's already cancelled or unpaid
    // — that invoice may never be collected and it looks predatory.
    if (status && !['active', 'trialing', 'past_due'].includes(status)) {
      return { ...out, reason: `subscription status is ${status}` };
    }

    const already = await pendingOverageKeys(customerId, secret);

    for (let i = 1; i <= blocks; i++) {
      const key = `${clientSlug || subscriptionId}:${month}:block${i}`;
      if (already.has(key)) continue;

      const from = (i - 1) * BLOCK_MINUTES;
      const to = i * BLOCK_MINUTES;
      const body = new URLSearchParams({
        customer: customerId,
        amount: String(blockCents),
        currency: 'usd',
        description:
          `Additional talk minutes${planLabel ? ` (${planLabel} plan)` : ''} — ` +
          `minutes ${from + 1}-${to} over your monthly allowance`,
        'metadata[overage_key]': key,
        'metadata[client_slug]': clientSlug || '',
        'metadata[billing_month]': month,
      });

      const r = await fetch(`${STRIPE_BASE}/invoiceitems`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${secret}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          // Guards against a duplicate webhook firing inside the same 24h that
          // the pending-item scan can't catch (two requests racing).
          'Idempotency-Key': `overage:${key}`,
        },
        body: body.toString(),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        console.error('[overage] invoice item failed:', j?.error?.message || r.status);
        break;
      }
      out.charged += 1;
    }

    out.ok = true;
    out.blocks = blocks;
    out.amountCents = out.charged * blockCents;
    return out;
  } catch (err) {
    console.error('[overage] failed:', err.message);
    return { ...out, reason: err.message };
  }
}
