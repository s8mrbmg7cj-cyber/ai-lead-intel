// /api/admin-login.js
//
// POST   /api/admin-login  body: { password }  → sets admin_session cookie
// DELETE /api/admin-login                       → clears admin_session cookie
//
// Rate-limited to 5 failed attempts per IP per 10 minutes, then blocked 1 hour.
// All attempts (success + failure) logged to Supabase admin_login_log.

import { createAdminSession, clearAdminSession } from '../lib/auth.js';
import { rateLimit, getClientIp } from '../lib/rate-limit.js';

const RATE_MAX = 5;
const RATE_WINDOW_SEC = 60 * 10;   // 10 minutes
const RATE_BLOCK_SEC = 60 * 60;    // 1 hour block after limit hit

export default async function handler(req, res) {
  // Security headers
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');

  // Logout
  if (req.method === 'DELETE') {
    res.setHeader('Set-Cookie', clearAdminSession());
    await logAttempt(req, 'logout', null);
    return res.status(200).json({ success: true });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const ip = getClientIp(req);

  // Rate limit by IP — but only count FAILED attempts toward limit (see below)
  const preCheck = rateLimit(`login:${ip}`, RATE_MAX, RATE_WINDOW_SEC, RATE_BLOCK_SEC);
  if (!preCheck.ok) {
    res.setHeader('Retry-After', String(preCheck.retryAfter));
    console.warn(`[admin-login] 🚫 BLOCKED ip=${ip} attempts=${preCheck.count}`);
    await logAttempt(req, 'blocked', 'rate_limited');
    return res.status(429).json({
      success: false,
      error: 'Too many attempts. Try again later.',
      retry_after_seconds: preCheck.retryAfter,
    });
  }

  // Parse body
  let body = req.body || {};
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (_) { body = {}; }
  }

  const submittedPassword = (body.password || '').toString();
  const expected = process.env.ADMIN_PASSWORD;

  if (!expected) {
    console.error('[admin-login] ❌ ADMIN_PASSWORD env var not set');
    return res.status(500).json({ success: false, error: 'Server misconfigured' });
  }

  // Constant-time compare
  let match = (submittedPassword.length === expected.length);
  if (match) {
    let mismatch = 0;
    for (let i = 0; i < expected.length; i++) {
      mismatch |= submittedPassword.charCodeAt(i) ^ expected.charCodeAt(i);
    }
    match = (mismatch === 0);
  }

  if (!match) {
    await sleep(400); // slow brute force
    console.warn(`[admin-login] ❌ FAILED ip=${ip} attempts=${preCheck.count}/${RATE_MAX}`);
    await logAttempt(req, 'failed', 'invalid_password');
    return res.status(401).json({ success: false, error: 'Invalid password' });
  }

  // ✅ Password matched — issue session cookie
  // (Note: rate limit bucket still has the count from this success, but since
  // we only care about blocking attackers, that's fine.)
  try {
    res.setHeader('Set-Cookie', createAdminSession());
    console.log(`[admin-login] ✅ SUCCESS ip=${ip}`);
    await logAttempt(req, 'success', null);
    return res.status(200).json({ success: true });
  } catch (e) {
    console.error('[admin-login] Session creation failed:', e.message);
    return res.status(500).json({ success: false, error: 'Could not create session' });
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Log every login attempt to Supabase.
 * Fire-and-forget — never blocks the response.
 */
async function logAttempt(req, outcome, reason) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (!supabaseUrl || !supabaseKey) return;

  try {
    await fetch(`${supabaseUrl}/rest/v1/admin_login_log`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        ip: getClientIp(req),
        user_agent: (req.headers['user-agent'] || '').toString().slice(0, 300),
        outcome,
        reason: reason ? reason.slice(0, 100) : null,
      }),
    });
  } catch (e) {
    console.error('[admin-login] log write failed:', e.message);
  }
}
