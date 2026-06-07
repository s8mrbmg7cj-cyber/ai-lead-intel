// api/health-extras.js
// Lightweight checks for things the original /api/health-check doesn't cover:
//   1) PayPal — verifies the hosted subscribe links (PAYPAL_STARTER_URL /
//      PAYPAL_PRO_URL) are set and look like real paypal.com subscribe links.
//   2) Phone pool — counts free numbers in the Supabase phone_pool table.
// Dependency-free ESM. Returns only booleans/counts — no secrets are exposed.

function checkPaypal() {
  const starter = (process.env.PAYPAL_STARTER_URL || '').trim();
  const pro = (process.env.PAYPAL_PRO_URL || '').trim();

  const isValid = (u) => {
    if (!u) return false;
    try {
      const url = new URL(u);
      if (url.protocol !== 'https:') return false;
      const host = url.hostname.toLowerCase();
      if (!(host === 'paypal.com' || host.endsWith('.paypal.com'))) return false;
      if (!url.pathname.includes('/billing/plans/subscribe')) return false;
      if (!url.searchParams.get('plan_id')) return false;
      return true;
    } catch { return false; }
  };

  const missing = [];
  if (!starter) missing.push('PAYPAL_STARTER_URL');
  if (!pro) missing.push('PAYPAL_PRO_URL');
  if (missing.length) return { ok: false, detail: `missing ${missing.join(', ')}` };

  const bad = [];
  if (!isValid(starter)) bad.push('PAYPAL_STARTER_URL');
  if (!isValid(pro)) bad.push('PAYPAL_PRO_URL');
  if (bad.length) return { ok: false, detail: `not a valid subscribe link: ${bad.join(', ')}` };

  const sandbox = /sandbox/i.test(starter) || /sandbox/i.test(pro);
  return { ok: !sandbox, detail: sandbox ? 'links point to SANDBOX (test) — use live links' : 'Starter + Pro links set' };
}

async function checkPool() {
  const url = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) return { ok: false, detail: 'Supabase env not set' };
  try {
    const headers = { apikey: key, Authorization: `Bearer ${key}` };
    const freeRes = await fetch(`${url}/rest/v1/phone_pool?client_id=is.null&select=phone_number`, { headers });
    if (freeRes.status === 404 || freeRes.status === 400) {
      return { ok: false, detail: 'phone_pool table missing — run phone_pool.sql' };
    }
    if (!freeRes.ok) return { ok: false, detail: `Supabase HTTP ${freeRes.status}` };
    const freeRows = await freeRes.json().catch(() => []);
    const free = Array.isArray(freeRows) ? freeRows.length : 0;

    const totalRes = await fetch(`${url}/rest/v1/phone_pool?select=phone_number`, { headers });
    const totalRows = totalRes.ok ? await totalRes.json().catch(() => []) : [];
    const total = Array.isArray(totalRows) ? totalRows.length : free;

    return { ok: free > 0, free, total, detail: free > 0 ? `${free} free of ${total}` : 'no free numbers — buy more' };
  } catch (e) {
    return { ok: false, detail: String(e.message || e) };
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const [paypal, pool] = await Promise.all([
      Promise.resolve(checkPaypal()),
      checkPool(),
    ]);
    return res.status(200).json({ paypal, pool });
  } catch (e) {
    return res.status(200).json({
      paypal: { ok: false, detail: 'check error' },
      pool: { ok: false, detail: 'check error' },
    });
  }
}
