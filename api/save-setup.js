// /api/save-setup.js
// POST endpoint: writes Pro setup fields to clients table.
// Requires Authorization: Bearer <Supabase JWT> matching the slug's owner_user_id.

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY;

const ALLOWED_PERSONALITIES = new Set(['warm', 'professional', 'direct']);
const ALLOWED_VOICE_STYLES = new Set(['warm_female', 'professional_female', 'calm_male', 'deep_male']);

function sanitize(value, maxLen) {
  if (value === undefined || value === null) return null;
  const str = String(value).trim();
  if (!str) return null;
  return maxLen ? str.slice(0, maxLen) : str;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('[save-setup] Missing Supabase env vars');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  // Extract bearer token
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
  if (!token) {
    return res.status(401).json({ error: 'Missing authorization token' });
  }

  const body = req.body || {};
  const slug = sanitize(body.client_slug, 80);
  if (!slug) {
    return res.status(400).json({ error: 'Missing client_slug' });
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Verify the token and resolve user
  let user;
  try {
    const { data, error } = await admin.auth.getUser(token);
    if (error || !data?.user) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    user = data.user;
  } catch (err) {
    console.error('[save-setup] auth.getUser error:', err);
    return res.status(401).json({ error: 'Authentication failed' });
  }

  // Verify the client belongs to this user
  let client;
  try {
    const { data, error } = await admin
      .from('clients')
      .select('id, client_slug, owner_user_id, plan')
      .eq('client_slug', slug)
      .maybeSingle();
    if (error) {
      console.error('[save-setup] client lookup error:', error);
      return res.status(500).json({ error: 'Database error' });
    }
    if (!data) {
      return res.status(404).json({ error: 'Client not found' });
    }
    if (data.owner_user_id !== user.id) {
      return res.status(403).json({ error: 'Not authorized for this client' });
    }
    client = data;
  } catch (err) {
    console.error('[save-setup] client lookup exception:', err);
    return res.status(500).json({ error: 'Database error' });
  }

  // Validate fields
  const businessType = sanitize(body.business_type, 80);
  const callerGreeting = sanitize(body.caller_greeting, 500);
  const aiPersonality = sanitize(body.ai_personality, 40);
  const voiceStyle = sanitize(body.voice_style, 40);
  const businessHours = sanitize(body.business_hours, 400);
  const serviceArea = sanitize(body.service_area, 400);
  const servicesOffered = sanitize(body.services_offered, 2000);
  const forwardingNumber = sanitize(body.forwarding_number, 40);
  const transferDestination = sanitize(body.transfer_destination, 200);
  const emergencyRules = sanitize(body.emergency_rules, 1000);

  if (aiPersonality && !ALLOWED_PERSONALITIES.has(aiPersonality)) {
    return res.status(400).json({ error: 'Invalid ai_personality value' });
  }
  if (voiceStyle && !ALLOWED_VOICE_STYLES.has(voiceStyle)) {
    return res.status(400).json({ error: 'Invalid voice_style value' });
  }

  const update = {
    business_type: businessType,
    caller_greeting: callerGreeting,
    ai_personality: aiPersonality,
    voice_style: voiceStyle,
    business_hours: businessHours,
    service_area: serviceArea,
    services_offered: servicesOffered,
    forwarding_number: forwardingNumber,
    transfer_destination: transferDestination,
    emergency_rules: emergencyRules,
    setup_complete: true,
    setup_completed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  // Mirror caller_greeting -> ai_greeting so dashboard reads the current value
  if (callerGreeting) {
    update.ai_greeting = callerGreeting;
  }

  try {
    const { error } = await admin
      .from('clients')
      .update(update)
      .eq('id', client.id);
    if (error) {
      console.error('[save-setup] update error:', error);
      return res.status(500).json({ error: 'Failed to save setup' });
    }
  } catch (err) {
    console.error('[save-setup] update exception:', err);
    return res.status(500).json({ error: 'Failed to save setup' });
  }

  return res.status(200).json({
    ok: true,
    client_slug: slug,
    setup_complete: true,
  });
};
