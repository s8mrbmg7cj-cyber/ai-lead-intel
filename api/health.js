// api/health.js — internal system health check
//
// Visit /api/health (JSON) or open /health.html (visual). It verifies every
// critical credential is BOTH present AND actually works, by making a real call
// to each service. On any failure it pushes an ntfy alert so you hear about it
// before a customer does.
//
// Optional protection: set HEALTH_KEY env var, then call /api/health?key=YOURKEY.
// If HEALTH_KEY is unset, the endpoint is open (it only reveals which vars are
// missing — never their values).

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const VAPI_PRIVATE_KEY = process.env.VAPI_PRIVATE_KEY || '';
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID || '';
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET || '';
const PAYPAL_ENV = process.env.PAYPAL_ENV || 'live'; // matches lib/paypal-redirect.js
const PAYPAL_API_BASE = PAYPAL_ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
const PAYPAL_STARTER_PLAN_ID = process.env.PAYPAL_STARTER_PLAN_ID || '';
const PAYPAL_PRO_PLAN_ID = process.env.PAYPAL_PRO_PLAN_ID || '';
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const NTFY_TOPIC = process.env.NTFY_TOPIC || '';
const HEALTH_KEY = process.env.HEALTH_KEY || '';

const enc = encodeURIComponent;
const b64 = (s) => Buffer.from(s).toString('base64');

async function notify(text) {
  if (!NTFY_TOPIC) return;
  try {
    await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
      method: 'POST',
      headers: { Title: 'AI Lead Intel health alert', Priority: 'high', Tags: 'warning' },
      body: text,
    });
  } catch (_) {}
}

function envRow(name, val) { return { name, status: val ? 'ok' : 'fail', detail: val ? 'set' : 'MISSING' }; }

// `fetch failed` is the WHOLE of what undici puts in .message. The actual
// reason lives one level down in .cause, and throwing it away cost a month:
// when the Supabase project was deleted in Oct 2026 this endpoint reported
// "supabase: fail - fetch failed", which reads like a transient network blip
// on a site that was otherwise returning 200 everywhere. The same event
// described as "ENOTFOUND mbrhkeddgmywqqgdfdgx.supabase.co" names the problem
// outright. Never report a caught fetch error without unwrapping .cause.
export function describeFetchError(e, url) {
  let host = '';
  try { host = new URL(url).host; } catch (_) { /* url may be '' when the env var is unset */ }

  // undici nests the real error one or two levels deep. Walk to the bottom.
  let root = e;
  for (let i = 0; i < 5 && root && root.cause; i++) root = root.cause;

  const code = root && root.code ? String(root.code) : '';
  const msg = String((root && root.message) || (e && e.message) || e);

  let detail = code && !msg.includes(code) ? `${code}: ${msg}` : msg;
  if (host && !detail.includes(host)) detail += ` (host ${host})`;
  if (code === 'ENOTFOUND') {
    // MEASURED 2026-10-06, do not "simplify" this to "deleted": a PAUSED
    // Supabase project also returns NXDOMAIN. Checked bamoxbalnbmfwbxcvjgh
    // (paused, visible in the dashboard) against 8.8.8.8, 1.1.1.1 and 9.9.9.9
    // — NXDOMAIN from all three, identical to the project we had written off
    // as deleted. Free-tier projects pause themselves after ~7 days idle, so
    // PAUSED is the far likelier cause and it is a one-click fix. Saying
    // "deleted" here sends the reader off to rebuild a schema they still have.
    detail += ' — that hostname does not resolve. On Supabase free tier the usual cause is'
      + ' the project PAUSED ITSELF after ~7 days idle; a paused project stops resolving'
      + ' exactly like a deleted one. Open the Supabase dashboard and look before assuming'
      + ' any data is lost. It can also be a typo in the URL.';
  }
  return detail;
}

async function checkSupabase() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return { status: 'fail', detail: 'missing SUPABASE_URL or SUPABASE_SERVICE_KEY' };
  const url = `${SUPABASE_URL}/rest/v1/clients?select=id&limit=1`;
  try {
    const r = await fetch(url, {
      headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
    });
    return r.ok ? { status: 'ok', detail: 'connected' } : { status: 'fail', detail: `HTTP ${r.status}` };
  } catch (e) { return { status: 'fail', detail: describeFetchError(e, url) }; }
}

async function checkVapi() {
  if (!VAPI_PRIVATE_KEY) return { status: 'fail', detail: 'missing VAPI_PRIVATE_KEY' };
  const url = 'https://api.vapi.ai/assistant?limit=1';
  try {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${VAPI_PRIVATE_KEY}` } });
    return r.ok ? { status: 'ok', detail: 'key valid' } : { status: 'fail', detail: `HTTP ${r.status} — bad/expired key` };
  } catch (e) { return { status: 'fail', detail: describeFetchError(e, url) }; }
}

async function checkPaypal() {
  const missing = [];
  if (!PAYPAL_CLIENT_ID) missing.push('PAYPAL_CLIENT_ID');
  if (!PAYPAL_CLIENT_SECRET) missing.push('PAYPAL_CLIENT_SECRET');
  if (!PAYPAL_STARTER_PLAN_ID) missing.push('PAYPAL_STARTER_PLAN_ID');
  if (!PAYPAL_PRO_PLAN_ID) missing.push('PAYPAL_PRO_PLAN_ID');
  if (missing.length) return { status: 'fail', detail: `missing ${missing.join(', ')}` };
  const url = `${PAYPAL_API_BASE}/v1/oauth2/token`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Basic ${b64(PAYPAL_CLIENT_ID + ':' + PAYPAL_CLIENT_SECRET)}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    if (r.ok) return { status: 'ok', detail: `auth ok + plan IDs set (${PAYPAL_ENV})` };
    return { status: 'fail', detail: `HTTP ${r.status} — bad creds or wrong PAYPAL_ENV (live vs sandbox)` };
  } catch (e) { return { status: 'fail', detail: describeFetchError(e, url) }; }
}

async function checkTwilio() {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) return { status: 'fail', detail: 'missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN' };
  const url = `https://api.twilio.com/2010-04-01/Accounts/${enc(TWILIO_ACCOUNT_SID)}.json`;
  try {
    const r = await fetch(url, {
      headers: { Authorization: `Basic ${b64(TWILIO_ACCOUNT_SID + ':' + TWILIO_AUTH_TOKEN)}` },
    });
    return r.ok ? { status: 'ok', detail: 'creds valid' } : { status: 'fail', detail: `HTTP ${r.status}` };
  } catch (e) { return { status: 'fail', detail: describeFetchError(e, url) }; }
}

async function checkPool() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return { status: 'skip', detail: 'no supabase' };
  const url = `${SUPABASE_URL}/rest/v1/phone_pool?client_id=is.null&select=id`;
  try {
    const r = await fetch(url, {
      headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
    });
    if (!r.ok) return { status: 'fail', detail: `HTTP ${r.status} (is the phone_pool table created?)` };
    const rows = await r.json().catch(() => []);
    const free = Array.isArray(rows) ? rows.length : 0;
    // An empty pool is its own distinct failure, and it is NOT a connection
    // problem — say so, or it gets read as more fallout from the outage.
    if (free <= 0) {
      return { status: 'fail', detail: '0 free numbers — the table exists and is reachable, it is EMPTY. The next signup will fail "out of numbers". Numbers live in Twilio and need inserting here.' };
    }
    return { status: free <= 3 ? 'warn' : 'ok', detail: `${free} free number(s) in pool` };
  } catch (e) { return { status: 'fail', detail: describeFetchError(e, url) }; }
}

export default async function handler(req, res) {
  if (HEALTH_KEY) {
    const key = (req.query && req.query.key) || '';
    if (key !== HEALTH_KEY) { res.status(401).json({ error: 'unauthorized' }); return; }
  }

  const checks = {
    supabase: await checkSupabase(),
    vapi: await checkVapi(),
    paypal: await checkPaypal(),
    twilio: await checkTwilio(),
    phone_pool: await checkPool(),
  };

  const env = {
    required: [
      envRow('SUPABASE_URL', SUPABASE_URL),
      envRow('SUPABASE_SERVICE_KEY', SUPABASE_SERVICE_KEY),
      envRow('VAPI_PRIVATE_KEY', VAPI_PRIVATE_KEY),
      envRow('PAYPAL_CLIENT_ID', PAYPAL_CLIENT_ID),
      envRow('PAYPAL_CLIENT_SECRET', PAYPAL_CLIENT_SECRET),
      envRow('PAYPAL_STARTER_PLAN_ID', PAYPAL_STARTER_PLAN_ID),
      envRow('PAYPAL_PRO_PLAN_ID', PAYPAL_PRO_PLAN_ID),
      envRow('TWILIO_ACCOUNT_SID', TWILIO_ACCOUNT_SID),
      envRow('TWILIO_AUTH_TOKEN', TWILIO_AUTH_TOKEN),
    ],
    optional: [
      envRow('NTFY_TOPIC', NTFY_TOPIC),
      envRow('CLAUDE_MODEL', process.env.CLAUDE_MODEL || ''),
      envRow('PAYPAL_ENV', process.env.PAYPAL_ENV || ''),
      envRow('HEALTH_KEY', HEALTH_KEY),
      // These decide whether webhooks and crons are actually AUTHENTICATED.
      // When one is missing the endpoint quietly falls back to accepting
      // anything, which is invisible from the outside — so surface it here.
      envRow('STRIPE_SECRET_KEY', process.env.STRIPE_SECRET_KEY || ''),
      envRow('STRIPE_WEBHOOK_SECRET', process.env.STRIPE_WEBHOOK_SECRET || ''),
      envRow('PAYPAL_WEBHOOK_ID', process.env.PAYPAL_WEBHOOK_ID || ''),
      envRow('VAPI_WEBHOOK_SECRET', process.env.VAPI_WEBHOOK_SECRET || ''),
      envRow('CRON_SECRET', process.env.CRON_SECRET || ''),
      envRow('RESEND_API_KEY', process.env.RESEND_API_KEY || ''),
    ],
  };

  const failures = [];
  for (const [k, v] of Object.entries(checks)) if (v.status === 'fail') failures.push(`${k}: ${v.detail}`);
  for (const e of env.required) if (e.status === 'fail') failures.push(`env ${e.name} MISSING`);

  const overall = failures.length ? 'fail'
    : (Object.values(checks).some((c) => c.status === 'warn') ? 'warn' : 'ok');

  // Alert on failures (skip with ?silent=1, e.g. when manually poking around).
  if (failures.length && !(req.query && req.query.silent)) {
    await notify('AI Lead Intel health check FAILING:\n- ' + failures.join('\n- '));
  }

  res.status(200).json({ overall, checked_at: new Date().toISOString(), checks, env, failures });
}
