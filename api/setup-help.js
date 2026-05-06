// /api/setup-help.js
// Vercel serverless function — receives help requests from the /setup page
// and emails them via Resend.
//
// ENV VARS REQUIRED (set in Vercel project settings):
//   RESEND_API_KEY  — your Resend API key
//   NOTIFY_EMAIL    — email to receive help alerts (e.g. hello@aileadintel.com)

export default async function handler(req, res) {
  // CORS / preflight
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const {
      name = '',
      business = '',
      phone = '',
      carrier = '',
      stuck = '',
      aiNumber = '',
      step = '',
      timestamp = new Date().toISOString(),
    } = req.body || {};

    // Basic validation
    if (!name || !phone) {
      return res.status(400).json({ error: 'Name and phone are required' });
    }

    const RESEND_API_KEY = process.env.RESEND_API_KEY;
    const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL;

    if (!RESEND_API_KEY || !NOTIFY_EMAIL) {
      console.error('Missing RESEND_API_KEY or NOTIFY_EMAIL env vars');
      // Still return 200 so frontend shows success, but log on server
      return res.status(200).json({
        ok: true,
        warning: 'Email not sent — admin env vars missing',
      });
    }

    const carrierLabels = {
      verizon: 'Verizon',
      att: 'AT&T',
      tmobile: 'T-Mobile',
      googlevoice: 'Google Voice',
      spectrum: 'Spectrum Business',
      ringcentral: 'RingCentral',
      vonage: 'Vonage',
      other: 'Other / Not sure',
    };
    const carrierLabel = carrierLabels[carrier] || carrier || '—';

    const html = `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;padding:24px;background:#0a0a0c;color:#fafafa;">
        <div style="background:linear-gradient(135deg,#ff6a00,#ff9a00);padding:24px;border-radius:14px 14px 0 0;color:#fff;">
          <div style="font-size:11px;letter-spacing:0.16em;text-transform:uppercase;opacity:0.85;margin-bottom:6px;">⚡ Setup Help Request</div>
          <div style="font-size:22px;font-weight:700;">${escape(name)} needs help</div>
          <div style="font-size:13px;opacity:0.9;margin-top:4px;">${escape(business || 'No business name')}</div>
        </div>
        <div style="background:#13141a;border:1px solid rgba(255,255,255,0.07);border-top:none;border-radius:0 0 14px 14px;padding:24px;">
          <table style="width:100%;border-collapse:collapse;font-size:14px;">
            <tr><td style="color:#a1a1aa;padding:8px 0;width:130px;">Phone</td><td style="color:#fff;font-weight:600;"><a href="tel:${escape(phone)}" style="color:#ff9a00;text-decoration:none;">${escape(phone)}</a></td></tr>
            <tr><td style="color:#a1a1aa;padding:8px 0;">Carrier</td><td style="color:#fff;">${escape(carrierLabel)}</td></tr>
            <tr><td style="color:#a1a1aa;padding:8px 0;">AI number</td><td style="color:#fff;">${escape(aiNumber)}</td></tr>
            <tr><td style="color:#a1a1aa;padding:8px 0;">Stuck on step</td><td style="color:#fff;">${escape(String(step))}</td></tr>
            <tr><td style="color:#a1a1aa;padding:8px 0;vertical-align:top;">Issue</td><td style="color:#fff;line-height:1.55;">${escape(stuck || '(no description provided)').replace(/\n/g, '<br/>')}</td></tr>
            <tr><td style="color:#a1a1aa;padding:8px 0;">Submitted</td><td style="color:#fff;">${escape(timestamp)}</td></tr>
          </table>
          <div style="margin-top:24px;padding-top:18px;border-top:1px solid rgba(255,255,255,0.07);">
            <a href="tel:${escape(phone)}" style="display:inline-block;background:#ff6a00;color:#fff;font-weight:700;padding:12px 22px;border-radius:8px;text-decoration:none;font-size:14px;">📞 Call ${escape(name)}</a>
            <a href="sms:${escape(phone)}" style="display:inline-block;margin-left:8px;background:#13141a;border:1px solid rgba(255,255,255,0.13);color:#fff;font-weight:600;padding:12px 22px;border-radius:8px;text-decoration:none;font-size:14px;">💬 Text</a>
          </div>
        </div>
      </div>
    `;

    const text = [
      `SETUP HELP REQUEST — AI Lead Intel`,
      ``,
      `Name: ${name}`,
      `Business: ${business}`,
      `Phone: ${phone}`,
      `Carrier: ${carrierLabel}`,
      `AI number: ${aiNumber}`,
      `Stuck on step: ${step}`,
      `Issue: ${stuck}`,
      `Submitted: ${timestamp}`,
    ].join('\n');

    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'AI Lead Intel <onboarding@resend.dev>',
        to: NOTIFY_EMAIL,
        reply_to: undefined,
        subject: `🚨 Setup help: ${name}${business ? ' (' + business + ')' : ''}`,
        html,
        text,
      }),
    });

    if (!resendRes.ok) {
      const errBody = await resendRes.text();
      console.error('Resend error:', errBody);
      return res.status(200).json({ ok: true, warning: 'Email failed but request received' });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('setup-help error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

function escape(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
