// /api/health-check.js
//
// PROTECTED — requires valid admin_session cookie.

import { requireAdmin } from '../lib/auth.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  // ============================================================
// In api/health-check.js, find this section near the top:
//
//   res.setHeader('Access-Control-Allow-Origin', '*');
//   res.setHeader('Cache-Control', 'no-store');         ← already there
//
// You already have Cache-Control: no-store ✅
// ADD these three lines right after it:
// ============================================================

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');

// ============================================================
// That's it for health-check. Everything else stays the same.
// ============================================================

  // ===== AUTH CHECK =====
  if (!requireAdmin(req, res)) return;

  const checks = {
    supabase: { ok: false, ms: null, error: null },
    twilio: { ok: false, count: null, error: null },
    vapi: { ok: false, count: null, error: null },
    activity: {
      last_call_at: null,
      last_onboarding_at: null,
      calls_24h: 0,
      onboardings_24h: 0,
    },
  };

  // ===== 1. SUPABASE =====
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY;

  if (!supabaseUrl || !supabaseKey) {
    checks.supabase.error = 'Missing SUPABASE_URL or SUPABASE_SERVICE_KEY env var';
  } else {
    const start = Date.now();
    try {
      const r = await fetch(`${supabaseUrl}/rest/v1/clients?select=id&limit=1`, {
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
        },
      });
      checks.supabase.ms = Date.now() - start;
      checks.supabase.ok = r.ok;
      if (!r.ok) checks.supabase.error = `HTTP ${r.status}`;
    } catch (e) {
      checks.supabase.error = String(e.message || e).slice(0, 200);
    }
  }

  // ===== 2. TWILIO =====
  const twilioSid = process.env.TWILIO_ACCOUNT_SID;
  const twilioToken = process.env.TWILIO_AUTH_TOKEN;

  if (!twilioSid || !twilioToken) {
    checks.twilio.error = 'Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN env var';
  } else {
    try {
      const auth = Buffer.from(`${twilioSid}:${twilioToken}`).toString('base64');
      const r = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/IncomingPhoneNumbers.json?PageSize=50`,
        { headers: { Authorization: `Basic ${auth}` } }
      );
      if (r.ok) {
        const data = await r.json();
        checks.twilio.ok = true;
        checks.twilio.count = (data.incoming_phone_numbers || []).length;
      } else {
        checks.twilio.error = `HTTP ${r.status}`;
      }
    } catch (e) {
      checks.twilio.error = String(e.message || e).slice(0, 200);
    }
  }

  // ===== 3. VAPI =====
  const vapiKey = process.env.VAPI_API_KEY || process.env.VAPI_PRIVATE_KEY;
  if (!vapiKey) {
    checks.vapi.error = 'Missing VAPI_API_KEY env var';
  } else {
    try {
      const r = await fetch('https://api.vapi.ai/assistant?limit=50', {
        headers: { Authorization: `Bearer ${vapiKey}` },
      });
      if (r.ok) {
        const data = await r.json();
        checks.vapi.ok = true;
        checks.vapi.count = Array.isArray(data) ? data.length : 0;
      } else {
        checks.vapi.error = `HTTP ${r.status}`;
      }
    } catch (e) {
      checks.vapi.error = String(e.message || e).slice(0, 200);
    }
  }

  // ===== 4. RECENT ACTIVITY =====
  if (supabaseUrl && supabaseKey) {
    const sinceISO = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    try {
      const r = await fetch(
        `${supabaseUrl}/rest/v1/calls?select=created_at&order=created_at.desc&limit=1`,
        { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } }
      );
      if (r.ok) {
        const rows = await r.json();
        if (rows && rows[0]) checks.activity.last_call_at = rows[0].created_at;
      }
    } catch (_) {}

    try {
      const r = await fetch(
        `${supabaseUrl}/rest/v1/calls?select=id&created_at=gte.${sinceISO}`,
        {
          headers: {
            apikey: supabaseKey,
            Authorization: `Bearer ${supabaseKey}`,
            Prefer: 'count=exact',
          },
        }
      );
      if (r.ok) {
        const range = r.headers.get('content-range') || '';
        const total = parseInt(range.split('/')[1], 10);
        checks.activity.calls_24h = isNaN(total) ? 0 : total;
      }
    } catch (_) {}

    try {
      const r = await fetch(
        `${supabaseUrl}/rest/v1/client_onboarding?select=created_at&order=created_at.desc&limit=1`,
        { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } }
      );
      if (r.ok) {
        const rows = await r.json();
        if (rows && rows[0]) checks.activity.last_onboarding_at = rows[0].created_at;
      }
    } catch (_) {}

    try {
      const r = await fetch(
        `${supabaseUrl}/rest/v1/client_onboarding?select=id&created_at=gte.${sinceISO}`,
        {
          headers: {
            apikey: supabaseKey,
            Authorization: `Bearer ${supabaseKey}`,
            Prefer: 'count=exact',
          },
        }
      );
      if (r.ok) {
        const range = r.headers.get('content-range') || '';
        const total = parseInt(range.split('/')[1], 10);
        checks.activity.onboardings_24h = isNaN(total) ? 0 : total;
      }
    } catch (_) {}
  }

  const critical = [checks.supabase.ok, checks.twilio.ok, checks.vapi.ok];
  const okCount = critical.filter(x => x).length;
  let overall = 'down';
  if (okCount === 3) overall = 'healthy';
  else if (okCount >= 1) overall = 'degraded';

  return res.status(200).json({
    overall,
    checks,
    timestamp: new Date().toISOString(),
  });
}
