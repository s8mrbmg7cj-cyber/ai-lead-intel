// =====================================================================
//  lib/onboarding-helpers.js  —  AI Lead Intel   (ESM)
//  Drop-in helpers for: auto-linking the auth user to their client row,
//  the setup/welcome email, and lead-notification emails. Plus logging.
//
//  Uses the same pattern your app already uses: Supabase REST via fetch
//  with the SERVICE key (bypasses RLS), and Resend for email.
//
//  ⚠️ ADJUST to your real schema:
//   - TABLE: assumed 'clients'. Change CLIENTS below if different.
//   - COLUMNS: assumed owner_user_id, client_slug, business_name,
//     owner_email (the customer's email), report_email. Rename to match.
//   - ENV: SUPABASE_URL, SUPABASE_SERVICE_KEY, RESEND_API_KEY already
//     exist in your project. EMAIL_FROM defaults to hello@aileadintel.com.
// =====================================================================

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const RESEND_API_KEY       = process.env.RESEND_API_KEY;
const EMAIL_FROM           = process.env.EMAIL_FROM || 'AI Lead Intel <hello@aileadintel.com>';
const DASHBOARD_BASE       = process.env.DASHBOARD_BASE || 'https://aileadintel.com';

const CLIENTS = 'clients';   // <- your client table name

function log(scope, msg, extra) {
  // single, greppable log format → search Vercel logs for "[ali:"
  try { console.log(`[ali:${scope}]`, msg, extra != null ? JSON.stringify(extra) : ''); }
  catch { console.log(`[ali:${scope}]`, msg); }
}
function logErr(scope, err) { console.error(`[ali:${scope}] ERROR:`, err?.message || err); }

async function sbREST(path, { method = 'GET', body, prefer } = {}) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) throw new Error('Missing SUPABASE_URL / SUPABASE_SERVICE_KEY');
  const headers = {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
  };
  if (prefer) headers.Prefer = prefer;
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (!resp.ok) throw new Error(`Supabase REST ${resp.status}: ${await resp.text()}`);
  const txt = await resp.text();
  return txt ? JSON.parse(txt) : null;
}

// =====================================================================
//  1) AUTO-LINK: set owner_user_id on the client row after the auth user
//     is created. Call this from your create-password handler once you
//     have the new auth user's id + the client_slug.
//     Returns the linked client row (or null if no match).
// =====================================================================
export async function linkClientToUser({ userId, clientSlug, email }) {
  log('link', 'linking auth user to client', { userId, clientSlug, email });
  if (!userId) throw new Error('linkClientToUser: userId required');

  // Prefer matching by slug; fall back to email if slug is absent.
  let filter;
  if (clientSlug) filter = `client_slug=eq.${encodeURIComponent(clientSlug)}`;
  else if (email) filter = `owner_email=eq.${encodeURIComponent(email)}`;
  else throw new Error('linkClientToUser: need clientSlug or email');

  // Only claim rows that aren't already linked (idempotent + safe on re-runs).
  const rows = await sbREST(`${CLIENTS}?${filter}&owner_user_id=is.null`, {
    method: 'PATCH',
    prefer: 'return=representation',
    body: { owner_user_id: userId },
  });
  const row = rows && rows[0] ? rows[0] : null;

  if (row) log('link', 'linked OK', { client_slug: row.client_slug, owner_user_id: userId });
  else log('link', 'no unlinked client matched (already linked or not found)', { filter });
  return row;
}

// =====================================================================
//  2) SETUP / WELCOME EMAIL — send after the Supabase account is created.
//     Call from your create-password handler after linkClientToUser().
// =====================================================================
export async function sendSetupEmail({ toEmail, businessName, clientSlug }) {
  log('email:setup', 'sending setup email', { toEmail, clientSlug });
  if (!RESEND_API_KEY) { logErr('email:setup', 'Missing RESEND_API_KEY'); return { ok: false, error: 'no resend key' }; }
  if (!toEmail) { logErr('email:setup', 'no recipient'); return { ok: false, error: 'no recipient' }; }

  const dashUrl = `${DASHBOARD_BASE}/dashboard/${encodeURIComponent(clientSlug || '')}`;
  const html = `
  <div style="font-family:Inter,Arial,sans-serif;background:#0a0a0f;color:#f4f1ee;padding:32px;border-radius:16px;max-width:560px;margin:auto">
    <h1 style="font-size:22px;margin:0 0 8px">Welcome to AI Lead Intel${businessName ? `, ${businessName}` : ''} 👋</h1>
    <p style="color:#a39a92;font-size:15px;line-height:1.6;margin:0 0 20px">
      Your account is live and your 7-day free trial has started — no charge today.
      Our team is now building your AI receptionist.
    </p>
    <a href="${dashUrl}" style="display:inline-block;background:#ff8a3c;color:#1a0f08;font-weight:700;text-decoration:none;padding:12px 22px;border-radius:10px;font-size:15px">Open your dashboard →</a>
    <h3 style="font-size:13px;letter-spacing:1px;text-transform:uppercase;color:#6c6358;margin:28px 0 10px">What happens next</h3>
    <ul style="color:#a39a92;font-size:14px;line-height:1.7;padding-left:18px;margin:0">
      <li>We configure your AI's scripts, FAQs, and booking logic</li>
      <li>We connect your phone number so no call is missed</li>
      <li>We run live test calls, then flip you on</li>
      <li>You'll get an email the moment it's answering calls</li>
    </ul>
    <p style="color:#6c6358;font-size:13px;margin:24px 0 0">
      Questions any time: <a href="mailto:hello@aileadintel.com" style="color:#ff8a3c">hello@aileadintel.com</a>
    </p>
  </div>`;

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: EMAIL_FROM, to: [toEmail], subject: 'Your AI Front Desk is being built 🚀', html }),
    });
    if (!resp.ok) { logErr('email:setup', `Resend ${resp.status}: ${await resp.text()}`); return { ok: false }; }
    log('email:setup', 'sent OK', { toEmail });
    return { ok: true };
  } catch (e) { logErr('email:setup', e); return { ok: false, error: e.message }; }
}

// =====================================================================
//  3) LEAD NOTIFICATION EMAIL — send to the customer when a new lead /
//     missed call / call summary arrives. Call from your Vapi/Twilio/
//     lead-capture handlers. (Your webhooks already write the rows; this
//     adds the "New Lead Received" email the customer wants.)
// =====================================================================
export async function sendLeadEmail({ toEmail, businessName, callerName, phone, reason, when }) {
  log('email:lead', 'sending lead email', { toEmail, phone });
  if (!RESEND_API_KEY) { logErr('email:lead', 'Missing RESEND_API_KEY'); return { ok: false }; }
  if (!toEmail) { logErr('email:lead', 'no recipient'); return { ok: false }; }

  const ts = when ? new Date(when) : new Date();
  const html = `
  <div style="font-family:Inter,Arial,sans-serif;background:#0a0a0f;color:#f4f1ee;padding:28px;border-radius:16px;max-width:520px;margin:auto">
    <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#ff8a3c;font-weight:700">New lead received</div>
    <h1 style="font-size:20px;margin:8px 0 18px">${businessName ? businessName + ' — ' : ''}new lead just came in</h1>
    <table style="width:100%;font-size:14px;color:#f4f1ee;border-collapse:collapse">
      <tr><td style="color:#6c6358;padding:7px 0;width:120px">Caller</td><td style="font-weight:600">${callerName || 'Unknown'}</td></tr>
      <tr><td style="color:#6c6358;padding:7px 0">Phone</td><td style="font-weight:600">${phone || '—'}</td></tr>
      <tr><td style="color:#6c6358;padding:7px 0">Reason</td><td>${reason || 'Not specified'}</td></tr>
      <tr><td style="color:#6c6358;padding:7px 0">Time</td><td>${ts.toLocaleString()}</td></tr>
    </table>
    <p style="color:#6c6358;font-size:12.5px;margin:22px 0 0">Sent by your AI Lead Intel front desk.</p>
  </div>`;

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: EMAIL_FROM, to: [toEmail], subject: 'New Lead Received', html }),
    });
    if (!resp.ok) { logErr('email:lead', `Resend ${resp.status}: ${await resp.text()}`); return { ok: false }; }
    log('email:lead', 'sent OK', { toEmail });
    return { ok: true };
  } catch (e) { logErr('email:lead', e); return { ok: false, error: e.message }; }
}

// =====================================================================
//  4) DASHBOARD LOOKUP helper (server-side, service key) — find a client
//     by auth user id, with a slug fallback. Use this if your dashboard
//     resolves the row server-side. (If your dashboard reads client-side
//     with the anon key, rely on the RLS policy instead.)
// =====================================================================
export async function findClientForUser({ userId, clientSlug }) {
  log('dash:lookup', 'looking up client', { userId, clientSlug });
  if (userId) {
    const byUser = await sbREST(`${CLIENTS}?owner_user_id=eq.${encodeURIComponent(userId)}&limit=1`);
    if (byUser && byUser[0]) { log('dash:lookup', 'found by owner_user_id'); return byUser[0]; }
  }
  if (clientSlug) {
    const bySlug = await sbREST(`${CLIENTS}?client_slug=eq.${encodeURIComponent(clientSlug)}&limit=1`);
    if (bySlug && bySlug[0]) { log('dash:lookup', 'found by slug (owner_user_id may be null)'); return bySlug[0]; }
  }
  log('dash:lookup', 'no client found');
  return null;
}
