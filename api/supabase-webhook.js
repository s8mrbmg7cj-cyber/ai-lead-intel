// /api/supabase-webhook.js
//
// Receives Supabase webhook events for changes to public.clients.
// When ai_setup_status transitions to 'ready' AND no setup email has been
// sent yet, automatically triggers the setup email.
//
// VERBOSE LOGGING — every step logs so we can debug from Vercel.

const SITE_URL = 'https://aileadintel.com';

export default async function handler(req, res) {
  const TRACE_ID = `wh_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  console.log(`[supabase-webhook ${TRACE_ID}] === REQUEST RECEIVED ===`);
  console.log(`[supabase-webhook ${TRACE_ID}] method:`, req.method);
  console.log(`[supabase-webhook ${TRACE_ID}] url:`, req.url);
  console.log(`[supabase-webhook ${TRACE_ID}] headers:`, JSON.stringify({
    'content-type': req.headers['content-type'],
    'user-agent': req.headers['user-agent'],
    'x-webhook-secret-present': !!req.headers['x-webhook-secret'],
  }));

  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'OPTIONS') {
    console.log(`[supabase-webhook ${TRACE_ID}] OPTIONS preflight, returning 200`);
    return res.status(200).json({ ok: true });
  }
  if (req.method !== 'POST') {
    console.warn(`[supabase-webhook ${TRACE_ID}] Wrong method: ${req.method}`);
    return res.status(405).json({ ok: false });
  }

  // ===== AUTH =====
  const expectedSecret = process.env.SUPABASE_WEBHOOK_SECRET;
  if (expectedSecret) {
    const receivedSecret = req.headers['x-webhook-secret'];
    if (receivedSecret !== expectedSecret) {
      console.warn(`[supabase-webhook ${TRACE_ID}] ❌ Invalid secret. expected length:`, expectedSecret.length, 'received length:', (receivedSecret || '').length);
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    console.log(`[supabase-webhook ${TRACE_ID}] ✅ Secret matched`);
  } else {
    console.warn(`[supabase-webhook ${TRACE_ID}] ⚠️ No SUPABASE_WEBHOOK_SECRET env var set — accepting unauthenticated`);
  }

  // ===== PARSE PAYLOAD =====
  let body = req.body || {};
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) {
      console.error(`[supabase-webhook ${TRACE_ID}] Failed to JSON.parse body:`, e);
      body = {};
    }
  }

  console.log(`[supabase-webhook ${TRACE_ID}] PAYLOAD:`, JSON.stringify(body).slice(0, 2000));

  const eventType = body.type || body.event_type;
  const table = body.table;
  const newRow = body.record || body.new || {};
  const oldRow = body.old_record || body.old || {};

  console.log(`[supabase-webhook ${TRACE_ID}] PARSED:`, {
    eventType,
    table,
    newRow_id: newRow.id,
    newRow_slug: newRow.client_slug,
    newRow_status: newRow.ai_setup_status,
    newRow_email: newRow.notify_email,
    newRow_setup_ai_number: newRow.setup_ai_number,
    newRow_twilio_number: newRow.twilio_number,
    newRow_phone_number: newRow.phone_number,
    oldRow_status: oldRow.ai_setup_status,
  });

  if (table !== 'clients') {
    console.log(`[supabase-webhook ${TRACE_ID}] SKIP: table is "${table}", not "clients"`);
    return res.status(200).json({ ok: true, skipped: 'not clients table' });
  }

  if (eventType !== 'UPDATE') {
    console.log(`[supabase-webhook ${TRACE_ID}] SKIP: event is "${eventType}", not "UPDATE"`);
    return res.status(200).json({ ok: true, skipped: `event is ${eventType}` });
  }

  const newStatus = (newRow.ai_setup_status || '').toLowerCase();
  const oldStatus = (oldRow.ai_setup_status || '').toLowerCase();

  console.log(`[supabase-webhook ${TRACE_ID}] STATUS TRANSITION: "${oldStatus}" → "${newStatus}"`);

  if (newStatus !== 'ready') {
    console.log(`[supabase-webhook ${TRACE_ID}] SKIP: new status is "${newStatus}", not "ready"`);
    return res.status(200).json({ ok: true, skipped: `new status is ${newStatus}` });
  }
  if (oldStatus === 'ready') {
    console.log(`[supabase-webhook ${TRACE_ID}] SKIP: status was already "ready" (no transition)`);
    return res.status(200).json({ ok: true, skipped: 'already was ready' });
  }

  const clientSlug = newRow.client_slug;
  if (!clientSlug) {
    console.warn(`[supabase-webhook ${TRACE_ID}] SKIP: row has no client_slug`);
    return res.status(200).json({ ok: true, skipped: 'no client_slug' });
  }

  console.log(`[supabase-webhook ${TRACE_ID}] ✅ Transition detected. Will send email for slug="${clientSlug}"`);

  // ===== IDEMPOTENCY: check if setup email already sent =====
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY;

  if (supabaseUrl && supabaseKey && newRow.id) {
    try {
      const checkUrl = `${supabaseUrl}/rest/v1/activity_log?client_id=eq.${newRow.id}&action=eq.setup_email_sent&select=id&limit=1`;
      console.log(`[supabase-webhook ${TRACE_ID}] Idempotency check URL:`, checkUrl);
      const checkRes = await fetch(checkUrl, {
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
        },
      });
      console.log(`[supabase-webhook ${TRACE_ID}] Idempotency check status:`, checkRes.status);
      if (checkRes.ok) {
        const rows = await checkRes.json();
        console.log(`[supabase-webhook ${TRACE_ID}] Idempotency rows found:`, rows.length);
        if (rows && rows.length > 0) {
          console.log(`[supabase-webhook ${TRACE_ID}] SKIP: setup email already sent for client ${newRow.id}`);
          return res.status(200).json({ ok: true, skipped: 'already sent' });
        }
      } else {
        const txt = await checkRes.text().catch(() => '');
        console.warn(`[supabase-webhook ${TRACE_ID}] Idempotency check non-OK:`, checkRes.status, txt);
      }
    } catch (e) {
      console.error(`[supabase-webhook ${TRACE_ID}] Idempotency check exception:`, e && e.stack ? e.stack : e);
      // Continue anyway
    }
  } else {
    console.warn(`[supabase-webhook ${TRACE_ID}] Skipping idempotency check (missing env or id)`);
  }

  // ===== TRIGGER THE SEND =====
  const sendUrl = `${SITE_URL}/api/send-setup-email`;
  console.log(`[supabase-webhook ${TRACE_ID}] === CALLING SEND ENDPOINT ===`);
  console.log(`[supabase-webhook ${TRACE_ID}] URL:`, sendUrl);
  console.log(`[supabase-webhook ${TRACE_ID}] Body:`, JSON.stringify({ client_slug: clientSlug }));

  try {
    const sendRes = await fetch(sendUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_slug: clientSlug }),
    });

    console.log(`[supabase-webhook ${TRACE_ID}] Send response status:`, sendRes.status);
    console.log(`[supabase-webhook ${TRACE_ID}] Send response headers content-type:`, sendRes.headers.get('content-type'));

    // Read as text first so we always see what came back
    const rawText = await sendRes.text();
    console.log(`[supabase-webhook ${TRACE_ID}] Send response body (raw):`, rawText.slice(0, 2000));

    let sendData = {};
    try {
      sendData = JSON.parse(rawText);
    } catch (parseErr) {
      console.error(`[supabase-webhook ${TRACE_ID}] Could not parse response as JSON:`, parseErr.message);
    }

    if (!sendRes.ok || !sendData.success) {
      console.error(`[supabase-webhook ${TRACE_ID}] ❌ AUTO-SEND FAILED. Parsed data:`, JSON.stringify(sendData));
      return res.status(200).json({
        ok: true,
        sent: false,
        upstream_status: sendRes.status,
        upstream_body: rawText.slice(0, 500),
        parsed: sendData,
      });
    }

    console.log(`[supabase-webhook ${TRACE_ID}] ✅ Auto-sent setup email to`, sendData.email_sent_to);
    return res.status(200).json({ ok: true, sent: true, to: sendData.email_sent_to });
  } catch (e) {
    console.error(`[supabase-webhook ${TRACE_ID}] ❌ Send exception:`, e && e.stack ? e.stack : e);
    return res.status(200).json({
      ok: true,
      sent: false,
      error: String(e.message || e),
      stack: e && e.stack ? e.stack.slice(0, 1000) : null,
    });
  }
}
