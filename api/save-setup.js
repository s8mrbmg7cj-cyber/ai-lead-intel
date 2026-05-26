// api/save-setup.js
// Saves setup page fields to a client row and marks setup_complete.
// Auth: requires a valid Supabase user session (Authorization: Bearer <access_token>).
// Pro users only. Starter users are routed to /confirmation by the frontend.

import ws from 'ws';
import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).json({ ok: true });
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (!supabaseUrl || !supabaseServiceKey) {
    console.error('[save-setup] Missing Supabase env vars');
    return res.status(500).json({ success: false, error: 'Server misconfigured' });
  }

  // Parse body
  let body = req.body || {};
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (_) { body = {}; }
  }

  // Extract bearer token
  const authHeader = String(req.headers.authorization || '');
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) {
    return res.status(401).json({ success: false, error: 'Missing authorization token' });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws }
  });

  // Verify session token
  let userId = null;
  try {
    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userData?.user?.id) {
      console.error('[save-setup] auth verification failed:', userErr?.message);
      return res.status(401).json({ success: false, error: 'Invalid or expired session' });
    }
    userId = userData.user.id;
  } catch (e) {
    console.error('[save-setup] auth exc:', e.message);
    return res.status(401).json({ success: false, error: 'Authentication failed' });
  }

  // Validate slug
  const clientSlug = String(body.client_slug || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (!clientSlug) {
    return res.status(400).json({ success: false, error: 'Missing client_slug' });
  }

  try {
    // Look up client + verify ownership
    const { data: rows, error: lookupErr } = await supabase
      .from('clients')
      .select('id, owner_user_id, plan, client_slug, business_name, ai_greeting')
      .eq('client_slug', clientSlug)
      .limit(1);

    if (lookupErr) {
      console.error('[save-setup] lookup error:', lookupErr.message);
      return res.status(500).json({ success: false, error: 'Could not verify account' });
    }

    const client = rows && rows[0];
    if (!client) {
      return res.status(404).json({ success: false, error: 'Account not found' });
    }
    if (client.owner_user_id !== userId) {
      return res.status(403).json({ success: false, error: 'Not authorized for this account' });
    }

    // Build update payload — only include fields actually sent
    const trim = (v, max) => {
      const s = String(v == null ? '' : v).trim();
      return max && s.length > max ? s.slice(0, max) : s;
    };

    const update = {};
    const setIfPresent = (key, max) => {
      if (Object.prototype.hasOwnProperty.call(body, key)) {
        const v = trim(body[key], max);
        update[key] = v ? v : null;
      }
    };

    setIfPresent('forwarding_number', 50);
    setIfPresent('business_hours', 500);
    setIfPresent('business_type', 100);
    setIfPresent('caller_greeting', 1000);
    setIfPresent('transfer_destination', 200);
    setIfPresent('emergency_rules', 2000);
    setIfPresent('service_area', 500);
    setIfPresent('services_offered', 2000);

    // Validate personality
    if (Object.prototype.hasOwnProperty.call(body, 'ai_personality')) {
      const p = trim(body.ai_personality, 50);
      if (p && !['warm', 'professional', 'direct'].includes(p)) {
        return res.status(400).json({ success: false, error: 'Invalid ai_personality value' });
      }
      update.ai_personality = p || null;
    }

    // If caller_greeting is set, mirror it into ai_greeting so dashboard shows it.
    // (ai_greeting is the field the dashboard's AI Config card currently reads.)
    if (Object.prototype.hasOwnProperty.call(update, 'caller_greeting') && update.caller_greeting) {
      update.ai_greeting = update.caller_greeting;
    } else if (!client.ai_greeting) {
      // Fallback default if neither exists
      update.ai_greeting = `Thanks for calling ${client.business_name || 'us'}. How can I help today?`;
    }

    update.setup_complete = true;
    update.setup_completed_at = new Date().toISOString();
    update.updated_at = new Date().toISOString();

    const { error: updateErr } = await supabase
      .from('clients')
      .update(update)
      .eq('id', client.id);

    if (updateErr) {
      console.error('[save-setup] update error:', updateErr.message);
      return res.status(500).json({ success: false, error: 'Could not save setup' });
    }

    console.log('[save-setup] ✅ saved for', clientSlug, '(plan:', client.plan, ')');

    return res.status(200).json({
      success: true,
      client_slug: client.client_slug,
      plan: client.plan,
    });
  } catch (err) {
    console.error('[save-setup] UNHANDLED:', err.message);
    return res.status(500).json({ success: false, error: 'Unexpected server error' });
  }
}
