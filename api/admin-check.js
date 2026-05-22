// /api/admin-check.js

import { requireAdmin } from '../lib/auth.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  // Require valid admin session
  if (!requireAdmin(req, res)) {
    return;
  }

  // If requireAdmin passed:
  return res.status(200).json({
    success: true
  });
}
