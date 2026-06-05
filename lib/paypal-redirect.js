// =====================================================================
//  lib/paypal-redirect.js  —  AI Lead Intel   (ESM)
//  Builds & validates the PayPal subscription redirect URL for onboarding.
//  Production-safe: never returns an empty/malformed URL silently — it
//  returns { ok:false, error } so the caller can surface a real 4xx/5xx.
//
//  Usage in api/onboarding-submit.js:
//    import { buildPaypalRedirect } from '../lib/paypal-redirect.js';
//    const r = buildPaypalRedirect({ plan: clientRow.plan || data.plan,
//                                    clientSlug: clientRow.client_slug });
//    console.log('[onboarding] paypal:', JSON.stringify(r.log));
//    if (!r.ok) return res.status(502).json({ error: 'PayPal checkout misconfigured: ' + r.error });
//    return res.status(200).json({ paypalRedirect: r.redirect });
// =====================================================================

export function buildPaypalRedirect({ plan, clientSlug, env = process.env } = {}) {
  const selectedPlan = (plan === 'pro') ? 'pro' : 'starter';
  const envVar = selectedPlan === 'pro' ? 'PAYPAL_PRO_URL' : 'PAYPAL_STARTER_URL';

  const starter = (env.PAYPAL_STARTER_URL || '').trim();
  const pro     = (env.PAYPAL_PRO_URL || '').trim();

  // Debug breadcrumb — safe to log (these are public subscribe links, not secrets)
  const log = {
    selectedPlan,
    selectedEnvVar: envVar,
    PAYPAL_STARTER_URL: starter || '(missing)',
    PAYPAL_PRO_URL: pro || '(missing)',
    customIdAppended: false,
    finalRedirect: null,
  };

  const raw = selectedPlan === 'pro' ? pro : starter;

  // 1) Missing env var → hard fail (was previously a silent "" → broken redirect)
  if (!raw) {
    return { ok: false, error: `Missing ${envVar} environment variable`, log };
  }

  // 2) Must parse as a URL
  let url;
  try { url = new URL(raw); }
  catch { return { ok: false, error: `${envVar} is not a valid URL: "${raw}"`, log }; }

  // 3) Must be https
  if (url.protocol !== 'https:') {
    return { ok: false, error: `${envVar} must use https (got "${url.protocol}")`, log };
  }

  // 4) Must be a PayPal host
  const host = url.hostname.toLowerCase();
  if (!(host === 'paypal.com' || host.endsWith('.paypal.com'))) {
    return { ok: false, error: `${envVar} is not a paypal.com URL (host: "${host}")`, log };
  }
  log.isSandbox = host.includes('sandbox');   // www.sandbox.paypal.com = TEST, not production
  // A sandbox link in production is the #1 cause of PayPal's error page. Block it
  // unless explicitly allowed (set PAYPAL_ALLOW_SANDBOX=true only while testing).
  if (log.isSandbox && env.PAYPAL_ALLOW_SANDBOX !== 'true') {
    return { ok: false, error: `${envVar} points to PayPal SANDBOX (${host}) — this errors in production. Use the live www.paypal.com subscribe link, or set PAYPAL_ALLOW_SANDBOX=true to test.`, log };
  }

  // 5) Must be a subscription "subscribe" link carrying a plan_id
  const planId = url.searchParams.get('plan_id');
  const looksLikeSubscribe = url.pathname.includes('/billing/plans/subscribe');
  if (!looksLikeSubscribe || !planId) {
    return {
      ok: false,
      error: `${envVar} must look like https://www.paypal.com/webapps/billing/plans/subscribe?plan_id=P-XXXX (missing plan_id or wrong path)`,
      log,
    };
  }
  log.planId = planId;
  log.planIdLooksValid = /^P-[A-Z0-9]+$/i.test(planId);
  if (!log.planIdLooksValid) {
    return { ok: false, error: `${envVar} plan_id does not look like a PayPal plan id (expected "P-..."): "${planId}"`, log };
  }

  // 6) custom_id: append safely via the URL API (correct encoding, no manual ?/&).
  //    NOTE: PayPal does NOT capture custom_id from the hosted subscribe link —
  //    it is ignored and will NOT appear in webhooks. It's kept here only as a
  //    harmless tracking breadcrumb. To truly attach custom_id, create the
  //    subscription via the REST API (see createSubscriptionRedirect below).
  if (clientSlug) {
    url.searchParams.set('custom_id', String(clientSlug));
    log.customIdAppended = true;
  }

  log.finalRedirect = url.toString();
  return { ok: true, redirect: url.toString(), log };
}

// =====================================================================
//  RECOMMENDED UPGRADE (optional): create the subscription server-side so
//  custom_id is actually attached and returned in webhooks. Requires:
//    PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_ENV ('live'|'sandbox'),
//    PAYPAL_STARTER_PLAN_ID, PAYPAL_PRO_PLAN_ID
// =====================================================================
export async function createSubscriptionRedirect({ plan, clientSlug, returnUrl, cancelUrl, env = process.env } = {}) {
  const isLive = (env.PAYPAL_ENV || 'live') === 'live';
  const base = isLive ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
  const planId = (plan === 'pro') ? env.PAYPAL_PRO_PLAN_ID : env.PAYPAL_STARTER_PLAN_ID;

  if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET) {
    return { ok: false, error: 'Missing PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET' };
  }
  if (!planId) {
    return { ok: false, error: `Missing ${plan === 'pro' ? 'PAYPAL_PRO_PLAN_ID' : 'PAYPAL_STARTER_PLAN_ID'}` };
  }

  // 1) OAuth token
  const auth = Buffer.from(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`).toString('base64');
  const tokRes = await fetch(`${base}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!tokRes.ok) return { ok: false, error: `PayPal token error ${tokRes.status}: ${await tokRes.text()}` };
  const { access_token } = await tokRes.json();

  // 2) Create subscription with custom_id properly attached.
  //    shipping_preference: NO_SHIPPING removes the "Ship to / address" block
  //    on the PayPal checkout (this is a digital subscription — no shipping).
  const subRes = await fetch(`${base}/v1/billing/subscriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      plan_id: planId,
      custom_id: clientSlug,
      application_context: {
        brand_name: 'AI Lead Intel',
        user_action: 'SUBSCRIBE_NOW',
        shipping_preference: 'NO_SHIPPING',
        return_url: returnUrl,
        cancel_url: cancelUrl,
      },
    }),
  });
  if (!subRes.ok) return { ok: false, error: `PayPal subscription error ${subRes.status}: ${await subRes.text()}` };
  const sub = await subRes.json();
  const approve = (sub.links || []).find(l => l.rel === 'approve');
  if (!approve) return { ok: false, error: 'PayPal did not return an approve link', sub };

  return { ok: true, redirect: approve.href, subscriptionId: sub.id };
}
