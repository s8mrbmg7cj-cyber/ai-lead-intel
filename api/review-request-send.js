// api/review-request-send.js
//
// Cron target for the Google Review Request add-on. Jobs picked by ?task= :
//   task=auto    (default) — send, plus the digest when it's Monday 09:00 UTC
//   task=send              — send due first-asks, then any due follow-ups only
//   task=summary           — weekly sent/clicked/opted-out digest to the owner
//
// Scheduled in vercel.json:
//   /api/review-request-send   daily 09:00 UTC
//
// auto is the DEFAULT (not a ?task= param) so the cron entry needs no query
// string — a dropped query string would silently disable the weekly digest.
// It folds two jobs into one slot: Vercel Hobby allows only two crons, and
// only daily schedules, so the config has to work there.
//
// AUTH: Vercel cron sends Authorization: Bearer <CRON_SECRET>.
//       Manual triggers require x-admin-token: <ADMIN_API_TOKEN>.
//       (Same gate as api/send-report.js.)
//
// IDEMPOTENCY — the thing that matters most here. Texting a customer twice is
// worse than not texting them at all: it reads as spam, invites a STOP, and on
// a 10DLC campaign it counts against the brand. So every row is CLAIMED with a
// conditional PATCH before it is sent. PostgREST turns
//   PATCH review_requests?id=eq.X&status=eq.pending
// into a single UPDATE ... WHERE id = X AND status = 'pending', which is atomic
// in Postgres. Two overlapping cron runs race on that UPDATE; exactly one gets a
// row back, the loser gets [] and skips. The state is written BEFORE the send,
// never after, so a crash mid-send loses a message rather than duplicating one.

export const config = { maxDuration: 60 };

import {
  sb, enc, sendSms, senderFor, isOptedOut, reportError, BASE_URL,
  buildReviewMessage, buildFollowUpMessage,
} from '../lib/review-requests.js';

const BATCH = 50;             // rows per run — well inside maxDuration
const STALE_CLAIM_MIN = 15;   // a 'sending' row older than this was orphaned

const CLIENT_FIELDS =
  'id,client_slug,business_name,twilio_number,notify_email,ntfy_topic,status,active,' +
  'review_requests_enabled,review_followup_enabled,review_followup_days';

// 'paused' is what stripe-webhook.js and paypal-webhook.js write on a failed
// payment. api/vapi/call-ended.js already refuses to work for a paused client;
// omitting it here let a non-paying account keep sending texts on our 10DLC
// brand.
const BLOCKED_STATUSES = new Set(['cancelled', 'canceled', 'paused']);

function isSendable(client) {
  if (!client) return false;
  if (BLOCKED_STATUSES.has(String(client.status || '').toLowerCase())) return false;
  if (client.active === false) return false;
  return client.review_requests_enabled === true;
}

async function markFailed(id, error) {
  await sb(`review_requests?id=eq.${enc(id)}`, {
    method: 'PATCH',
    prefer: 'return=minimal',
    body: { status: 'failed', last_error: String(error || '').slice(0, 300) },
  });
}

// ─────────────────────────────────────────────
// ORPHANED CLAIMS
// ─────────────────────────────────────────────
// A row stuck in 'sending' means a run died between claiming and recording the
// result. If it has a twilio_sid the text DID go out — settle it as sent. If it
// doesn't, nothing was sent, so it's safe to put back in the queue.

async function requeueStaleClaims() {
  const cutoff = new Date(Date.now() - STALE_CLAIM_MIN * 60000).toISOString();

  // sent_at must be stamped here too. A 'sending' row never got one (it is
  // written in the same PATCH as status='sent'), and the follow-up scheduler
  // does date maths on sent_at — a null there produces NaN, every comparison
  // against NaN is false, and the follow-up fires immediately instead of days
  // later. claimed_at is the honest approximation of when it went out.
  const settled = await sb(
    `review_requests?status=eq.sending&claimed_at=lt.${enc(cutoff)}&twilio_sid=not.is.null`,
    { method: 'PATCH', prefer: 'return=representation', body: { status: 'sent', sent_at: new Date().toISOString() } }
  );
  const requeued = await sb(
    `review_requests?status=eq.sending&claimed_at=lt.${enc(cutoff)}&twilio_sid=is.null`,
    { method: 'PATCH', prefer: 'return=representation', body: { status: 'pending', claimed_at: null } }
  );

  const s = Array.isArray(settled) ? settled.length : 0;
  const r = Array.isArray(requeued) ? requeued.length : 0;
  if (s || r) console.log(`[review-send] recovered orphans — settled:${s} requeued:${r}`);
  return { settled: s, requeued: r };
}

// ─────────────────────────────────────────────
// FIRST ASK
// ─────────────────────────────────────────────

async function sendDueRequests() {
  const now = new Date().toISOString();
  const due = await sb(
    `review_requests?select=*,clients(${CLIENT_FIELDS})` +
    `&status=eq.pending&scheduled_for=lte.${enc(now)}` +
    `&order=scheduled_for.asc&limit=${BATCH}`
  );
  if (!Array.isArray(due) || due.length === 0) return { considered: 0, sent: 0, skipped: 0, failed: 0 };

  let sent = 0, skipped = 0, failed = 0;

  for (const row of due) {
    const client = row.clients;
    try {
      if (!isSendable(client)) {
        await markFailed(row.id, 'client_inactive_or_disabled');
        skipped++;
        continue;
      }

      // Last-chance opt-out check. The ledger may have gained an entry between
      // queueing and now, and it always wins.
      if (await isOptedOut(row.customer_phone, client.id)) {
        await sb(`review_requests?id=eq.${enc(row.id)}`, {
          method: 'PATCH',
          prefer: 'return=minimal',
          body: { status: 'opted_out', opted_out_at: new Date().toISOString() },
        });
        skipped++;
        continue;
      }

      const from = senderFor(client);
      if (!from) {
        await markFailed(row.id, 'no_sender_number');
        failed++;
        continue;
      }

      // ── CLAIM (atomic) ──
      const claimed = await sb(`review_requests?id=eq.${enc(row.id)}&status=eq.pending`, {
        method: 'PATCH',
        prefer: 'return=representation',
        body: { status: 'sending', claimed_at: new Date().toISOString() },
      });
      if (!Array.isArray(claimed) || claimed.length === 0) {
        // Another run got there first. Not an error.
        skipped++;
        continue;
      }

      const message = buildReviewMessage({
        businessName: client.business_name,
        customerName: row.customer_name,
        link: `${BASE_URL}/r/${row.click_token}`,
      });

      const result = await sendSms({ to: row.customer_phone, from, body: message });

      if (result.ok) {
        // Record the SID on its OWN write, first. It is the only proof the text
        // actually left. If this process dies on the very next line the row is
        // still 'sending', but the orphan sweep now sees a sid and settles it as
        // sent instead of requeueing it and texting the customer twice.
        let sidStored = true;
        try {
          await sb(`review_requests?id=eq.${enc(row.id)}`, {
            method: 'PATCH',
            prefer: 'return=minimal',
            body: { twilio_sid: result.sid },
          });
        } catch (_) {
          sidStored = false;
        }

        // If that write failed the process is still alive, so fold the sid into
        // the status write rather than losing it. (Doing this unconditionally
        // would defeat the point of the separate write above.)
        const statusPatch = { status: 'sent', sent_at: new Date().toISOString(), last_error: null };
        if (!sidStored) statusPatch.twilio_sid = result.sid;

        await sb(`review_requests?id=eq.${enc(row.id)}`, {
          method: 'PATCH',
          prefer: 'return=minimal',
          body: statusPatch,
        });
        sent++;
      } else {
        await markFailed(row.id, result.error);
        failed++;
      }
    } catch (err) {
      await reportError({ action: 'review-send/first', error: err, clientSlug: client && client.client_slug });
      try { await markFailed(row.id, err.message); } catch (_) {}
      failed++;
    }
  }

  return { considered: due.length, sent, skipped, failed };
}

// ─────────────────────────────────────────────
// FOLLOW-UP (opt-in, one only, ever)
// ─────────────────────────────────────────────

async function sendDueFollowUps() {
  // Broad pull at the shortest plausible delay, then filter per client — the
  // wait is a per-client setting so it can't live in the query.
  const cutoff = new Date(Date.now() - 24 * 3600000).toISOString();
  const candidates = await sb(
    `review_requests?select=*,clients(${CLIENT_FIELDS})` +
    `&status=eq.sent&follow_up_sent_at=is.null&clicked_at=is.null&sent_at=lte.${enc(cutoff)}` +
    `&order=sent_at.asc&limit=${BATCH}`
  );
  if (!Array.isArray(candidates) || candidates.length === 0) return { considered: 0, sent: 0, skipped: 0, failed: 0 };

  let sent = 0, skipped = 0, failed = 0;

  for (const row of candidates) {
    const client = row.clients;
    try {
      if (!isSendable(client) || client.review_followup_enabled !== true) { skipped++; continue; }

      const waitDays = Math.max(1, Number(client.review_followup_days) || 3);
      const sentAtMs = row.sent_at ? new Date(row.sent_at).getTime() : NaN;
      // Never send on an unknown send time. NaN fails every comparison, so a
      // naive `Date.now() < dueAt` would read as "due" and fire instantly.
      if (!Number.isFinite(sentAtMs)) { skipped++; continue; }
      if (Date.now() < sentAtMs + waitDays * 86400000) { skipped++; continue; }

      if (await isOptedOut(row.customer_phone, client.id)) {
        await sb(`review_requests?id=eq.${enc(row.id)}`, {
          method: 'PATCH',
          prefer: 'return=minimal',
          body: { status: 'opted_out', opted_out_at: new Date().toISOString() },
        });
        skipped++;
        continue;
      }

      const from = senderFor(client);
      if (!from) { skipped++; continue; }

      // ── CLAIM: stamping follow_up_sent_at is itself the lock, so this row can
      // never qualify for a follow-up a second time. ──
      const claimed = await sb(
        `review_requests?id=eq.${enc(row.id)}&follow_up_sent_at=is.null&clicked_at=is.null`,
        { method: 'PATCH', prefer: 'return=representation', body: { follow_up_sent_at: new Date().toISOString() } }
      );
      if (!Array.isArray(claimed) || claimed.length === 0) { skipped++; continue; }

      const message = buildFollowUpMessage({
        businessName: client.business_name,
        customerName: row.customer_name,
        link: `${BASE_URL}/r/${row.click_token}`,
      });

      const result = await sendSms({ to: row.customer_phone, from, body: message });
      if (result.ok) {
        sent++;
      } else {
        await sb(`review_requests?id=eq.${enc(row.id)}`, {
          method: 'PATCH',
          prefer: 'return=minimal',
          body: { last_error: String(result.error || '').slice(0, 300) },
        });
        failed++;
      }
    } catch (err) {
      await reportError({ action: 'review-send/followup', error: err, clientSlug: client && client.client_slug });
      failed++;
    }
  }

  return { considered: candidates.length, sent, skipped, failed };
}

// ─────────────────────────────────────────────
// WEEKLY OWNER SUMMARY
// ─────────────────────────────────────────────

async function sendWeeklySummaries() {
  const since = new Date(Date.now() - 7 * 86400000).toISOString();

  const clients = await sb(`clients?select=${CLIENT_FIELDS}&review_requests_enabled=is.true`);
  if (!Array.isArray(clients) || clients.length === 0) return { clients: 0, notified: 0 };

  let notified = 0;

  for (const client of clients) {
    try {
      if (!isSendable(client)) continue;

      const rows = await sb(
        `review_requests?select=status,clicked_at&client_id=eq.${enc(client.id)}&created_at=gte.${enc(since)}`
      );
      if (!Array.isArray(rows) || rows.length === 0) continue;

      const counts = {
        sent: rows.filter((r) => ['sent', 'clicked'].includes(r.status)).length,
        clicked: rows.filter((r) => r.clicked_at).length,
        optedOut: rows.filter((r) => r.status === 'opted_out').length,
        pending: rows.filter((r) => ['pending', 'sending'].includes(r.status)).length,
      };

      const biz = client.business_name || 'your business';
      const line = `${counts.sent} review requests sent · ${counts.clicked} opened your Google page · ${counts.optedOut} opted out`;

      const topic = client.ntfy_topic || process.env.NTFY_TOPIC;
      if (topic) {
        try {
          await fetch('https://ntfy.sh', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              topic,
              title: `⭐ ${biz} — review requests this week`,
              message: `${line}\n\n${counts.pending} still queued to go out.`,
              priority: 3,
              tags: ['star'],
            }),
          });
        } catch (_) {}
      }

      const resendKey = process.env.RESEND_API_KEY;
      if (resendKey && client.notify_email) {
        try {
          await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              from: 'AI Lead Intel <hello@aileadintel.com>',
              to: [client.notify_email],
              replyTo: 'hello@aileadintel.com',
              subject: `Your review requests this week — ${counts.clicked} customers opened your Google page`,
              html: `
  <div style="background:#f6f7f9;padding:24px 12px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
    <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:24px;">
      <div style="font-size:18px;font-weight:700;color:#111827;">Review requests — last 7 days</div>
      <div style="font-size:14px;color:#374151;line-height:1.6;margin-top:10px;">Here's how ${escapeHtml(biz)} did asking for Google reviews this week.</div>
      <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin-top:16px;border-collapse:collapse;">
        <tr><td style="padding:7px 0;font-size:13px;color:#6b7280;width:220px;">Requests sent</td><td style="padding:7px 0;font-size:14px;color:#111827;font-weight:600;">${counts.sent}</td></tr>
        <tr><td style="padding:7px 0;font-size:13px;color:#6b7280;">Opened your Google page</td><td style="padding:7px 0;font-size:14px;color:#111827;font-weight:600;">${counts.clicked}</td></tr>
        <tr><td style="padding:7px 0;font-size:13px;color:#6b7280;">Opted out</td><td style="padding:7px 0;font-size:14px;color:#111827;font-weight:600;">${counts.optedOut}</td></tr>
        <tr><td style="padding:7px 0;font-size:13px;color:#6b7280;">Still queued</td><td style="padding:7px 0;font-size:14px;color:#111827;font-weight:600;">${counts.pending}</td></tr>
      </table>
      <div style="font-size:13px;color:#9ca3af;margin-top:18px;">Mark more jobs complete in your dashboard to keep the reviews coming.</div>
    </div>
  </div>`,
            }),
          });
        } catch (_) {}
      }

      notified++;
    } catch (err) {
      await reportError({ action: 'review-send/summary', error: err, clientSlug: client && client.client_slug });
    }
  }

  return { clients: clients.length, notified };
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

// ─────────────────────────────────────────────
// HANDLER
// ─────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  // Each secret must be NON-EMPTY before it can grant access. An unset
  // CRON_SECRET would otherwise make the comparison string "Bearer undefined",
  // which anyone could send verbatim to drive the SMS sender.
  const cronSecret = process.env.CRON_SECRET;
  const adminSecret = process.env.ADMIN_API_TOKEN;
  const authHeader = req.headers['authorization'] || '';
  const isVercelCron = !!cronSecret && authHeader === `Bearer ${cronSecret}`;
  const isAdmin = !!adminSecret && (req.headers['x-admin-token'] || '') === adminSecret;
  if (!isVercelCron && !isAdmin) {
    console.warn('[review-send] 🚫 unauthorized');
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  const task = String(req.query?.task || 'auto').toLowerCase();

  try {
    if (task === 'summary') {
      const summary = await sendWeeklySummaries();
      console.log('[review-send] summary', summary);
      return res.status(200).json({ success: true, task, ...summary });
    }

    const recovered = await requeueStaleClaims();
    const first = await sendDueRequests();
    const followUp = await sendDueFollowUps();

    // task=auto folds the weekly digest into this same run so the whole add-on
    // needs ONE cron slot instead of two (Vercel Hobby only allows two crons
    // total, daily-only). Gated on Monday 09:00 UTC so it fires exactly once a
    // week whether this endpoint is scheduled daily or hourly — without that
    // hour check an hourly schedule would email the owner 24 digests.
    let summary = null;
    if (task === 'auto') {
      const now = new Date();
      if (now.getUTCDay() === 1 && now.getUTCHours() === 9) {
        summary = await sendWeeklySummaries();
        console.log('[review-send] summary', summary);
      }
    }

    console.log('[review-send] first', first, 'followUp', followUp);
    return res.status(200).json({ success: true, task, recovered, first, followUp, summary });
  } catch (err) {
    await reportError({ action: `review-send/${task}`, error: err });
    return res.status(500).json({ success: false, error: 'Send run failed' });
  }
}
