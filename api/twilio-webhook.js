// =====================================================================
//  api/twilio-webhook.js  —  AI Lead Intel   (ESM, REST-only)
//  Writes Twilio events into the ali_ spine using Supabase's REST API
//  via plain fetch. NO @supabase/supabase-js, NO Realtime, NO WebSocket.
//
//  Register BOTH in Twilio pointing at this same URL:
//    • Messaging "A message comes in"  → https://aileadintel.com/api/twilio-webhook
//    • Messaging "status callback URL" → https://aileadintel.com/api/twilio-webhook
//
//  ALSO handles A2P 10DLC opt-out/help keywords for the Google Review Request
//  add-on (STOP / HELP). That check runs FIRST, before any lookup that could
//  bail out — an opt-out must be honoured even if the number isn't mapped to an
//  ali_accounts row.
// =====================================================================

import { toE164, classifyInbound, recordOptOut, buildStopConfirmation, buildHelpMessage, sb as reviewSb, enc as reviewEnc, reportError } from '../lib/review-requests.js';

const SUPABASE_URL         = process.env.SUPABASE_URL;
// lib/review-requests.js accepts either name; match it or half this file works
// and half throws depending on which env var happens to be set.
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY;

// The statuses Twilio sends on a delivery status callback. Anything carrying a
// Body is a real inbound message — inbound also sets SmsStatus=received, which
// is why "has a status" alone cannot be used to detect a callback.
const DELIVERY_STATES = new Set([
  'queued', 'accepted', 'scheduled', 'sending', 'sent', 'receiving',
  'delivered', 'undelivered', 'failed', 'read', 'canceled', 'cancelled',
]);

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

// ── A2P 10DLC keyword handling ──────────────────────────────────────
// Review texts go out FROM the client's own AI number, so the number the
// customer replied TO identifies the business.

function xmlEscape(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function twimlMessage(text) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${xmlEscape(text)}</Message></Response>`;
}

async function clientByAiNumber(num) {
  const e164 = toE164(num);
  if (!e164) return null;
  const rows = await reviewSb(
    `clients?select=id,client_slug,business_name,twilio_number&twilio_number=eq.${reviewEnc(e164)}&limit=1`
  );
  return Array.isArray(rows) ? rows[0] || null : null;
}

/**
 * Returns true when the message was a STOP/HELP keyword and has been fully
 * handled (a reply is already written to `res`).
 */
async function handleKeyword({ res, body, fromNumber, businessNumber }) {
  const keyword = classifyInbound(body);
  if (!keyword) return false;

  const customer = toE164(fromNumber);

  // Must not throw: a failed lookup would skip the reply entirely and the
  // customer would get a bare 500 instead of their STOP confirmation.
  let client = null;
  try {
    client = await clientByAiNumber(businessNumber);
  } catch (err) {
    console.error('[twilio-webhook] client lookup failed:', err.message);
  }
  const bizName = (client && client.business_name) || 'AI Lead Intel';

  if (keyword === 'stop') {
    // A failure anywhere in here must still produce a confirmation reply — the
    // customer's opt-out is not conditional on our database being reachable.
    // Twilio's own carrier-level block already applies; the ledger write is how
    // WE stop queueing, so a failed write gets escalated rather than swallowed.
    try {
      if (client && customer) {
        // Writes the opt-out ledger entry AND cancels every queued request for
        // this number, so nothing already in the pipe can still go out.
        await recordOptOut({ phone: customer, clientId: client.id, source: 'sms_stop' });
        console.log('[twilio-webhook] OPT-OUT recorded', customer, '→', client.client_slug);
      } else {
        // Can't map the number to a business — surface it loudly rather than
        // silently dropping an opt-out, which is a compliance failure.
        await reportError({
          action: 'twilio-webhook/stop-unmapped',
          error: `STOP from ${customer || fromNumber} to unmapped number ${businessNumber}`,
        });
      }
    } catch (err) {
      // The alert itself is best-effort — it must not be the reason the
      // customer's confirmation never gets sent.
      await reportError({
        action: 'twilio-webhook/stop-write-failed',
        error: `Could not record opt-out for ${customer || fromNumber}: ${err.message}`,
      }).catch(() => {});
    }
    res.setHeader('Content-Type', 'text/xml');
    res.status(200).send(twimlMessage(buildStopConfirmation(bizName)));
    return true;
  }

  // HELP / INFO
  console.log('[twilio-webhook] HELP request from', customer || fromNumber);
  res.setHeader('Content-Type', 'text/xml');
  res.status(200).send(twimlMessage(buildHelpMessage(bizName)));
  return true;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('method not allowed');

  try {
    const b = req.body || {};
    const messageStatus  = field(b, 'MessageStatus', 'SmsStatus');
    const businessNumber = field(b, 'To');
    const fromNumber     = field(b, 'From');
    const twilioSid      = field(b, 'MessageSid', 'SmsSid');
    const messageBody    = field(b, 'Body');

    // Twilio sends SmsStatus=received on a real INBOUND message and
    // MessageStatus=<delivery state> on a status callback. A status callback
    // never carries a Body. Discriminating on "has any status" made every
    // inbound message look like a callback, which silently disabled STOP/HELP
    // and the inbound-lead logging below.
    const statusLower      = messageStatus ? String(messageStatus).toLowerCase() : null;
    const isStatusCallback = !messageBody && statusLower !== null && DELIVERY_STATES.has(statusLower);

    // ── CASE 0: STOP / HELP keyword (A2P 10DLC) ──
    // Runs before everything else. An opt-out must be honoured even if the
    // number isn't mapped to an account.
    if (!isStatusCallback && messageBody) {
      const handled = await handleKeyword({ res, body: messageBody, fromNumber, businessNumber });
      if (handled) return;
    }

    // ── CASE 1: delivery status callback (delivered / failed) ──
    if (isStatusCallback && field(b, 'MessageSid')) {
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
