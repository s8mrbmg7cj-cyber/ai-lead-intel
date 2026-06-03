// api/save-setup.js
//
// ES MODULE, ZERO npm dependencies. Uses plain fetch against Supabase's REST + Auth
// HTTP endpoints, so it avoids BOTH past crashes:
//   - "require is not defined in ES module scope"  (no require)
//   - "Node.js 20 without native WebSocket"        (no @supabase/supabase-js / realtime)
//
// Env vars (set in Vercel → Settings → Environment Variables):
//   SUPABASE_URL                 (optional — defaults below)
//   SUPABASE_ANON_KEY            (optional — defaults below)
//   SUPABASE_SERVICE_ROLE_KEY    (RECOMMENDED — lets the save bypass RLS so it always works)

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://mbrhkeddgmywqqgdfdgx.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable__YkhmAu61Nr8VetJS8pJqA_MHrmO69t';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const ALLOWED_FIELDS = [
  'business_type', 'caller_greeting', 'ai_personality', 'voice_style',
  'business_hours', 'service_area', 'services_offered',
  'forwarding_number', 'transfer_destination', 'emergency_rules',
];

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

// Verify the user's JWT by asking Supabase Auth who it belongs to.
async function getUser(token) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  return r.json();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) { res.status(401).json({ error: 'Missing authentication token' }); return; }

    const user = await getUser(token);
    if (!user || !user.id) { res.status(401).json({ error: 'Invalid or expired session' }); return; }
    const userId = user.id;

    const body = await readJsonBody(req);
    const clientSlug = body.client_slug;
    if (!clientSlug) { res.status(400).json({ error: 'Missing client_slug' }); return; }

    const update = { setup_complete: true };
    for (const key of ALLOWED_FIELDS) {
      if (key in body) update[key] = body[key] ?? null;
    }

    // Prefer the service role key (bypasses RLS → always works). Fall back to the
    // user's own token (works only if you have an RLS UPDATE policy for owners).
    const usingService = !!SUPABASE_SERVICE_ROLE_KEY;
    const apiKey = usingService ? SUPABASE_SERVICE_ROLE_KEY : SUPABASE_ANON_KEY;
    const bearer = usingService ? SUPABASE_SERVICE_ROLE_KEY : token;

    const url = `${SUPABASE_URL}/rest/v1/clients`
      + `?client_slug=eq.${encodeURIComponent(clientSlug)}`
      + `&owner_user_id=eq.${encodeURIComponent(userId)}`;

    const r = await fetch(url, {
      method: 'PATCH',
      headers: {
        apikey: apiKey,
        Authorization: `Bearer ${bearer}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify(update),
    });

    const rows = await r.json().catch(() => []);
    if (!r.ok) {
      console.error('save-setup db error', r.status, rows);
      res.status(500).json({ error: (rows && rows.message) || 'Database update failed' });
      return;
    }
    if (!Array.isArray(rows) || rows.length === 0) {
      res.status(403).json({ error: 'No matching client row. Add an RLS UPDATE policy for owners, or set SUPABASE_SERVICE_ROLE_KEY.' });
      return;
    }

    res.status(200).json({ ok: true, client_slug: clientSlug });
  } catch (err) {
    console.error('save-setup error', err);
    res.status(500).json({ error: err?.message || 'Unexpected server error' });
  }
}
