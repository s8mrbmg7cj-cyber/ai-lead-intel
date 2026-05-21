// /api/report-error.js
//
// Captures errors from any aileadintel.com page and:
//   1. Sends Andrew a push notification via ntfy (FIRST — most important)
//   2. Logs to Supabase public.error_log table (for history)

const NTFY_TOPIC = 'mcr-leads-andrew-2025';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).json({ ok: true });
  if (req.method !== 'POST') return res.status(405).json({ success: false });

  let body = req.body || {};
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (_) { body = {}; }
  }

  const page = (body.page || 'unknown').toString().slice(0, 100);
  const action = (body.action || 'unknown').toString().slice(0, 100);
  const errorMsg = (body.error || 'no message').toString().slice(0, 500);
  const slug = (body.slug || '').toString().slice(0, 100);
  const userAgent = (body.user_agent || '').toString().slice(0, 300);
  const stack = (body.stack || '').toString().slice(0, 1000);

  // Skip noise — common harmless errors we don't care about
  const ignoredErrors = [
    'ResizeObserver loop limit exceeded',
    'Script error.',
    'Non-Error promise rejection captured',
    'ChunkLoadError',
    'Load failed',
    'NetworkError when attempting',
    'cancelled',
    'AbortError',
  ];
  if (ignoredErrors.some(s => errorMsg.includes(s))) {
    return res.status(200).json({ success: true, ignored: true });
  }

  let ntfyOk = false;
  let ntfyStatus = null;
  let ntfyError = null;
  let supabaseOk = false;

  // ===== 1. NTFY PUSH FIRST — and we WAIT for it to complete =====
  try {
    const ntfyRes = await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
      method: 'POST',
      headers: {
        'Title': 'Error on aileadintel.com',
        'Priority': '4',
        'Tags': 'warning',
      },
      body: `Page: ${page}\nAction: ${action}\nError: ${errorMsg}${slug ? `\nCustomer: ${slug}` : ''}`,
    });
    ntfyStatus = ntfyRes.status;
    ntfyOk = ntfyRes.ok;
    if (!ntfyOk) {
      const txt = await ntfyRes.text().catch(() => '');
      ntfyError = `HTTP ${ntfyRes.status} ${txt}`.slice(0, 200);
    }
  } catch (e) {
    ntfyError = String(e && e.message ? e.message : e).slice(0, 200);
    console.error('[report-error] ntfy push exception:', e);
  }

  // ===== 2. LOG TO SUPABASE (best effort) =====
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY;

  if (supabaseUrl && supabaseKey) {
    try {
      const sbRes = await fetch(`${supabaseUrl}/rest/v1/error_log`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({
          page,
          action,
          error_message: errorMsg,
          client_slug: slug || null,
          user_agent: userAgent,
          stack_trace: stack || null,
        }),
      });
      supabaseOk = sbRes.ok;
    } catch (e) {
      console.error('[report-error] Supabase log failed:', e);
    }
  }

  console.log('[report-error]', { page, action, errorMsg, ntfyOk, ntfyStatus, ntfyError, supabaseOk });

  return res.status(200).json({
    success: true,
    ntfy: { ok: ntfyOk, status: ntfyStatus, error: ntfyError },
    supabase: { ok: supabaseOk },
    topic: NTFY_TOPIC,
  });
}
