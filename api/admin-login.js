// /api/admin-login.js
//
// POST   /api/admin-login  body: { password }  → sets admin_session cookie
// DELETE /api/admin-login                       → clears admin_session cookie

import { createAdminSession, clearAdminSession } from '../lib/auth.js';

export default async function handler(req, res) {
  // Allow only POST and DELETE
  if (req.method === 'DELETE') {
    res.setHeader('Set-Cookie', clearAdminSession());
    return res.status(200).json({ success: true });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  // Parse body
  let body = req.body || {};
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (_) { body = {}; }
  }

  const submittedPassword = (body.password || '').toString();
  const expected = process.env.ADMIN_PASSWORD;

  if (!expected) {
    console.error('[admin-login] ADMIN_PASSWORD env var not set');
    return res.status(500).json({ success: false, error: 'Server misconfigured' });
  }

  // Constant-time compare prevents timing attacks
  if (submittedPassword.length !== expected.length) {
    await sleep(400); // slow brute-force
    return res.status(401).json({ success: false, error: 'Invalid password' });
  }

  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= submittedPassword.charCodeAt(i) ^ expected.charCodeAt(i);
  }

  if (mismatch !== 0) {
    await sleep(400);
    return res.status(401).json({ success: false, error: 'Invalid password' });
  }

  // ✅ Password matched — issue session cookie
  try {
    res.setHeader('Set-Cookie', createAdminSession());
    console.log('[admin-login] ✅ Admin session created');
    return res.status(200).json({ success: true });
  } catch (e) {
    console.error('[admin-login] Session creation failed:', e.message);
    return res.status(500).json({ success: false, error: 'Could not create session' });
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
