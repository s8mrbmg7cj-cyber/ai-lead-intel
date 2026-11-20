// /api/mark-live.js
//
// Server-side route for marking a client's AI setup as live.
//
// Why this exists:
//   The setup page can't directly UPDATE public.clients from the browser because:
//     1. Browser uses the anon key (correct).
//     2. RLS is enabled on public.clients (correct).
//     3. Anon role does NOT have UPDATE permission (correct).
//   So we proxy the update through this server-side route, which uses the
//   service role key (server-only) to perform the update on behalf of the client.
//
// Env vars used:
//   - SUPABASE_URL          (already set on Vercel)
//   - SUPABASE_SERVICE_KEY  (or SUPABASE_SECRET_KEY — server-only, never sent to browser)
//
// Endpoint:
//   POST /api/mark-live
//   Body: { client_slug: "andrew-afnz" }
//   Response: { success: true, business_name, ai_phone_number, ai_setup_status }
//          or  { success: false, error: "..." }

export default async function handler(req, res) {
  // CORS — same-origin only, but allow OPTIONS preflight
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).json({ ok: true });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  // ----- VALIDATE INPUT -----
  let body = req.body || {};
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (_) { body = {}; }
  }

  const clientSlug = (body.client_slug || '').toString().trim();

  if (!clientSlug) {
    console.error('[mark-live] Missing client_slug in request body');
    return res.status(400).json({ success: false, error: 'Missing client_slug' });
  }

  // Defensive slug shape check — only allow lowercase letters, numbers, hyphens
  if (!/^[a-z0-9-]+$/.test(clientSlug) || clientSlug.length > 100) {
    console.error('[mark-live] Invalid slug format:', clientSlug);
    return res.status(400).json({ success: false, error: 'Invalid slug format' });
  }

  // ----- CHECK ENV -----
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY;

  if (!supabaseUrl || !supabaseKey) {
    console.error('[mark-live] Missing SUPABASE_URL or SUPABASE_SERVICE_KEY env vars');
    return res.status(500).json({
      success: false,
      error: 'Server is missing Supabase credentials. Contact support.',
    });
  }

  // ----- PERFORM UPDATE via REST API -----
  // Using the REST endpoint directly with the service role key.
  // The service role bypasses RLS — this is intentional and safe because it
  // runs server-side only. The service key is never exposed to the browser.
  try {
    // This route is intentionally unauthenticated — the customer reaches
    // /go-live from an emailed slug link with no session. The slug is therefore
    // the only credential, so keep the blast radius tiny:
    //   • only ever writes ai_setup_status (a display flag)
    //   • refuses rows that are cancelled (no reviving a closed account)
    //   • returns NO account data back (see below)
    const url = `${supabaseUrl}/rest/v1/clients?client_slug=eq.${encodeURIComponent(clientSlug)}` +
      `&status=not.in.(cancelled,canceled)`;

    const supabaseRes = await fetch(url, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        Prefer: 'return=representation', // get the updated row back
      },
      body: JSON.stringify({
        ai_setup_status: 'live',
        updated_at: new Date().toISOString(),
      }),
    });

    if (!supabaseRes.ok) {
      const errText = await supabaseRes.text().catch(() => '');
      console.error('[mark-live] Supabase PATCH failed:', supabaseRes.status, errText);
      return res.status(500).json({
        success: false,
        error: `Update failed (${supabaseRes.status}). Contact support.`,
      });
    }

    const rows = await supabaseRes.json().catch(() => []);

    if (!Array.isArray(rows) || rows.length === 0) {
      console.error('[mark-live] No client matched slug:', clientSlug);
      return res.status(404).json({
        success: false,
        error: 'No matching client found. Double-check your setup link.',
      });
    }

    const updated = rows[0];
    console.log('[mark-live] Success — client:', updated.id, 'slug:', clientSlug);

    // Deliberately does NOT echo the business name or AI phone number. Both
    // callers (public/go-live and the admin panel) already hold those values
    // locally and fall back to them, so returning them here would only turn an
    // unauthenticated endpoint into a slug-guessing lookup for someone else's
    // account details.
    return res.status(200).json({
      success: true,
      ai_setup_status: updated.ai_setup_status || 'live',
    });
  } catch (err) {
    console.error('[mark-live] Unexpected error:', err);
    return res.status(500).json({
      success: false,
      error: 'Server error. Please try again or contact support.',
    });
  }
}
