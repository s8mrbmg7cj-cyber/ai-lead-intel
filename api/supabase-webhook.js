// /api/supabase-webhook.js
//
// Receives Supabase webhook events for changes to public.clients.
// When ai_setup_status transitions to 'ready' AND no setup email has been
// sent yet, automatically triggers the setup email.
//
// Verbose logging + passes x-internal-secret to /api/send-setup-email.

const SITE_URL = 'https://aileadintel.com';

export default async function handler(req, res) {
  const TRACE_ID = `wh_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  console.log(`[supabase-webhook ${TRACE_ID}] === REQUEST RECEIVED ===`);
  console.log(`[supabase-webhook ${TRACE_ID}] method:`, req.method);

  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'OPTIONS') return res.status(200).json({ ok: true });
  if (req.method !== 'POST') {
    console.warn(`[supabase-webhook ${TRACE_ID}] Wrong method: ${req.method}`);
    return res.status(405).json({ ok: false });
  }

  // ===== AUTH (Supabase's own secret) =====
  const expectedSecret = process.env.SUPABASE_WEBHOOK_SECRET;
  if (expectedSecret) {
    const receivedSecret = req.headers['x-webhook-secret'];
    if (receivedSecret !== expectedSecret) {
      console.warn(`[supabase-webhook ${TRACE_ID}] ❌ Invalid secret.`);
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    console.log(`[supabase-webhook ${TRACE_ID}] ✅ Secret matched`);
  } else {
    console.warn(`[supabase-webhook ${TRACE_ID}] ⚠️ No SUPABASE_WEBHOOK_SECRET env var`);
  }

  // ===== PARSE PAYLOAD =====
  let body = req.body || {};
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) {
      console.error(`[supabase-webhook ${TRACE_ID}] body parse failed:`, e);
      body = {};
    }
  }

  const eventType = body.type || body.event_type;
  const table = body.table;
  const newRow = body.record || body.new || {};
  const oldRow = body.old_record || body.old || {};

  console.log(`[supabase-webhook ${TRACE_ID}] PARSED:`, {
    eventType, table,
    newRow_id: newRow.id,
    newRow_slug: newRow.client_slug,
    newRow_status: newRow.ai_setup_status,
    oldRow_status: oldRow.ai_setup_status,
  });

  if (table !== 'clients') {
    return res.status(200).json({ ok: true, skipped: 'not clients table' });
  }
  if (eventType !== 'UPDATE') {
    return res.status(200).json({ ok: true, skipped: `event is ${eventType}` });
  }

  const newStatus = (newRow.ai_setup_status || '').toLowerCase();
  const oldStatus = (oldRow.ai_setup_status || '').toLowerCase();

  console.log(`[supabase-webhook ${TRACE_ID}] STATUS: "${oldStatus}" → "${newStatus}"`);

  if (newStatus !== 'ready') {
    return res.status(200).json({ ok: true, skipped: `new status is ${newStatus}` });
  }
  if (oldStatus === 'ready') {
    return res.status(200).json({ ok: true, skipped: 'already was ready' });
  }

  const clientSlug = newRow.client_slug;
  if (!clientSlug) {
    return res.status(200).json({ ok: true, skipped: 'no client_slug' });
  }

  // ===== IDEMPOTENCY CHECK =====
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY;

  if (supabaseUrl && supabaseKey && newRow.id) {
    try {
      const checkUrl = `${supabaseUrl}/rest/v1/activity_log?client_id=eq.${newRow.id}&action=eq.setup_email_sent&select=id&limit=1`;
      const checkRes = await fetch(checkUrl, {
        headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
      });
      if (checkRes.ok) {
        const rows = await checkRes.json();
        if (rows && rows.length > 0) {
          console.log(`[supabase-webhook ${TRACE_ID}] SKIP: already sent`);
          return res.status(200).json({ ok: true, skipped: 'already sent' });
        }
      }
    } catch (e) {
      console.error(`[supabase-webhook ${TRACE_ID}] Idempotency check exception:`, e);
    }
  }

  // ===== CALL SEND ENDPOINT (server-to-server with internal secret) =====
  const sendUrl = `${SITE_URL}/api/send-setup-email`;
  console.log(`[supabase-webhook ${TRACE_ID}] Calling: ${sendUrl}`);

  try {
    const sendRes = await fetch(sendUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-secret': expectedSecret || '',
      },
      body: JSON.stringify({ client_slug: clientSlug }),
    });

    const rawText = await sendRes.text();
    console.log(`[supabase-webhook ${TRACE_ID}] Send status:`, sendRes.status);
    console.log(`[supabase-webhook ${TRACE_ID}] Send body:`, rawText.slice(0, 1000));

    let sendData = {};
    try { sendData = JSON.parse(rawText); } catch (_) {}

    if (!sendRes.ok || !sendData.success) {
      console.error(`[supabase-webhook ${TRACE_ID}] ❌ AUTO-SEND FAILED:`, sendData);
      return res.status(200).json({
        ok: true,
        sent: false,
        upstream_status: sendRes.status,
        upstream_body: rawText.slice(0, 500),
      });
    }

    console.log(`[supabase-webhook ${TRACE_ID}] ✅ Auto-sent to`, sendData.email_sent_to);
    return res.status(200).json({ ok: true, sent: true, to: sendData.email_sent_to });
  } catch (e) {
    console.error(`[supabase-webhook ${TRACE_ID}] ❌ Send exception:`, e && e.stack ? e.stack : e);
    return res.status(200).json({
      ok: true,
      sent: false,
      error: String(e.message || e),
    });
  }
}
