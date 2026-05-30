// =====================================================================
//  api/vapi-webhook.js  —  AI Lead Intel
//  Receives Vapi call events and writes them into the ali_ event spine.
//  A missed call that gets a text-back is marked `recovered`, which fires
//  the database trigger that logs Revenue Saved automatically.
//
//  NEW endpoint — does not touch any of your existing /api files.
//  Webhook URL to register in Vapi:  https://aileadintel.com/api/vapi-webhook
// =====================================================================

import { createClient } from '@supabase/supabase-js';

// ─────────────────────────────────────────────────────────────────────
//  ▼▼▼  CONFIG — VERIFY THESE TWO LINES MATCH YOUR PROJECT  ▼▼▼
//  These are the standard Vercel + Supabase env-var names. If your other
//  /api files use different names, change them here (or tell me and I'll
//  align it to your existing code).
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_KEY; // MUST be the service-role key (bypasses RLS)
//  Optional: shared secret so only Vapi can call this endpoint.
const VAPI_WEBHOOK_SECRET = process.env.VAPI_WEBHOOK_SECRET; // set the same value in Vapi's webhook config
//  ▲▲▲  END CONFIG  ▲▲▲
// ─────────────────────────────────────────────────────────────────────

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// ─────────────────────────────────────────────────────────────────────
//  MAP YOUR VAPI PAYLOAD → our fields.
//  Vapi posts { message: { type, call, customer, phoneNumber, endedReason, ... } }.
//  Adjust these getters if your assistant sends a different shape.
// ─────────────────────────────────────────────────────────────────────
function readEvent(body) {
  const m = body?.message ?? body ?? {};
  return {
    type:           m.type,                                   // e.g. 'end-of-call-report', 'status-update'
    vapiCallId:     m.call?.id ?? m.callId ?? null,
    callerNumber:   m.customer?.number ?? m.call?.customer?.number ?? null,
    businessNumber: m.phoneNumber?.number ?? m.call?.phoneNumberId ?? null, // the number the customer dialed
    endedReason:    m.endedReason ?? m.call?.endedReason ?? null,
    durationSec:    Math.round(m.durationSeconds ?? m.call?.durationSeconds ?? 0) || null,
    startedAt:      m.startedAt ?? m.call?.startedAt ?? new Date().toISOString(),
  };
}

// Decide whether a finished call counts as missed. EDIT to match how your
// receptionist behaves — these are sensible defaults.
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
  const h = d.getHours();        // server time; swap to the account's timezone when you store one
  return h < 8 || h >= 18;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  // optional shared-secret check
  if (VAPI_WEBHOOK_SECRET) {
    const sent = req.headers['x-vapi-secret'] || req.headers['authorization'];
    if (sent !== VAPI_WEBHOOK_SECRET && sent !== `Bearer ${VAPI_WEBHOOK_SECRET}`) {
      return res.status(401).json({ error: 'unauthorized' });
    }
  }

  try {
    const ev = readEvent(req.body);

    // We only act on the final report so we don't double-log a call.
    if (ev.type && ev.type !== 'end-of-call-report') {
      return res.status(200).json({ ok: true, ignored: ev.type });
    }

    // Find which business this call belongs to (by the dialed number).
    const { data: account, error: acctErr } = await supabase
      .from('ali_accounts')
      .select('id, phone_number')
      .eq('phone_number', ev.businessNumber)
      .maybeSingle();

    if (acctErr) throw acctErr;
    if (!account) {
      // No matching account — log it but don't fail the webhook.
      console.warn('vapi-webhook: no ali_accounts row for number', ev.businessNumber);
      return res.status(200).json({ ok: true, note: 'no matching account' });
    }

    const status = classifyCall(ev.endedReason);

    // 1) Log the call.
    const { data: call, error: callErr } = await supabase
      .from('ali_calls')
      .insert({
        account_id:    account.id,
        vapi_call_id:  ev.vapiCallId,
        caller_number: ev.callerNumber,
        status,                                   // 'answered' | 'missed'
        is_after_hours: isAfterHours(),
        started_at:    ev.startedAt,
        duration_sec:  ev.durationSec,
      })
      .select('id')
      .single();
    if (callErr) throw callErr;

    // 2) If missed, fire the text-back and mark recovered.
    //    Marking recovered = true triggers the Revenue Saved calculation.
    if (status === 'missed' && ev.callerNumber) {
      const recoveredAt = new Date();
      const startedAt = new Date(ev.startedAt);
      const responseSec = Math.max(0, Math.round((recoveredAt - startedAt) / 1000)) || 5;

      // ── send the missed-call text-back via Twilio (optional but recommended) ──
      // Comment this block out if your existing system already sends the text.
      try {
        await sendTextBack(account.id, ev.callerNumber);
        await supabase.from('ali_sms_messages').insert({
          account_id: account.id, direction: 'outbound', contact_number: ev.callerNumber,
          status: 'sent', related_call_id: call.id,
        });
      } catch (smsErr) {
        console.error('text-back failed:', smsErr.message);
      }

      // mark recovered → DB trigger logs the revenue + activity event
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

// ─────────────────────────────────────────────────────────────────────
//  Missed-call text-back sender (Twilio).
//  Verify these env-var names match your project, or remove this and let
//  your existing missed-call-text-back system handle the send.
// ─────────────────────────────────────────────────────────────────────
async function sendTextBack(accountId, toNumber) {
  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from  = process.env.TWILIO_PHONE_NUMBER;          // your business's Twilio number
  if (!sid || !token || !from) throw new Error('Twilio env vars not set');

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
