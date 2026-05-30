// =====================================================================
//  api/twilio-webhook.js  —  AI Lead Intel   (ESM — matches "type":"module")
//  Handles two Twilio callbacks and writes them into the ali_ spine:
//    1) Inbound SMS  (a lead replying)        -> log + activity event
//    2) Status callback (delivered / failed)  -> update status / flag breakage
//
//  Register BOTH in Twilio pointing at this same URL:
//    • Messaging "A message comes in"  → https://aileadintel.com/api/twilio-webhook
//    • Messaging "status callback URL" → https://aileadintel.com/api/twilio-webhook
// =====================================================================

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

let _sb = null;
function db() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY env var (check Vercel + Redeploy)');
  }
  if (!_sb) _sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
  return _sb;
}

function field(body, ...keys) {
  for (const k of keys) if (body?.[k] != null) return body[k];
  return null;
}

async function accountByTwilioNumber(num) {
  if (!num) return null;
  const { data } = await db()
    .from('ali_accounts')
    .select('id')
    .eq('phone_number', num)
    .maybeSingle();
  return data;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('method not allowed');

  try {
    const supabase = db();
    const b = req.body || {};
    const messageStatus  = field(b, 'MessageStatus', 'SmsStatus');
    const businessNumber = field(b, 'To');
    const fromNumber     = field(b, 'From');
    const twilioSid      = field(b, 'MessageSid', 'SmsSid');

    // ── CASE 1: delivery status callback ──
    if (messageStatus && field(b, 'MessageSid')) {
      const mapped = (messageStatus === 'delivered') ? 'delivered'
                   : (messageStatus === 'failed' || messageStatus === 'undelivered') ? 'failed'
                   : 'sent';
      await supabase.from('ali_sms_messages').update({ status: mapped }).eq('twilio_sid', field(b, 'MessageSid'));

      if (mapped === 'failed') {
        const acct = await accountByTwilioNumber(field(b, 'From'));
        await supabase.from('ali_system_status').upsert({
          account_id: acct?.id ?? null,
          component: 'Twilio (SMS)',
          status: 'warn',
          detail: `Delivery failure ${field(b, 'ErrorCode') ?? ''}`.trim(),
          updated_at: new Date().toISOString(),
        }, { onConflict: 'account_id,component' });
      }
      return res.status(200).send('<Response/>');
    }

    // ── CASE 2: inbound SMS — a lead is replying ──
    const account = await accountByTwilioNumber(businessNumber);
    if (!account) {
      console.warn('twilio-webhook: no ali_accounts row for number', businessNumber);
      return res.status(200).send('<Response/>');
    }

    await supabase.from('ali_sms_messages').insert({
      account_id: account.id,
      twilio_sid: twilioSid,
      direction: 'inbound',
      contact_number: fromNumber,
      status: 'delivered',
    });

    await supabase.from('ali_events').insert({
      account_id: account.id,
      event_type: 'sms',
      title: 'Lead replied',
      subtitle: `${fromNumber} re-engaged`,
    });

    return res.status(200).send('<Response/>');
  } catch (err) {
    console.error('twilio-webhook error:', err);
    return res.status(500).send('error: ' + err.message);
  }
}
