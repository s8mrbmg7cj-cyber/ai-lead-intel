// /api/send-setup-email.js
//
// Sends a customer their personalized setup link via email.
// VERBOSE LOGGING — surfaces every step in Vercel logs.
 
const NTFY_TOPIC = 'mcr-leads-andrew-2025';
const FROM_EMAIL = 'AI Lead Intel <hello@aileadintel.com>';
const REPLY_TO = 'hello@aileadintel.com';
const SITE_URL = 'https://aileadintel.com';

export default async function handler(req, res) {
  const TRACE_ID = `sse_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  console.log(`[send-setup-email ${TRACE_ID}] === REQUEST RECEIVED ===`);
  console.log(`[send-setup-email ${TRACE_ID}] method:`, req.method);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).json({ ok: true });
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });

  // ===== PARSE INPUT =====
  let body = req.body || {};
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) {
      console.error(`[send-setup-email ${TRACE_ID}] Body JSON.parse failed:`, e.message);
      body = {};
    }
  }
  console.log(`[send-setup-email ${TRACE_ID}] Body received:`, JSON.stringify(body));

  const clientSlug = (body.client_slug || '').toString().trim();

  if (!clientSlug) {
    console.warn(`[send-setup-email ${TRACE_ID}] ❌ Missing client_slug`);
    return res.status(400).json({ success: false, error: 'Missing client_slug' });
  }
  if (!/^[a-z0-9-]+$/.test(clientSlug) || clientSlug.length > 100) {
    console.warn(`[send-setup-email ${TRACE_ID}] ❌ Invalid slug format: "${clientSlug}"`);
    return res.status(400).json({ success: false, error: 'Invalid client_slug format' });
  }
  console.log(`[send-setup-email ${TRACE_ID}] ✅ Validated slug: ${clientSlug}`);

  // ===== ENV =====
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY;
  const resendKey = process.env.RESEND_API_KEY;

  console.log(`[send-setup-email ${TRACE_ID}] ENV check:`, {
    SUPABASE_URL: !!supabaseUrl,
    SUPABASE_SERVICE_KEY: !!process.env.SUPABASE_SERVICE_KEY,
    SUPABASE_SECRET_KEY: !!process.env.SUPABASE_SECRET_KEY,
    supabaseKey_used: !!supabaseKey,
    RESEND_API_KEY: !!resendKey,
    RESEND_API_KEY_length: resendKey ? resendKey.length : 0,
  });

  if (!supabaseUrl || !supabaseKey) {
    console.error(`[send-setup-email ${TRACE_ID}] ❌ Missing Supabase credentials`);
    return res.status(500).json({ success: false, error: 'Server missing Supabase credentials' });
  }

  // ===== 1. FETCH CUSTOMER =====
  let customer = null;
  try {
    const customerUrl = `${supabaseUrl}/rest/v1/clients?client_slug=eq.${encodeURIComponent(clientSlug)}&select=id,business_name,client_slug,notify_email,phone_number,setup_ai_number,twilio_number,ai_setup_status&limit=1`;
    console.log(`[send-setup-email ${TRACE_ID}] Fetching customer from:`, customerUrl);

    const r = await fetch(customerUrl, {
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
      },
    });
    console.log(`[send-setup-email ${TRACE_ID}] Customer fetch status:`, r.status);

    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      console.error(`[send-setup-email ${TRACE_ID}] ❌ Customer fetch failed:`, r.status, txt.slice(0, 500));
      return res.status(500).json({ success: false, error: `Could not fetch customer (HTTP ${r.status})` });
    }

    const rows = await r.json();
    console.log(`[send-setup-email ${TRACE_ID}] Customer rows returned:`, rows.length);

    if (!rows || rows.length === 0) {
      console.warn(`[send-setup-email ${TRACE_ID}] ❌ No customer with slug "${clientSlug}"`);
      return res.status(404).json({ success: false, error: 'Customer not found' });
    }
    customer = rows[0];
    console.log(`[send-setup-email ${TRACE_ID}] Customer found:`, {
      id: customer.id,
      business_name: customer.business_name,
      notify_email: customer.notify_email,
      setup_ai_number: customer.setup_ai_number,
      twilio_number: customer.twilio_number,
      phone_number: customer.phone_number,
      ai_setup_status: customer.ai_setup_status,
    });
  } catch (e) {
    console.error(`[send-setup-email ${TRACE_ID}] ❌ Fetch exception:`, e && e.stack ? e.stack : e);
    return res.status(500).json({ success: false, error: 'Server error fetching customer' });
  }

  const toEmail = customer.notify_email;
  const businessName = customer.business_name || 'your business';
  const aiNumber = customer.setup_ai_number || customer.twilio_number || customer.phone_number || null;
  const setupUrl = `${SITE_URL}/setup?slug=${encodeURIComponent(clientSlug)}`;

  console.log(`[send-setup-email ${TRACE_ID}] Resolved values:`, {
    toEmail,
    businessName,
    aiNumber,
    setupUrl,
  });

  if (!toEmail) {
    console.warn(`[send-setup-email ${TRACE_ID}] ❌ Customer has no notify_email`);
    return res.status(400).json({ success: false, error: 'Customer has no notify_email on file' });
  }

  // Format AI number for display
  let formattedAiNumber = '';
  if (aiNumber) {
    const d = String(aiNumber).replace(/\D/g, '').replace(/^1/, '').slice(-10);
    if (d.length === 10) {
      formattedAiNumber = `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6,10)}`;
    }
  }
  console.log(`[send-setup-email ${TRACE_ID}] Formatted AI number: "${formattedAiNumber}"`);

  // ===== 2. BUILD EMAIL =====
  const subject = `Your AI receptionist is ready — ${businessName}`;
  const aiNumberLine = formattedAiNumber
    ? `<p style="margin:0 0 16px 0;font-size:15px;color:#374151;">Your AI receptionist number: <strong style="font-family:monospace;color:#ff6a00;">${formattedAiNumber}</strong></p>`
    : '';

  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f9fafb;">
  <div style="max-width:560px;margin:0 auto;padding:32px 20px;">
    <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:14px;padding:36px 32px;">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:24px;">
        <div style="width:30px;height:30px;border-radius:8px;background:linear-gradient(135deg,#ff6a00,#ff9a00);"></div>
        <strong style="font-size:14px;color:#111827;letter-spacing:-0.01em;">AI Lead Intel</strong>
      </div>
      <h1 style="font-size:24px;font-weight:600;color:#111827;letter-spacing:-0.02em;margin:0 0 14px 0;line-height:1.25;">Your AI receptionist is ready</h1>
      <p style="margin:0 0 18px 0;font-size:15px;color:#374151;line-height:1.55;">Hey ${escapeHtml(businessName)},</p>
      <p style="margin:0 0 18px 0;font-size:15px;color:#374151;line-height:1.55;">Your AI receptionist is built and ready to start taking calls. Last step is forwarding your business calls to your AI — takes about 2 minutes.</p>
      ${aiNumberLine}
      <div style="margin:28px 0;">
        <a href="${setupUrl}" style="display:inline-block;background:linear-gradient(135deg,#ff6a00,#ff8533);color:#ffffff;font-weight:600;font-size:15px;padding:13px 26px;border-radius:10px;text-decoration:none;">Open your setup page →</a>
      </div>
      <p style="margin:0 0 14px 0;font-size:14px;color:#374151;line-height:1.55;">The setup page walks you through:</p>
      <ul style="margin:0 0 18px 0;padding-left:20px;font-size:14px;color:#374151;line-height:1.7;">
        <li>Forwarding your business calls to your AI</li>
        <li>Testing that everything works</li>
        <li>Marking your AI as live</li>
      </ul>
      <p style="margin:0 0 6px 0;font-size:14px;color:#374151;line-height:1.55;">Reply to this email if you have any questions — I'll get back to you fast.</p>
      <p style="margin:0;font-size:14px;color:#374151;line-height:1.55;">— Andrew</p>
      <div style="margin-top:32px;padding-top:20px;border-top:1px solid #e5e7eb;font-size:11px;color:#9ca3af;line-height:1.5;">Setup link: <a href="${setupUrl}" style="color:#ff6a00;word-break:break-all;">${setupUrl}</a></div>
    </div>
    <p style="text-align:center;margin:18px 0 0 0;font-size:11px;color:#9ca3af;">AI Lead Intel · Apex Growth Investments LLC</p>
  </div>
</body></html>`;

  const text = `Your AI receptionist is ready

Hey ${businessName},

Your AI receptionist is built and ready to start taking calls. Last step is forwarding your business calls to your AI — takes about 2 minutes.

${formattedAiNumber ? `Your AI receptionist number: ${formattedAiNumber}\n\n` : ''}Open your setup page: ${setupUrl}

The setup page walks you through:
- Forwarding your business calls to your AI
- Testing that everything works
- Marking your AI as live

Reply to this email if you have any questions — I'll get back to you fast.

— Andrew`;

  // ===== 3. SEND VIA RESEND =====
  let emailSent = false;
  let emailError = null;
  let resendId = null;

  if (!resendKey) {
    emailError = 'RESEND_API_KEY env var not set';
    console.error(`[send-setup-email ${TRACE_ID}] ❌ ${emailError}`);
  } else {
    const resendPayload = {
      from: FROM_EMAIL,
      to: [toEmail],
      reply_to: REPLY_TO,
      subject,
      html,
      text,
    };
    console.log(`[send-setup-email ${TRACE_ID}] === CALLING RESEND ===`);
    console.log(`[send-setup-email ${TRACE_ID}] from: ${FROM_EMAIL}`);
    console.log(`[send-setup-email ${TRACE_ID}] to: ${toEmail}`);
    console.log(`[send-setup-email ${TRACE_ID}] subject: ${subject}`);
    console.log(`[send-setup-email ${TRACE_ID}] html bytes: ${html.length}`);

    try {
      const resendRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${resendKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(resendPayload),
      });

      const rawText = await resendRes.text();
      console.log(`[send-setup-email ${TRACE_ID}] Resend status: ${resendRes.status}`);
      console.log(`[send-setup-email ${TRACE_ID}] Resend body (raw):`, rawText.slice(0, 1500));

      if (!resendRes.ok) {
        emailError = `Resend HTTP ${resendRes.status}: ${rawText}`.slice(0, 500);
        console.error(`[send-setup-email ${TRACE_ID}] ❌ Resend rejected:`, emailError);
      } else {
        let parsed = null;
        try { parsed = JSON.parse(rawText); } catch (_) {}
        resendId = (parsed && parsed.id) || null;
        emailSent = true;
        console.log(`[send-setup-email ${TRACE_ID}] ✅ Email sent. Resend ID:`, resendId);
      }
    } catch (e) {
      emailError = String(e.message || e).slice(0, 500);
      console.error(`[send-setup-email ${TRACE_ID}] ❌ Resend exception:`, e && e.stack ? e.stack : e);
    }
  }

  // ===== 4. LOG TO activity_log =====
  try {
    await fetch(`${supabaseUrl}/rest/v1/activity_log`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        client_id: customer.id,
        action: emailSent ? 'setup_email_sent' : 'setup_email_failed',
        details: emailSent
          ? `Setup email sent to ${toEmail} (Resend ID: ${resendId || 'n/a'})`
          : `Setup email failed: ${emailError}`,
      }),
    });
    console.log(`[send-setup-email ${TRACE_ID}] activity_log written`);
  } catch (e) {
    console.error(`[send-setup-email ${TRACE_ID}] activity_log write failed:`, e);
  }

  // ===== 5. NTFY PUSH TO ANDREW =====
  try {
    const title = emailSent
      ? `Setup email sent — ${businessName}`
      : `Setup email FAILED — ${businessName}`;
    const lines = emailSent
      ? [`To: ${toEmail}`, `Slug: ${clientSlug}`, formattedAiNumber ? `AI #: ${formattedAiNumber}` : ''].filter(Boolean)
      : [`Customer: ${businessName}`, `Slug: ${clientSlug}`, `Error: ${emailError}`];
    await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
      method: 'POST',
      headers: { Title: title, Priority: emailSent ? '3' : '4', Tags: emailSent ? 'email' : 'warning' },
      body: lines.join('\n'),
    });
  } catch (_) {}

  // ===== RESPOND =====
  if (emailSent) {
    console.log(`[send-setup-email ${TRACE_ID}] === RETURNING SUCCESS ===`);
    return res.status(200).json({
      success: true,
      email_sent_to: toEmail,
      setup_url: setupUrl,
      business_name: businessName,
      resend_id: resendId,
    });
  } else {
    console.log(`[send-setup-email ${TRACE_ID}] === RETURNING FAILURE === ${emailError}`);
    return res.status(500).json({
      success: false,
      error: emailError || 'Email send failed',
      setup_url: setupUrl,
      email_intended_for: toEmail,
    });
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
