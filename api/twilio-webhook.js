// =====================================================================
//  api/twilio-webhook.js  —  AI Lead Intel   (ESM, REST-only)
//  Writes Twilio events into the ali_ spine using Supabase's REST API
//  via plain fetch. NO @supabase/supabase-js, NO Realtime, NO WebSocket.
//
//  Register BOTH in Twilio pointing at this same URL:
//    • Messaging "A message comes in"  → https://aileadintel.com/api/twilio-webhook
//    • Messaging "status callback URL" → https://aileadintel.com/api/twilio-webhook
// =====================================================================

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;   // service-role key

// Minimal Supabase REST helper (PostgREST). No client library = no realtime.
async function sb(path, { method = 'GET', body, prefer } = {}) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY env var (check Vercel + Redeploy)');
  }
  const headers = {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
  };
  if (prefer) headers.Prefer = prefer;
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  if (!resp.ok) throw new Error(`Supabase REST ${resp.status}: ${await resp.text()}`);
  const txt = await resp.text();
  return txt ? JSON.parse(txt) : null;
}

function field(body, ...keys) {
  for (const k of keys) if (body?.[k] != null) return body[k];
  return null;
}

async function accountByNumber(num) {
  if (!num) return null;
  const rows = await sb(`ali_accounts?select=id&phone_number=eq.${encodeURIComponent(num)}&limit=1`);
  return rows?.[0] ?? null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('method not allowed');

  try {
    const b = req.body || {};
    const messageStatus  = field(b, 'MessageStatus', 'SmsStatus');
    const businessNumber = field(b, 'To');
    const fromNumber     = field(b, 'From');
    const twilioSid      = field(b, 'MessageSid', 'SmsSid');

    // ── CASE 1: delivery status callback (delivered / failed) ──
    if (messageStatus && field(b, 'MessageSid')) {
      const mapped = (messageStatus === 'delivered') ? 'delivered'
                   : (messageStatus === 'failed' || messageStatus === 'undelivered') ? 'failed'
                   : 'sent';
      await sb(`ali_sms_messages?twilio_sid=eq.${encodeURIComponent(field(b, 'MessageSid'))}`,
        { method: 'PATCH', body: { status: mapped }, prefer: 'return=minimal' });

      if (mapped === 'failed') {
        const acct = await accountByNumber(field(b, 'From'));
        await sb('ali_system_status?on_conflict=account_id,component', {
          method: 'POST',
          prefer: 'resolution=merge-duplicates,return=minimal',
          body: {
            account_id: acct?.id ?? null,
            component: 'Twilio (SMS)',
            status: 'warn',
            detail: `Delivery failure ${field(b, 'ErrorCode') ?? ''}`.trim(),
            updated_at: new Date().toISOString(),
          },
        });
      }
      return res.status(200).send('<Response/>');
    }

    // ── CASE 2: inbound SMS — a lead is replying ──
    const account = await accountByNumber(businessNumber);
    if (!account) {
      console.warn('twilio-webhook: no ali_accounts row for number', businessNumber);
      return res.status(200).send('<Response/>');
    }

    await sb('ali_sms_messages', {
      method: 'POST', prefer: 'return=minimal',
      body: {
        account_id: account.id, twilio_sid: twilioSid,
        direction: 'inbound', contact_number: fromNumber, status: 'delivered',
      },
    });

    await sb('ali_events', {
      method: 'POST', prefer: 'return=minimal',
      body: {
        account_id: account.id, event_type: 'sms',
        title: 'Lead replied', subtitle: `${fromNumber} re-engaged`,
      },
    });

    return res.status(200).send('<Response/>');
  } catch (err) {
    console.error('twilio-webhook error:', err);
    return res.status(500).send('error: ' + err.message);
  }
}
