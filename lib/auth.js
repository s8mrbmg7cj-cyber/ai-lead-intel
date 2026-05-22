// /lib/auth.js
//
// Stateless admin session helpers using HMAC-signed cookies.
// No external dependencies — uses node's built-in crypto.
//
// Cookie format:  admin_session=<base64url(payload)>.<hex(hmac)>
// Payload: { exp: <unix ms> }
//
// Why HMAC instead of JWT lib? Smaller, no deps, fewer attack surface bugs.
// Why HttpOnly? Browser JS can't read it → safe from XSS exfiltration.
// Why SameSite=Strict? Prevents CSRF on the admin endpoints.

import { createHmac, timingSafeEqual } from 'node:crypto';

const COOKIE_NAME = 'admin_session';
const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function getSecret() {
  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error('ADMIN_SESSION_SECRET env var missing or too short (need 16+ chars)');
  }
  return secret;
}

function base64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function base64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64').toString('utf8');
}
function sign(payload) {
  const secret = getSecret();
  return createHmac('sha256', secret).update(payload).digest('hex');
}
function verifySig(payload, sig) {
  try {
    const expected = sign(payload);
    if (expected.length !== sig.length) return false;
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(sig, 'hex'));
  } catch (_) {
    return false;
  }
}

/**
 * Create a Set-Cookie header value that creates a signed admin session.
 * @returns {string} cookie value to put in Set-Cookie header
 */
export function createAdminSession() {
  const payload = JSON.stringify({ exp: Date.now() + SESSION_DURATION_MS });
  const encoded = base64url(payload);
  const sig = sign(encoded);
  const token = `${encoded}.${sig}`;
  const maxAgeSec = Math.floor(SESSION_DURATION_MS / 1000);
  return `${COOKIE_NAME}=${token}; Max-Age=${maxAgeSec}; Path=/; HttpOnly; Secure; SameSite=Strict`;
}

/**
 * Set-Cookie header value that clears the session immediately.
 */
export function clearAdminSession() {
  return `${COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict`;
}

/**
 * Verify the admin_session cookie on an incoming request.
 * @param {object} req Vercel request object
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function verifyAdminSession(req) {
  try {
    const cookieHeader = req.headers.cookie || '';
    const match = cookieHeader.match(new RegExp('(?:^|; )' + COOKIE_NAME + '=([^;]+)'));
    if (!match) return { ok: false, reason: 'no_cookie' };

    const token = match[1];
    const dot = token.lastIndexOf('.');
    if (dot < 1) return { ok: false, reason: 'malformed_token' };

    const encoded = token.slice(0, dot);
    const sig = token.slice(dot + 1);

    if (!verifySig(encoded, sig)) return { ok: false, reason: 'bad_signature' };

    let payload;
    try {
      payload = JSON.parse(base64urlDecode(encoded));
    } catch (_) {
      return { ok: false, reason: 'bad_payload' };
    }

    if (!payload || typeof payload.exp !== 'number') {
      return { ok: false, reason: 'missing_exp' };
    }
    if (payload.exp < Date.now()) return { ok: false, reason: 'expired' };

    return { ok: true };
  } catch (e) {
    return { ok: false, reason: 'exception:' + (e.message || 'unknown') };
  }
}

/**
 * Convenience: send a 401 JSON response if not authenticated.
 * Returns true if request is authenticated, false if it sent a 401 response.
 *
 * Usage:
 *   if (!requireAdmin(req, res)) return;
 */
export function requireAdmin(req, res) {
  const auth = verifyAdminSession(req);
  if (auth.ok) return true;
  res.status(401).json({
    success: false,
    error: 'Unauthorized',
    reason: auth.reason,
  });
  return false;
}
