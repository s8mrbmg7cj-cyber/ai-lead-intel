// api/auth-link-user.js
// Called after onboarding/payment to create a Supabase Auth user
// and link them to their existing clients row via owner_user_id.

import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).json({ ok: true });
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (!supabaseUrl || !supabaseServiceKey) {
    console.error('[auth-link-user] Missing Supabase env vars');
    return res.status(500).json({ success: false, error: 'Server misconfigured' });
  }

  let body = req.body || {};
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (_) { body = {}; }
  }

  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const clientSlug = String(body.client_slug || '').trim().toLowerCase();

  if (!email || !email.includes('@')) {
    return res.status(400).json({ success: false, error: 'Invalid email' });
  }
  if (!password || password.length < 8) {
    return res.status(400).json({ success: false, error: 'Password must be at least 8 characters' });
  }
  if (password.length > 200) {
    return res.status(400).json({ success: false, error: 'Password too long' });
  }

  // Create admin client (bypasses RLS)
  const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  },
  realtime: {
    enabled: false
  },
  global: {
    headers: {
      'X-Client-Info': 'auth-link-user'
    }
  }
});

  try {
    // 1. Find the matching client row — by slug first, then fall back to notify_email
    let client = null;

    if (clientSlug) {
      const { data: rows, error } = await supabase
        .from('clients')
        .select('id, business_name, notify_email, owner_user_id, client_slug')
        .eq('client_slug', clientSlug)
        .limit(1);
      if (error) {
        console.error('[auth-link-user] slug lookup error:', error.message);
      } else if (rows && rows[0]) {
        client = rows[0];
      }
    }

    if (!client) {
      const { data: rows, error } = await supabase
        .from('clients')
        .select('id, business_name, notify_email, owner_user_id, client_slug')
        .ilike('notify_email', email)
        .limit(1);
      if (error) {
        console.error('[auth-link-user] email lookup error:', error.message);
      } else if (rows && rows[0]) {
        client = rows[0];
      }
    }

    if (!client) {
      return res.status(404).json({
        success: false,
        error: 'We couldn\'t find an account for this email. Make sure you use the email you submitted during onboarding.',
      });
    }

    // 2. If this client already has an owner_user_id, block re-registration
    if (client.owner_user_id) {
      return res.status(409).json({
        success: false,
        error: 'This account already has a password. Use the sign-in page or reset your password.',
        client_slug: client.client_slug,
      });
    }

    // 3. Create the Supabase Auth user (email auto-confirmed since they're a paid customer)
    const { data: createData, error: createErr } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        client_slug: client.client_slug,
        business_name: client.business_name || '',
      },
    });

    if (createErr) {
      console.error('[auth-link-user] createUser error:', createErr.message);
      // Handle "User already registered" case
      if (createErr.message && createErr.message.toLowerCase().includes('already registered')) {
        return res.status(409).json({
          success: false,
          error: 'An account with this email already exists. Try signing in instead, or use forgot password.',
        });
      }
      return res.status(500).json({
        success: false,
        error: 'Could not create your account. Please try again or email support.',
      });
    }

    const newUser = createData?.user;
    if (!newUser || !newUser.id) {
      console.error('[auth-link-user] No user returned from createUser');
      return res.status(500).json({ success: false, error: 'Account creation failed' });
    }

    // 4. Link the new auth user to the client row
    const { error: linkErr } = await supabase
      .from('clients')
      .update({ owner_user_id: newUser.id })
      .eq('id', client.id);

    if (linkErr) {
      console.error('[auth-link-user] link update error:', linkErr.message);
      // Try to delete the orphan auth user so the customer can retry
      try { await supabase.auth.admin.deleteUser(newUser.id); } catch (_) {}
      return res.status(500).json({
        success: false,
        error: 'Could not link your account. Please try again or email support.',
      });
    }

    console.log('[auth-link-user] ✅ linked user', newUser.id, 'to client', client.client_slug);

    return res.status(200).json({
      success: true,
      client_slug: client.client_slug,
      business_name: client.business_name || '',
    });
  } catch (err) {
    console.error('[auth-link-user] UNHANDLED:', err.message);
    return res.status(500).json({ success: false, error: 'Unexpected server error' });
  }
}
