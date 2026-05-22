// /api/admin-check.js
//
// GET /api/admin-check  → 200 { success: true } if valid session, else 401.
// Used by the front-end admin guard to verify the user is logged in.

import { verifyAdminSession } from '../lib/auth.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const auth = verifyAdminSession(req);
  if (!auth.ok) {
    return res.status(401).json({ success: false, reason: auth.reason });
  }
  return res.status(200).json({ success: true });
}
