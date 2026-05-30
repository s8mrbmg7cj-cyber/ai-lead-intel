// =====================================================================
//  api/vapi-webhook.js  —  AI Lead Intel   (ESM — matches "type":"module")
//  Receives Vapi call events and writes them into the ali_ event spine.
//  A missed call that gets a text-back is marked `recovered`, which fires
//  the database trigger that logs Revenue Saved automatically.
//
//  Webhook URL to register in Vapi:  https://aileadintel.com/api/vapi-webhook
// =====================================================================

import { createClient } from '@supabase/supabase-js';

// Env vars (read here, but the client is built lazily inside the handler,
// so a missing/unredeployed var can NEVER crash the module at load time).
const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;   // service-role key (bypasses RLS)
const VAPI_WEBHOOK_SECRET  = process.env.VAPI_WEBHOOK_SECRET;    // optional shared secret

let _sb = null;
function db() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY env var (check Vercel + Redeploy)');
  }
  if (!_sb) _sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
  return _sb;
}

// ── Map the Vapi payload → our fields. Adjust if your assistant differs. ──
function readEvent(body) {
  const m = body?.message ?? body ?? {};
  return {
    type:           m.type,
    vapiCallId:     m.call?.id ?? m.callId ?? null,
    callerNumber:   m.customer?.number ?? m.call?.customer?.number ?? null,
    businessNumber: m.phoneNumber?.number ?? m.call?.phoneNumberId ?? null,
    endedReason:    m.endedReason ?? m.call?.endedReason ?? null,
    durationSec:    Math.round(m.durationSeconds ?? m.call?.durationSeconds ?? 0) || null,
    startedAt:      m.startedAt ?? m.call?.startedAt ?? new Date().toISOString(),
  };
}

const MISSED_REASONS = new Set([
  'customer-did-not-answer', 'no-answer', 'voicemail',
  'customer-busy', 'assistant-not-found', 'pipeline-error',
  'customer-ended-call-early', 'silence-timed-out',
]);
function classifyCall(endedReason) {
  if (!endedReason) return 'answered';
  return MISSED_REASONS.has(endedReason) ? 'missed' : 'answered';
}
function isAfterHours(d = new Date()) {
  const h = d.getHours();
  return h < 8 || h >= 18;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  if (VAPI_WEBHOOK_SECRET) {
    const sent = req.headers['x-vapi-secret'] || req.headers['authorization'];
    if (sent !== VAPI_WEBHOOK_SECRET && sent !== `Bearer ${VAPI_WEBHOOK_SECRET}`) {
      return res.status(401).json({ error: 'unauthorized' });
    }
  }

  try {
    const supabase = db();                 // env checked here; errors are returned, not silent
    const ev = readEvent(req.body);

    if (ev.type && ev.type !== 'end-of-call-report') {
      return res.status(200).json({ ok: true, ignored: ev.type });
    }

    const { data: account, error: acctErr } = await supabase
      .from('ali_accounts')
      .select('id, phone_number')
      .eq('phone_number', ev.businessNumber)
      .maybeSingle();
    if (acctErr) throw acctErr;

    if (!account) {
      console.warn('vapi-webhook: no ali_accounts row for number', ev.businessNumber);
      return res.status(200).json({ ok: true, note: 'no matching account', dialed: ev.businessNumber });
    }

    const status = classifyCall(ev.endedReason);

    const { data: call, error: callErr } = await supabase
      .from('ali_calls')
      .insert({
        account_id:    account.id,
        vapi_call_id:  ev.vapiCallId,
        caller_number: ev.callerNumber,
        status,
        is_after_hours: isAfterHours(),
        started_at:    ev.startedAt,
        duration_sec:  ev.durationSec,
      })
      .select('id')
      .single();
    if (callErr) throw callErr;

    if (status === 'missed' && ev.callerNumber) {
      const recoveredAt = new Date();
      const startedAt = new Date(ev.startedAt);
      const responseSec = Math.max(0, Math.round((recoveredAt - startedAt) / 1000)) || 5;

      try {
        // send FROM this client's own number (multi-tenant), not a global one
        await sendTextBack(account.phone_number, ev.callerNumber);
        await supabase.from('ali_sms_messages').insert({
          account_id: account.id, direction: 'outbound', contact_number: ev.callerNumber,
          status: 'sent', related_call_id: call.id,
        });
      } catch (smsErr) {
        console.error('text-back failed:', smsErr.message);
      }

      const { error: updErr } = await supabase
        .from('ali_calls')
        .update({ recovered: true, recovered_at: recoveredAt.toISOString(), response_sec: responseSec })
        .eq('id', call.id);
      if (updErr) throw updErr;
    }

    return res.status(200).json({ ok: true, call_id: call.id, status });
  } catch (err) {
    console.error('vapi-webhook error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// Missed-call text-back sender (Twilio). `from` = the client's own number.
async function sendTextBack(fromNumber, toNumber) {
  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from  = fromNumber || process.env.TWILIO_PHONE_NUMBER;   // env is test fallback only
  if (!sid || !token || !from) throw new Error('Twilio creds or client from-number missing');

  const body =
    "Hi! Sorry we missed your call — this is our front desk. " +
    "How can we help? Reply here and we'll get you taken care of.";

  const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ To: toNumber, From: from, Body: body }),
  });
  if (!resp.ok) throw new Error(`Twilio ${resp.status}: ${await resp.text()}`);
  return resp.json();
}
