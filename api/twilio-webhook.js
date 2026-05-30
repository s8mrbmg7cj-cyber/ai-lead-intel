// =====================================================================
//  api/twilio-webhook.js  —  AI Lead Intel
//  Handles two Twilio callbacks and writes them into the ali_ spine:
//    1) Inbound SMS  (a lead replying to the text-back)  -> log + engage
//    2) Status callback (delivered / failed)             -> update status
//  Failed sends are what power the "what's broken" panel on Mission Control.
//
//  NEW endpoint — does not touch your existing /api files.
//  Register BOTH of these in Twilio pointing at this same URL:
//    • Messaging → "A message comes in"      → https://aileadintel.com/api/twilio-webhook
//    • Messaging → "status callback URL"      → https://aileadintel.com/api/twilio-webhook
// =====================================================================

import { createClient } from '@supabase/supabase-js';

// ─────────────────────────────────────────────────────────────────────
//  ▼▼▼  CONFIG — VERIFY THESE MATCH YOUR PROJECT  ▼▼▼
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_KEY; // service-role key
//  ▲▲▲  END CONFIG  ▲▲▲
// ─────────────────────────────────────────────────────────────────────

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// Twilio posts application/x-www-form-urlencoded. Vercel parses it into
// req.body for us. If you ever get an empty body, see the note at the end.
function field(body, ...keys) {
  for (const k of keys) if (body?.[k] != null) return body[k];
  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('method not allowed');

  try {
    const b = req.body || {};
    const messageStatus = field(b, 'MessageStatus', 'SmsStatus'); // present on status callbacks
    const businessNumber = field(b, 'To');     // for inbound, To = your Twilio number
    const fromNumber     = field(b, 'From');
    const twilioSid      = field(b, 'MessageSid', 'SmsSid');

    // ── CASE 1: delivery status callback (delivered / failed / undelivered) ──
    if (messageStatus && field(b, 'MessageSid')) {
      const mapped = (messageStatus === 'delivered') ? 'delivered'
                   : (messageStatus === 'failed' || messageStatus === 'undelivered') ? 'failed'
                   : 'sent';
      await supabase.from('ali_sms_messages')
        .update({ status: mapped })
        .eq('twilio_sid', field(b, 'MessageSid'));

      // surface failures on Mission Control's "what's broken"
      if (mapped === 'failed') {
        const acct = await accountByTwilioNumber(field(b, 'From'));
        await supabase.from('ali_system_status').upsert({
          account_id: acct?.id ?? null,
          component: 'Twilio (SMS)',
          status: 'warn',
          detail: `Delivery failure ${field(b,'ErrorCode') ?? ''}`.trim(),
          updated_at: new Date().toISOString(),
        }, { onConflict: 'account_id,component' });
      }
      return res.status(200).send('<Response/>'); // Twilio expects TwiML or 200
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

    // a reply means the recovered lead re-engaged — log it to the live feed
    await supabase.from('ali_events').insert({
      account_id: account.id,
      event_type: 'sms',
      title: 'Lead replied',
      subtitle: `${fromNumber} re-engaged`,
    });

    // (Optional next step: hand the inbound text to your AI to draft/booking.)
    return res.status(200).send('<Response/>');
  } catch (err) {
    console.error('twilio-webhook error:', err);
    return res.status(500).send('error');
  }
}

async function accountByTwilioNumber(num) {
  if (!num) return null;
  const { data } = await supabase
    .from('ali_accounts')
    .select('id')
    .eq('phone_number', num)
    .maybeSingle();
  return data;
}

// NOTE: if req.body arrives empty, Twilio's content-type isn't being parsed.
// On Vercel, add this file-level config to force the urlencoded parser:
//   export const config = { api: { bodyParser: true } };
// (Most setups parse it automatically; only add if needed.)
