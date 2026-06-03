// api/save-setup.js
//
// ES MODULE version. Your project's package.json has "type": "module",
// so this file MUST use `import` / `export default` — NOT require/module.exports.
// (The old file crashed with "require is not defined in ES module scope".)
//
// What it does: takes the setup form payload, confirms the request is from a
// signed-in user, and updates THAT user's own row in the `clients` table.

import { createClient } from '@supabase/supabase-js';

// These default to your existing public Supabase values so it works immediately.
// Cleaner long-term: set them as Environment Variables in Vercel and drop the fallbacks.
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://mbrhkeddgmywqqgdfdgx.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable__YkhmAu61Nr8VetJS8pJqA_MHrmO69t';

// Only these columns are allowed to be written from the setup form.
const ALLOWED_FIELDS = [
  'business_type',
  'caller_greeting',
  'ai_personality',
  'voice_style',
  'business_hours',
  'service_area',
  'services_offered',
  'forwarding_number',
  'transfer_destination',
  'emergency_rules',
];

// Robustly read the JSON body whether Vercel pre-parsed it or not.
async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    // 1) Pull the bearer token the front end sends.
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) {
      res.status(401).json({ error: 'Missing authentication token' });
      return;
    }

    // 2) Create a Supabase client that acts AS the signed-in user,
    //    so your Row Level Security policies are respected.
    const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // 3) Confirm the token is valid and get the user id.
    const { data: userData, error: userErr } = await sb.auth.getUser(token);
    if (userErr || !userData?.user) {
      res.status(401).json({ error: 'Invalid or expired session' });
      return;
    }
    const userId = userData.user.id;

    // 4) Read + validate the body.
    const body = await readJsonBody(req);
    const clientSlug = body.client_slug;
    if (!clientSlug) {
      res.status(400).json({ error: 'Missing client_slug' });
      return;
    }

    // 5) Build the update from allowed fields only, and mark setup complete.
    const update = { setup_complete: true };
    for (const key of ALLOWED_FIELDS) {
      if (key in body) update[key] = body[key] ?? null;
    }

    // 6) Update ONLY this user's own client row.
    const { data, error } = await sb
      .from('clients')
      .update(update)
      .eq('client_slug', clientSlug)
      .eq('owner_user_id', userId)
      .select('client_slug')
      .maybeSingle();

    if (error) {
      console.error('save-setup db error', error);
      res.status(500).json({ error: error.message });
      return;
    }
    if (!data) {
      // No row matched — either the slug is wrong, the row belongs to someone
      // else, or RLS blocked the update (see note in the chat).
      res.status(403).json({ error: 'No matching client row for this account' });
      return;
    }

    res.status(200).json({ ok: true, client_slug: data.client_slug });
  } catch (err) {
    console.error('save-setup error', err);
    res.status(500).json({ error: err?.message || 'Unexpected server error' });
  }
}
