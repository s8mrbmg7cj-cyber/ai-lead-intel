// api/auth-link-user.js
//
// Called after onboarding/payment to create a Supabase Auth user and link them
// to their existing clients row via owner_user_id.
//
// ES MODULE, ZERO npm dependencies. Uses plain fetch against Supabase's Auth
// Admin REST + Postgres REST endpoints, so it avoids BOTH past crashes:
//   - "require is not defined in ES module scope"  (no require)
//   - "Node.js 20 without native WebSocket"        (no @supabase/supabase-js / no ws / no realtime)
//
// Request body (from public/admin/create-password.html):
//   { email, password, client_slug }
// Response (unchanged contract the page expects):
//   200 { success:true, client_slug, business_name }
//   4xx/5xx { success:false, error, client_slug? }

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const enc = encodeURIComponent;

function sbHeaders(extra) {
  return Object.assign({
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
  }, extra || {});
}

// Look up the client row by slug first, then fall back to notify_email.
//
// SECURITY: the slug is NOT a secret — it is the slugified business name and it
// appears in every dashboard URL. So a row found by slug is only accepted when
// the submitted email also matches that row's notify_email. Without that check
// anyone could claim ownership of any not-yet-registered account just by
// guessing a business name.
async function findClient({ clientSlug, email }) {
  const select = 'id,business_name,notify_email,owner_user_id,client_slug,plan';
  if (clientSlug) {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/clients?client_slug=eq.${enc(clientSlug)}&select=${enc(select)}&limit=1`,
      { headers: sbHeaders() }
    );
    if (r.ok) {
      const rows = await r.json().catch(() => []);
      const row = rows && rows[0];
      if (row) {
        if (String(row.notify_email || '').trim().toLowerCase() === email) return row;
        console.warn('[auth-link-user] slug/email mismatch for', clientSlug, '— refusing');
        return null;
      }
    }
    else console.error('[auth-link-user] slug lookup HTTP', r.status);
  }
  // ilike on email (case-insensitive). PostgREST: notify_email=ilike.<value>
  const r2 = await fetch(
    `${SUPABASE_URL}/rest/v1/clients?notify_email=ilike.${enc(email)}&select=${enc(select)}&limit=1`,
    { headers: sbHeaders() }
  );
  if (r2.ok) { const rows = await r2.json().catch(() => []); if (rows && rows[0]) return rows[0]; }
  else console.error('[auth-link-user] email lookup HTTP', r2.status);
  return null;
}

// Find an existing auth user by email (used to recover from "already registered").
async function findAuthUserByEmail(email) {
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?per_page=200`, { headers: sbHeaders() });
    if (!r.ok) return null;
    const data = await r.json().catch(() => ({}));
    const users = Array.isArray(data) ? data : (data.users || []);
    const match = users.find(u => String(u.email || '').toLowerCase() === email);
    return match || null;
  } catch (_) { return null; }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).json({ ok: true });
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('[auth-link-user] Missing Supabase env vars');
    return res.status(500).json({ success: false, error: 'Server misconfigured' });
  }

  let body = req.body || {};
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }

  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const clientSlug = String(body.client_slug || '').trim().toLowerCase();

  if (!email || !email.includes('@')) return res.status(400).json({ success: false, error: 'Invalid email' });
  if (!password || password.length < 8) return res.status(400).json({ success: false, error: 'Password must be at least 8 characters' });
  if (password.length > 200) return res.status(400).json({ success: false, error: 'Password too long' });

  try {
    // 1. Find the client row (slug first, then email).
    const client = await findClient({ clientSlug, email });
    if (!client) {
      return res.status(404).json({
        success: false,
        error: "We couldn't find an account for this email. Make sure you use the email you submitted during onboarding.",
      });
    }

    // 2. Already linked → block re-registration.
    if (client.owner_user_id) {
      return res.status(409).json({
        success: false,
        error: 'This account already has a password. Use the sign-in page or reset your password.',
        client_slug: client.client_slug,
      });
    }

    // 3. Create the auth user via the Auth Admin REST endpoint (email auto-confirmed).
    let userId = null;
    const createRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
      method: 'POST',
      headers: sbHeaders(),
      body: JSON.stringify({
        email,
        password,
        email_confirm: true,
        user_metadata: { client_slug: client.client_slug, business_name: client.business_name || '' },
      }),
    });
    const createJson = await createRes.json().catch(() => ({}));

    if (createRes.ok && createJson && createJson.id) {
      userId = createJson.id;
    } else {
      // Recover from "already registered": find the existing user and link it anyway,
      // so a retry after a half-finished attempt succeeds instead of dead-ending.
      const msg = String((createJson && (createJson.msg || createJson.error_description || createJson.error || createJson.message)) || '').toLowerCase();
      const alreadyExists = createRes.status === 422 || createRes.status === 409 || msg.includes('already') || msg.includes('registered') || msg.includes('exists');
      if (alreadyExists) {
        // A login for this email already exists. Link the client row to it so a
        // half-finished signup can still complete — but do NOT touch the
        // password. Overwriting it here would be an unauthenticated password
        // reset for anyone whose email address is known.
        const existing = await findAuthUserByEmail(email);
        if (existing && existing.id) {
          await fetch(
            `${SUPABASE_URL}/rest/v1/clients?id=eq.${enc(client.id)}`,
            { method: 'PATCH', headers: sbHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify({ owner_user_id: existing.id }) }
          ).catch(() => {});
          return res.status(409).json({
            success: false,
            error: 'You already have a login for this email. Please sign in with your existing password, or use "Forgot password" to reset it.',
            client_slug: client.client_slug,
          });
        }
      }
      if (!userId) {
        console.error('[auth-link-user] createUser failed', createRes.status, JSON.stringify(createJson).slice(0, 300));
        return res.status(500).json({ success: false, error: 'Could not create your account. Please try again or email support.' });
      }
    }

    // 4. Link the auth user to the client row.
    const linkRes = await fetch(
      `${SUPABASE_URL}/rest/v1/clients?id=eq.${enc(client.id)}`,
      { method: 'PATCH', headers: sbHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify({ owner_user_id: userId }) }
    );
    if (!linkRes.ok) {
      const t = await linkRes.text().catch(() => '');
      console.error('[auth-link-user] link update failed', linkRes.status, t.slice(0, 300));
      return res.status(500).json({ success: false, error: 'Could not link your account. Please try again or email support.' });
    }
    console.log('[auth-link-user] linked user', userId, 'to client', client.client_slug);

    // 5. Trigger the setup email (best-effort; never blocks account creation).
    try {
      const base = process.env.SITE_URL || (req.headers.host ? `https://${req.headers.host}` : 'https://aileadintel.com');
      const emailRes = await fetch(`${base}/api/send-setup-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-secret': process.env.SUPABASE_WEBHOOK_SECRET || '' },
        body: JSON.stringify({ client_slug: client.client_slug }),
      });
      if (emailRes.ok) console.log('[auth-link-user] setup email triggered for', client.client_slug);
      else { const t = await emailRes.text().catch(() => ''); console.error('[auth-link-user] setup email failed', emailRes.status, t.slice(0, 200)); }
    } catch (e) {
      console.error('[auth-link-user] setup email error:', e.message);
    }

    return res.status(200).json({
      success: true,
      client_slug: client.client_slug,
      business_name: client.business_name || '',
      plan: (client.plan || '').toLowerCase(),
    });
  } catch (err) {
    console.error('[auth-link-user] UNHANDLED:', err.message);
    return res.status(500).json({ success: false, error: 'Unexpected server error' });
  }
}
