// /lib/review-auth.js
//
// Resolves "which signed-in customer is this, and do they own this client row?"
// for the review-request endpoints. Same approach as api/cancel-subscription.js:
// the browser sends its Supabase access token as a Bearer header, we exchange it
// for a user at /auth/v1/user, then load the client row with the service key.

import { sb, enc } from './review-requests.js';

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_ANON_KEY = 'sb_publishable__YkhmAu61Nr8VetJS8pJqA_MHrmO69t';

async function getUser(token) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  return r.json();
}

/**
 * @returns {{ok: true, user: object, client: object} | {ok: false, status: number, error: string}}
 */
export async function requireClientOwner(req, clientSlug) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return { ok: false, status: 401, error: 'Not signed in' };

  const user = await getUser(token);
  if (!user || !user.id) return { ok: false, status: 401, error: 'Invalid or expired session' };

  if (!clientSlug) return { ok: false, status: 400, error: 'Missing client_slug' };

  const rows = await sb(
    `clients?client_slug=eq.${enc(clientSlug)}&owner_user_id=eq.${enc(user.id)}&select=*&limit=1`
  );
  const client = Array.isArray(rows) ? rows[0] : null;
  if (!client) return { ok: false, status: 403, error: 'No matching account for this login' };

  // A cancelled, past-due ('paused') or switched-off account must not be able
  // to queue new texts. 'paused' is what the Stripe/PayPal webhooks write on a
  // failed payment.
  const status = String(client.status || '').toLowerCase();
  if (status === 'cancelled' || status === 'canceled' || status === 'paused' || client.active === false) {
    return { ok: false, status: 403, error: 'This subscription is not active' };
  }

  return { ok: true, user, client };
}
