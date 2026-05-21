// /api/supabase-webhook.js
//
// Receives Supabase webhook events for changes to public.clients.
// When ai_setup_status transitions to 'ready' AND no setup email has been
// sent yet, automatically triggers the setup email.
//
// This is what turns the manual "click send" workflow into a hands-off automation.
//
// === SUPABASE WEBHOOK CONFIG (do this once in Supabase) ===
//
// 1. Supabase Dashboard → Database → Webhooks → "Create a new hook"
// 2. Name: send-setup-email-on-ready
// 3. Table: public.clients
// 4. Events: ☑ Update
// 5. Method: POST
// 6. URL: https://aileadintel.com/api/supabase-webhook
// 7. HTTP Headers: add  x-webhook-secret: <pick a long random string>
//    (then add SUPABASE_WEBHOOK_SECRET with the same value to Vercel env vars)
// 8. Save
//
// Done — Supabase will call this endpoint on every client row update.

const SITE_URL = 'https://aileadintel.com';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'OPTIONS') return res.status(200).json({ ok: true });
  if (req.method !== 'POST') return res.status(405).json({ ok: false });

  // ===== AUTH =====
  const expectedSecret = process.env.SUPABASE_WEBHOOK_SECRET;
  if (expectedSecret) {
    const receivedSecret = req.headers['x-webhook-secret'];
    if (receivedSecret !== expectedSecret) {
      console.warn('[supabase-webhook] Invalid secret');
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
  }

  // ===== PARSE PAYLOAD =====
  let body = req.body || {};
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (_) { body = {}; }
  }

  // Supabase webhook payload shape:
  // {
  //   type: 'INSERT' | 'UPDATE' | 'DELETE',
  //   table: 'clients',
  //   schema: 'public',
  //   record: { ...new row },
  //   old_record: { ...old row } (only for UPDATE/DELETE)
  // }

  const eventType = body.type || body.event_type;
  const table = body.table;
  const newRow = body.record || body.new || {};
  const oldRow = body.old_record || body.old || {};

  if (table !== 'clients') {
    return res.status(200).json({ ok: true, skipped: 'not clients table' });
  }

  if (eventType !== 'UPDATE') {
    return res.status(200).json({ ok: true, skipped: `event is ${eventType}` });
  }

  const newStatus = (newRow.ai_setup_status || '').toLowerCase();
  const oldStatus = (oldRow.ai_setup_status || '').toLowerCase();

  // Only fire when status JUST transitioned to 'ready'
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

  // ===== IDEMPOTENCY: check if setup email already sent =====
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY;

  if (supabaseUrl && supabaseKey && newRow.id) {
    try {
      const checkRes = await fetch(
        `${supabaseUrl}/rest/v1/activity_log?client_id=eq.${newRow.id}&action=eq.setup_email_sent&select=id&limit=1`,
        {
          headers: {
            apikey: supabaseKey,
            Authorization: `Bearer ${supabaseKey}`,
          },
        }
      );
      if (checkRes.ok) {
        const rows = await checkRes.json();
        if (rows && rows.length > 0) {
          console.log('[supabase-webhook] Setup email already sent for client', newRow.id);
          return res.status(200).json({ ok: true, skipped: 'already sent' });
        }
      }
    } catch (e) {
      console.error('[supabase-webhook] Idempotency check failed:', e);
      // Continue anyway — better to risk a duplicate than skip a real send
    }
  }

  // ===== TRIGGER THE SEND =====
  try {
    const sendRes = await fetch(`${SITE_URL}/api/send-setup-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_slug: clientSlug }),
    });
    const sendData = await sendRes.json().catch(() => ({}));

    if (!sendRes.ok || !sendData.success) {
      console.error('[supabase-webhook] Auto-send failed:', sendData);
      return res.status(200).json({ ok: true, sent: false, error: sendData.error });
    }

    console.log('[supabase-webhook] Auto-sent setup email to', sendData.email_sent_to);
    return res.status(200).json({ ok: true, sent: true, to: sendData.email_sent_to });
  } catch (e) {
    console.error('[supabase-webhook] Send exception:', e);
    return res.status(200).json({ ok: true, sent: false, error: String(e.message || e) });
  }
}
