// /api/send-setup-email.js
//
// PROTECTED — requires EITHER:
//   1. Valid admin_session cookie (from your admin UI), OR
//   2. x-internal-secret header matching SUPABASE_WEBHOOK_SECRET (from webhook / server-to-server)
//
// Sends the "create your password" setup email. Idempotent: skips if
// setup_email_sent is already true (pass { force: true } to resend).
// On success, sets clients.setup_email_sent = true + setup_email_sent_at.
import { verifyAdminSession } from '../lib/auth.js';
const NTFY_TOPIC = 'mcr-leads-andrew-2025';
const FROM_EMAIL = 'AI Lead Intel <hello@aileadintel.com>';
const REPLY_TO = 'support@aileadintel.com';
const SUPPORT_EMAIL = 'support@aileadintel.com';
const SITE_URL = 'https://aileadintel.com';

export default async function handler(req, res) {
  const TRACE_ID = `sse_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  console.log(`[send-setup-email ${TRACE_ID}] === REQUEST RECEIVED ===`);
  console.log(`[send-setup-email ${TRACE_ID}] method:`, req.method);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-internal-secret');
  if (req.method === 'OPTIONS') return res.status(200).json({ ok: true });
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });

  // ===== AUTH =====
  let authReason = '';
  let authedAs = null;
  const internalSecret = req.headers['x-internal-secret'];
  const expectedInternal = process.env.SUPABASE_WEBHOOK_SECRET;
  if (expectedInternal && internalSecret && internalSecret === expectedInternal) {
    authedAs = 'internal';
    console.log(`[send-setup-email ${TRACE_ID}] ✅ Auth: internal secret`);
  } else {
    const adminCheck = verifyAdminSession(req);
    if (adminCheck.ok) {
      authedAs = 'admin';
      console.log(`[send-setup-email ${TRACE_ID}] ✅ Auth: admin session`);
    } else {
      authReason = `internal_secret_missing_or_wrong; admin_${adminCheck.reason}`;
    }
  }
  if (!authedAs) {
    console.warn(`[send-setup-email ${TRACE_ID}] ❌ Unauthorized: ${authReason}`);
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  // ===== PARSE INPUT =====
  let body = req.body || {};
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) {
      console.error(`[send-setup-email ${TRACE_ID}] Body JSON.parse failed:`, e.message);
      body = {};
    }
  }
  console.log(`[send-setup-email ${TRACE_ID}] Body:`, JSON.stringify(body));
  const clientSlug = (body.client_slug || '').toString().trim();
  const force = body.force === true || body.force === 'true';   // bypass dedup to resend
  if (!clientSlug) {
    console.warn(`[send-setup-email ${TRACE_ID}] ❌ Missing client_slug`);
    return res.status(400).json({ success: false, error: 'Missing client_slug' });
  }
  if (!/^[a-z0-9-]+$/.test(clientSlug) || clientSlug.length > 100) {
    console.warn(`[send-setup-email ${TRACE_ID}] ❌ Invalid slug: "${clientSlug}"`);
    return res.status(400).json({ success: false, error: 'Invalid client_slug format' });
  }

  // ===== ENV =====
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY;
  const resendKey = process.env.RESEND_API_KEY;
  console.log(`[send-setup-email ${TRACE_ID}] ENV check:`, {
    SUPABASE_URL: !!supabaseUrl, supabaseKey_used: !!supabaseKey, RESEND_API_KEY: !!resendKey,
  });
  if (!supabaseUrl || !supabaseKey) {
    console.error(`[send-setup-email ${TRACE_ID}] ❌ Missing Supabase credentials`);
    return res.status(500).json({ success: false, error: 'Server missing Supabase credentials' });
  }

  // ===== 1. FETCH CUSTOMER =====
  let customer = null;
  try {
    const customerUrl = `${supabaseUrl}/rest/v1/clients?client_slug=eq.${encodeURIComponent(clientSlug)}&select=id,business_name,client_slug,notify_email,plan,setup_email_sent,ntfy_topic&limit=1`;
    const r = await fetch(customerUrl, { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } });
    console.log(`[send-setup-email ${TRACE_ID}] Customer fetch status:`, r.status);
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      console.error(`[send-setup-email ${TRACE_ID}] ❌ Customer fetch failed:`, r.status, txt.slice(0, 500));
      return res.status(500).json({ success: false, error: `Could not fetch customer (HTTP ${r.status})` });
    }
    const rows = await r.json();
    if (!rows || rows.length === 0) {
      console.warn(`[send-setup-email ${TRACE_ID}] ❌ No customer with slug "${clientSlug}"`);
      return res.status(404).json({ success: false, error: 'Customer not found' });
    }
    customer = rows[0];
    console.log(`[send-setup-email ${TRACE_ID}] Customer:`, {
      id: customer.id, business_name: customer.business_name,
      notify_email: customer.notify_email, plan: customer.plan, setup_email_sent: customer.setup_email_sent,
    });
  } catch (e) {
    console.error(`[send-setup-email ${TRACE_ID}] ❌ Fetch exception:`, e && e.stack ? e.stack : e);
    return res.status(500).json({ success: false, error: 'Server error fetching customer' });
  }

  // ===== DEDUP: skip if already sent (unless force) =====
  if (customer.setup_email_sent === true && !force) {
    console.log(`[send-setup-email ${TRACE_ID}] ⏭️ already sent — skipping (pass force:true to resend)`);
    return res.status(200).json({ success: true, skipped: true, reason: 'already_sent', email_intended_for: customer.notify_email });
  }

  const toEmail = customer.notify_email;   // the email entered during onboarding
  const businessName = customer.business_name || 'your business';
  const plan = (customer.plan || 'starter').toLowerCase();
  const planLabel = plan === 'pro' ? 'AI Front Desk Pro' : 'Starter';
  const createPasswordUrl = `${SITE_URL}/create-password?slug=${encodeURIComponent(clientSlug)}`;
  const dashboardUrl = plan === 'pro' ? `${SITE_URL}/dashboard/${encodeURIComponent(clientSlug)}` : null;
  if (!toEmail) {
    console.warn(`[send-setup-email ${TRACE_ID}] ❌ Customer has no notify_email`);
    return res.status(400).json({ success: false, error: 'Customer has no notify_email on file' });
  }

  // ===== 2. BUILD EMAIL =====
  const subject = 'Set up your AI Lead Intel account';
  const dashboardRow = dashboardUrl
    ? `<tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">Dashboard</td><td style="padding:6px 0;text-align:right;"><a href="${dashboardUrl}" style="color:#ff6a00;font-size:13px;">${dashboardUrl}</a></td></tr>`
    : '';

  // Optional "get alerts on your phone" block — only if this client has a push
  // topic on file. Explains that leads arrive by email AND (if they want) as an
  // instant phone push via the free ntfy app, and gives their private code.
  const alertTopic = (customer.ntfy_topic || '').trim();
  const alertsHtml = alertTopic ? `
      <div style="margin-top:26px;padding:18px 20px;background:#fff7f0;border:1px solid #ffd9bd;border-radius:12px;">
        <div style="font-size:14px;font-weight:600;color:#111827;margin:0 0 6px 0;">📲 Want alerts on your phone too?</div>
        <p style="margin:0 0 12px 0;font-size:13px;color:#374151;line-height:1.55;">Every call is emailed to you automatically. If you'd also like an <strong>instant push notification</strong> the moment a lead comes in, install the free <strong>ntfy</strong> app and subscribe to your private alert code:</p>
        <ol style="margin:0 0 12px 0;padding-left:18px;font-size:13px;color:#374151;line-height:1.7;">
          <li>Install ntfy — <a href="https://apps.apple.com/app/ntfy/id1625396347" style="color:#ff6a00;">iPhone</a> or <a href="https://play.google.com/store/apps/details?id=io.heckel.ntfy" style="color:#ff6a00;">Android</a></li>
          <li>Open it, tap <strong>+</strong>, and subscribe to the code below</li>
        </ol>
        <div style="font-family:'Courier New',monospace;font-size:14px;font-weight:600;color:#111827;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;padding:10px 14px;word-break:break-all;">${escapeHtml(alertTopic)}</div>
      </div>` : '';
  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f9fafb;">
  <div style="max-width:560px;margin:0 auto;padding:32px 20px;">
    <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:14px;padding:36px 32px;">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:24px;">
        <div style="width:30px;height:30px;border-radius:8px;background:linear-gradient(135deg,#ff6a00,#ff9a00);"></div>
        <strong style="font-size:14px;color:#111827;">AI Lead Intel</strong>
      </div>
      <h1 style="font-size:24px;font-weight:600;color:#111827;margin:0 0 14px 0;line-height:1.25;">Your AI Front Desk is almost ready</h1>
      <p style="margin:0 0 16px 0;font-size:15px;color:#374151;line-height:1.55;">Thanks for signing up.</p>
      <p style="margin:0 0 18px 0;font-size:15px;color:#374151;line-height:1.55;">Your payment was received and we're preparing your account. Click below to create your password and access your account.</p>
      <div style="margin:28px 0;">
        <a href="${createPasswordUrl}" style="display:inline-block;background:linear-gradient(135deg,#ff6a00,#ff8533);color:#ffffff;font-weight:600;font-size:15px;padding:13px 26px;border-radius:10px;text-decoration:none;">Create My Password</a>
      </div>
      <table style="width:100%;border-collapse:collapse;margin:8px 0 4px 0;border-top:1px solid #e5e7eb;">
        <tr><td style="padding:12px 0 6px 0;color:#6b7280;font-size:13px;">Business</td><td style="padding:12px 0 6px 0;text-align:right;color:#111827;font-size:13px;font-weight:600;">${escapeHtml(businessName)}</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">Plan</td><td style="padding:6px 0;text-align:right;color:#111827;font-size:13px;font-weight:600;">${escapeHtml(planLabel)}</td></tr>
        ${dashboardRow}
      </table>
      ${alertsHtml}
      <div style="margin-top:28px;padding-top:20px;border-top:1px solid #e5e7eb;font-size:13px;color:#6b7280;line-height:1.5;">
        Need help? <a href="mailto:${SUPPORT_EMAIL}" style="color:#ff6a00;">${SUPPORT_EMAIL}</a>
        <div style="margin-top:8px;font-size:11px;color:#9ca3af;">Button not working? Copy this link: <a href="${createPasswordUrl}" style="color:#ff6a00;word-break:break-all;">${createPasswordUrl}</a></div>
      </div>
    </div>
    <p style="text-align:center;margin:18px 0 0 0;font-size:11px;color:#9ca3af;">AI Lead Intel · Apex Growth Investments LLC</p>
  </div>
</body></html>`;
  const text = `Your AI Front Desk is almost ready

Thanks for signing up. Your payment was received and we're preparing your account.

Create your password and access your account:
${createPasswordUrl}

Business: ${businessName}
Plan: ${planLabel}${dashboardUrl ? `\nDashboard: ${dashboardUrl}` : ''}
${alertTopic ? `
Want alerts on your phone too? Every call is emailed to you. For instant push notifications, install the free ntfy app (iPhone: https://apps.apple.com/app/ntfy/id1625396347 · Android: https://play.google.com/store/apps/details?id=io.heckel.ntfy), tap +, and subscribe to your private alert code:
${alertTopic}
` : ''}
Need help? ${SUPPORT_EMAIL}`;

  // ===== 3. SEND VIA RESEND =====
  let emailSent = false;
  let emailError = null;
  let resendId = null;
  if (!resendKey) {
    emailError = 'RESEND_API_KEY env var not set';
    console.error(`[send-setup-email ${TRACE_ID}] ❌ ${emailError}`);
  } else {
    console.log(`[send-setup-email ${TRACE_ID}] Calling Resend, to:${toEmail}`);
    try {
      const resendRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: FROM_EMAIL, to: [toEmail], reply_to: REPLY_TO, subject, html, text }),
      });
      const rawText = await resendRes.text();
      console.log(`[send-setup-email ${TRACE_ID}] Resend status:`, resendRes.status);
      console.log(`[send-setup-email ${TRACE_ID}] Resend body:`, rawText.slice(0, 1000));
      if (!resendRes.ok) {
        emailError = `Resend HTTP ${resendRes.status}: ${rawText}`.slice(0, 500);
      } else {
        let parsed = null;
        try { parsed = JSON.parse(rawText); } catch (_) {}
        resendId = (parsed && parsed.id) || null;
        emailSent = true;
        console.log(`[send-setup-email ${TRACE_ID}] ✅ Sent. Resend ID:`, resendId);
      }
    } catch (e) {
      emailError = String(e.message || e).slice(0, 500);
      console.error(`[send-setup-email ${TRACE_ID}] ❌ Resend exception:`, e && e.stack ? e.stack : e);
    }
  }

  // ===== 4. MARK setup_email_sent = true (only on success) =====
  if (emailSent) {
    try {
      await fetch(`${supabaseUrl}/rest/v1/clients?id=eq.${customer.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}`, Prefer: 'return=minimal' },
        body: JSON.stringify({ setup_email_sent: true, setup_email_sent_at: new Date().toISOString() }),
      });
      console.log(`[send-setup-email ${TRACE_ID}] ✅ marked setup_email_sent=true`);
    } catch (e) {
      console.error(`[send-setup-email ${TRACE_ID}] ⚠️ failed to mark setup_email_sent:`, e.message);
    }
  }

  // ===== 5. LOG TO activity_log =====
  try {
    await fetch(`${supabaseUrl}/rest/v1/activity_log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}`, Prefer: 'return=minimal' },
      body: JSON.stringify({
        client_id: customer.id,
        action: emailSent ? 'setup_email_sent' : 'setup_email_failed',
        details: emailSent
          ? `Setup email sent to ${toEmail} (Resend ID: ${resendId || 'n/a'}, by: ${authedAs})`
          : `Setup email failed: ${emailError}`,
      }),
    });
  } catch (e) {
    console.error(`[send-setup-email ${TRACE_ID}] activity_log write failed:`, e);
  }

  // ===== 6. NTFY PUSH =====
  try {
    const title = emailSent ? `Setup email sent — ${businessName}` : `Setup email FAILED — ${businessName}`;
    const lines = emailSent
      ? [`To: ${toEmail}`, `Slug: ${clientSlug}`, `Plan: ${planLabel}`, `By: ${authedAs}`]
      : [`Customer: ${businessName}`, `Slug: ${clientSlug}`, `Error: ${emailError}`];
    await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
      method: 'POST',
      headers: { Title: title, Priority: emailSent ? '3' : '4', Tags: emailSent ? 'email' : 'warning' },
      body: lines.join('\n'),
    });
  } catch (_) {}

  if (emailSent) {
    return res.status(200).json({ success: true, email_sent_to: toEmail, create_password_url: createPasswordUrl, business_name: businessName, resend_id: resendId });
  } else {
    return res.status(500).json({ success: false, error: emailError || 'Email send failed', email_intended_for: toEmail });
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
