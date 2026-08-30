// api/send-report.js
//
// Starter lead report cron endpoint.
//
// Triggered by vercel.json cron schedule:
//   - Mondays at 9am UTC for weekly reports
//   - 1st of month at 9am UTC for monthly reports
//
// FLOW:
//   1. Determine "due" frequency from current day (weekly: Monday, monthly: 1st)
//   2. Pull Starter clients where report_frequency = due frequency
//   3. For each client: query calls table, aggregate stats
//   4. Email premium summary via Resend
//   5. Update last_report_sent_at
//
// AUTH:
//   Vercel cron sends Authorization: Bearer <CRON_SECRET>
//   Manual triggers require x-admin-token: <ADMIN_API_TOKEN>

import { Resend } from "resend";

// ============================================================
// HELPERS
// ============================================================

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function formatDate(d) {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/**
 * Returns the date range and label for a given frequency.
 * Weekly: last 7 days. Monthly: last 30 days (or previous calendar month).
 */
function getReportWindow(frequency) {
  const now = new Date();
  const end = new Date(now);
  const start = new Date(now);
  if (frequency === "weekly") {
    start.setUTCDate(start.getUTCDate() - 7);
    return { start, end, label: `${formatDate(start)} – ${formatDate(end)}`, period: "this week" };
  }
  // monthly
  start.setUTCDate(start.getUTCDate() - 30);
  return { start, end, label: `${formatDate(start)} – ${formatDate(end)}`, period: "this month" };
}

/**
 * Fetch calls for a client within a date window. Returns [] if calls table
 * doesn't exist yet, doesn't crash.
 */
async function fetchCallsInWindow(clientId, start, end, supabaseUrl, supabaseKey) {
  try {
    // The calls table is keyed on client_uuid — that is the ONLY column
    // api/vapi/call-ended.js ever writes (and what the dashboard reads).
    // Querying client_id here returned zero rows, so every report shipped
    // all-zero stats.
    const url = `${supabaseUrl}/rest/v1/calls?client_uuid=eq.${encodeURIComponent(clientId)}` +
      `&created_at=gte.${start.toISOString()}` +
      `&created_at=lte.${end.toISOString()}` +
      `&select=*&order=created_at.desc&limit=500`;
    const res = await fetch(url, {
      headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
    });
    if (!res.ok) {
      console.warn(`[send-report] ⚠️ calls fetch non-OK for client ${clientId}:`, res.status);
      return [];
    }
    const rows = await res.json().catch(() => []);
    return Array.isArray(rows) ? rows : [];
  } catch (err) {
    console.warn(`[send-report] ⚠️ calls fetch exception for client ${clientId}:`, err.message);
    return [];
  }
}

/**
 * Aggregate call rows into the report's summary stats.
 * Looks at various possible field names since calls table schema isn't
 * fully locked in yet.
 */
function aggregateStats(calls) {
  let leadsCaptured = 0;
  let missedCalls = 0;
  let callbackRequests = 0;
  let bookings = 0;

  for (const c of calls) {
    const outcome = String(c.outcome || "").toLowerCase();
    const isLead = c.is_lead === true || outcome.includes("lead");
    const isMissed = c.is_missed === true || outcome.includes("missed");
    const isCallback = c.is_callback === true || outcome.includes("callback");
    const isBooking = c.is_booking === true || outcome.includes("book") || outcome.includes("appointment");

    if (isLead) leadsCaptured++;
    if (isMissed) missedCalls++;
    if (isCallback) callbackRequests++;
    if (isBooking) bookings++;
  }

  return {
    leadsCaptured,
    missedCalls,
    callbackRequests,
    bookings,
    totalCalls: calls.length,
  };
}

/**
 * Build the premium-looking report email HTML.
 */
function buildReportEmail(client, stats, windowInfo) {
  const businessName = client.business_name || "your business";
  const frequency = client.report_frequency || "monthly";
  const frequencyLabel = frequency === "weekly" ? "Weekly" : "Monthly";

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#f9fafb;">
  <div style="max-width:600px;margin:0 auto;padding:32px 20px;">
    <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:14px;overflow:hidden;">
      <!-- Header -->
      <div style="padding:32px 32px 24px;border-bottom:1px solid #f3f4f6;">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:18px;">
          <div style="width:28px;height:28px;border-radius:8px;background:linear-gradient(135deg,#ff6a00,#ff9a00);"></div>
          <strong style="font-size:13px;color:#111827;letter-spacing:-0.005em;">AI Lead Intel</strong>
        </div>
        <div style="font-family:'SF Mono',Menlo,monospace;font-size:11px;color:#ff6a00;letter-spacing:0.14em;text-transform:uppercase;font-weight:600;margin-bottom:8px;">${escapeHtml(frequencyLabel)} Lead Report</div>
        <h1 style="font-size:22px;font-weight:600;color:#111827;margin:0 0 6px 0;letter-spacing:-0.02em;line-height:1.25;">${escapeHtml(businessName)} — ${windowInfo.period}</h1>
        <p style="margin:0;font-size:13px;color:#6b7280;">${escapeHtml(windowInfo.label)}</p>
      </div>

      <!-- Stats Grid -->
      <div style="padding:28px 32px 8px;">
        <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:separate;border-spacing:8px;">
          <tr>
            <td style="width:50%;background:linear-gradient(135deg,rgba(255,106,0,0.06),transparent);border:1px solid rgba(255,106,0,0.22);border-radius:12px;padding:18px 20px;">
              <div style="font-family:'SF Mono',Menlo,monospace;font-size:10px;color:#9ca3af;letter-spacing:0.12em;text-transform:uppercase;font-weight:600;margin-bottom:8px;">Leads Captured</div>
              <div style="font-family:'SF Mono',Menlo,monospace;font-size:32px;font-weight:600;color:#ff6a00;line-height:1;letter-spacing:-0.02em;">${stats.leadsCaptured}</div>
            </td>
            <td style="width:50%;background:#f9fafb;border:1px solid #e5e7eb;border-radius:12px;padding:18px 20px;">
              <div style="font-family:'SF Mono',Menlo,monospace;font-size:10px;color:#9ca3af;letter-spacing:0.12em;text-transform:uppercase;font-weight:600;margin-bottom:8px;">Total Calls</div>
              <div style="font-family:'SF Mono',Menlo,monospace;font-size:32px;font-weight:600;color:#111827;line-height:1;letter-spacing:-0.02em;">${stats.totalCalls}</div>
            </td>
          </tr>
          <tr>
            <td style="width:50%;background:#f9fafb;border:1px solid #e5e7eb;border-radius:12px;padding:18px 20px;">
              <div style="font-family:'SF Mono',Menlo,monospace;font-size:10px;color:#9ca3af;letter-spacing:0.12em;text-transform:uppercase;font-weight:600;margin-bottom:8px;">Missed Calls</div>
              <div style="font-family:'SF Mono',Menlo,monospace;font-size:32px;font-weight:600;color:#111827;line-height:1;letter-spacing:-0.02em;">${stats.missedCalls}</div>
            </td>
            <td style="width:50%;background:#f9fafb;border:1px solid #e5e7eb;border-radius:12px;padding:18px 20px;">
              <div style="font-family:'SF Mono',Menlo,monospace;font-size:10px;color:#9ca3af;letter-spacing:0.12em;text-transform:uppercase;font-weight:600;margin-bottom:8px;">Callback Requests</div>
              <div style="font-family:'SF Mono',Menlo,monospace;font-size:32px;font-weight:600;color:#111827;line-height:1;letter-spacing:-0.02em;">${stats.callbackRequests}</div>
            </td>
          </tr>
          <tr>
            <td colspan="2" style="background:linear-gradient(135deg,rgba(52,211,153,0.06),transparent);border:1px solid rgba(52,211,153,0.25);border-radius:12px;padding:18px 20px;">
              <div style="font-family:'SF Mono',Menlo,monospace;font-size:10px;color:#9ca3af;letter-spacing:0.12em;text-transform:uppercase;font-weight:600;margin-bottom:8px;">Bookings Captured</div>
              <div style="font-family:'SF Mono',Menlo,monospace;font-size:32px;font-weight:600;color:#10b981;line-height:1;letter-spacing:-0.02em;">${stats.bookings}</div>
            </td>
          </tr>
        </table>
      </div>

      <!-- Summary message -->
      <div style="padding:20px 32px 32px;">
        ${stats.totalCalls === 0 ? `
          <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;padding:16px 18px;">
            <p style="margin:0;font-size:13.5px;color:#6b7280;line-height:1.6;">No calls captured ${windowInfo.period}. Your AI front desk is ready to answer the moment one comes in.</p>
          </div>
        ` : `
          <p style="margin:0 0 12px 0;font-size:14.5px;color:#374151;line-height:1.6;">Here's how your AI front desk performed ${windowInfo.period}. Every call answered, every lead captured.</p>
          <p style="margin:0;font-size:13.5px;color:#6b7280;line-height:1.6;">${stats.bookings > 0 ? `<strong style="color:#10b981;">${stats.bookings} booking${stats.bookings === 1 ? "" : "s"}</strong> went straight from call to calendar. ` : ""}${stats.callbackRequests > 0 ? `<strong>${stats.callbackRequests}</strong> caller${stats.callbackRequests === 1 ? "" : "s"} asked for a callback — check the lead details. ` : ""}Reply to this email if you want to upgrade to <strong>Pro</strong> for live dashboard access and call recordings.</p>
        `}
      </div>
    </div>

    <p style="text-align:center;margin:18px 0 0 0;font-size:11px;color:#9ca3af;font-family:'SF Mono',Menlo,monospace;letter-spacing:0.04em;">
      AI Lead Intel · ${escapeHtml(frequencyLabel)} report · <a href="mailto:hello@aileadintel.com" style="color:#9ca3af;">hello@aileadintel.com</a>
    </p>
  </div>
</body></html>`;
}

// ============================================================
// HANDLER
// ============================================================

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  // Auth: Vercel cron OR admin token.
  // Each secret must be NON-EMPTY before it can grant access. Without that
  // guard an unset CRON_SECRET makes the comparison string "Bearer undefined",
  // which anyone can send verbatim to trigger a full customer report run.
  const cronSecret = process.env.CRON_SECRET;
  const adminSecret = process.env.ADMIN_API_TOKEN;
  const authHeader = req.headers["authorization"] || "";
  const isVercelCron = !!cronSecret && authHeader === `Bearer ${cronSecret}`;
  const isAdmin = !!adminSecret && (req.headers["x-admin-token"] || "") === adminSecret;
  if (!isVercelCron && !isAdmin) {
    console.warn("[send-report] 🚫 unauthorized");
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }

  // Determine which frequency to send
  // - Default: based on current day (Monday = weekly, 1st = monthly)
  // - Override via ?frequency=weekly or ?frequency=monthly for testing
  const now = new Date();
  const dayOfWeek = now.getUTCDay(); // 0 = Sunday, 1 = Monday
  const dayOfMonth = now.getUTCDate();
  const queryFreq = (req.query?.frequency || "").toLowerCase();
  let frequency;
  if (queryFreq === "weekly" || queryFreq === "monthly") {
    frequency = queryFreq;
  } else if (dayOfMonth === 1) {
    frequency = "monthly";
  } else if (dayOfWeek === 1) {
    frequency = "weekly";
  } else {
    console.log("[send-report] ⏭️ not a report day, exiting");
    return res.status(200).json({ success: true, message: "Not a report day", skipped: true });
  }

  console.log(`[send-report] 📊 sending ${frequency} reports`);

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY;
  const resendKey = process.env.RESEND_API_KEY;
  if (!supabaseUrl || !supabaseKey || !resendKey) {
    console.error("[send-report] ❌ missing env vars");
    return res.status(500).json({ success: false, error: "Server misconfigured" });
  }

  // 1. Find Starter clients with matching frequency
  let clients = [];
  try {
    const url = `${supabaseUrl}/rest/v1/clients?plan=eq.starter` +
      `&report_frequency=eq.${frequency}` +
      `&active=eq.true` +
      `&select=*`;
    const lookupRes = await fetch(url, {
      headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
    });
    if (!lookupRes.ok) throw new Error(`HTTP ${lookupRes.status}`);
    clients = await lookupRes.json();
    console.log(`[send-report] 📋 found ${clients.length} ${frequency} Starter clients`);
  } catch (err) {
    console.error("[send-report] ❌ client lookup failed:", err.message);
    return res.status(500).json({ success: false, error: "Could not fetch clients" });
  }

  if (clients.length === 0) {
    return res.status(200).json({ success: true, frequency, sent: 0, skipped: 0, errors: 0 });
  }

  const resend = new Resend(resendKey);
  const windowInfo = getReportWindow(frequency);

  let sent = 0;
  let skipped = 0;
  let errors = 0;

  for (const client of clients) {
    const targetEmail = client.report_email || client.notify_email;
    if (!targetEmail) {
      console.warn(`[send-report] ⏭️ skipping ${client.client_slug} — no email`);
      skipped++;
      continue;
    }

    try {
      // Fetch calls for this client in the window
      const calls = await fetchCallsInWindow(client.id, windowInfo.start, windowInfo.end, supabaseUrl, supabaseKey);
      const stats = aggregateStats(calls);

      console.log(`[send-report] 📊 ${client.client_slug}: ${stats.totalCalls} calls, ${stats.leadsCaptured} leads`);

      // Send email
      const businessName = client.business_name || "your business";
      const subject = frequency === "weekly"
        ? `Your weekly lead report — ${businessName}`
        : `Your monthly lead report — ${businessName}`;

      const result = await resend.emails.send({
        // MUST be the verified aileadintel.com domain. Resend's shared sandbox
        // address (onboarding@resend.dev) only delivers to your own Resend
        // account email — every report to an actual customer was rejected.
        from: "AI Lead Intel <hello@aileadintel.com>",
        to: [targetEmail],
        replyTo: "hello@aileadintel.com",
        subject,
        html: buildReportEmail(client, stats, windowInfo),
      });

      if (result && result.error) {
        console.error(`[send-report] ⚠️ Resend error for ${client.client_slug}:`, result.error);
        errors++;
        continue;
      }

      // Update last_report_sent_at
      await fetch(
        `${supabaseUrl}/rest/v1/clients?id=eq.${client.id}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            apikey: supabaseKey,
            Authorization: `Bearer ${supabaseKey}`,
          },
          body: JSON.stringify({ last_report_sent_at: new Date().toISOString() }),
        }
      );
      console.log(`[send-report] ✅ sent to ${targetEmail}`);
      sent++;
    } catch (err) {
      console.error(`[send-report] ❌ exception for ${client.client_slug}:`, err.message);
      errors++;
    }
  }

  console.log(`[send-report] 🏁 done — sent: ${sent}, skipped: ${skipped}, errors: ${errors}`);
  return res.status(200).json({
    success: true,
    frequency,
    sent,
    skipped,
    errors,
    total: clients.length,
  });
}
