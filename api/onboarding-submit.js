// api/onboarding-submit.js — v1
// Handles client onboarding form submissions from /onboarding.html
// - Sends ntfy push notification to Andrew's phone
// - Sends email notification to Andrew with full client details
// - Saves onboarding data to Supabase client_onboarding table

const NTFY_TOPIC = process.env.NTFY_TOPIC || "mcr-leads-andrew-2025";

// ═══════════════════════════════════════════════════════════
// 1. ntfy push notification
// ═══════════════════════════════════════════════════════════
async function sendNtfyNotification(data, businessName, industry, ein) {
  try {
    const body = `New Client Onboarding!
Business: ${businessName}
Industry: ${industry}
Phone: ${data.business?.phone || "—"}
EIN: ${ein}
Contact: ${data.callHandling?.voicemailEmail || "—"}
Submitted: ${new Date().toLocaleString("en-US", { timeZone: "America/Chicago" })}`;

    const res = await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
      method: "POST",
      headers: {
        "Title": `New Client Onboarding: ${businessName}`,
        "Priority": "high",
        "Tags": "tada,rocket",
      },
      body,
    });

    if (res.ok) {
      console.log("NTFY SENT to", NTFY_TOPIC);
      return true;
    } else {
      console.log("NTFY ERROR:", res.status, await res.text());
      return false;
    }
  } catch (err) {
    console.log("NTFY ERROR:", err.message);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════
// 2. Email via Resend
// ═══════════════════════════════════════════════════════════
async function notifyOwnerEmail(data) {
  const RESEND_KEY   = process.env.RESEND_API_KEY;
  const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL;
  if (!RESEND_KEY || !NOTIFY_EMAIL) {
    console.log("EMAIL SKIPPED — missing RESEND_API_KEY or NOTIFY_EMAIL");
    return;
  }

  const businessName = data.business?.name || "—";
  const industry     = data.business?.industry || "—";
  const ein          = data.legal?.ein || "—";
  const city         = data.legal?.city || "—";
  const state        = data.legal?.state || "—";
  const phone        = data.business?.phone || "—";
  const email        = data.callHandling?.voicemailEmail || "—";
  const tone         = data.tone?.selected || "—";

  const callReasonsList = (data.callReasons?.selected || []).join(", ") || "—";
  const outsideHoursLabel = {
    message: "AI takes a detailed message",
    handle:  "AI handles the request fully",
    both:    "Both — handle what it can, message what it can't",
  }[data.hours?.outsideHours] || "—";

  const fullAddress = [
    data.legal?.address,
    data.legal?.city,
    data.legal?.state,
    data.legal?.zip
  ].filter(Boolean).join(", ") || "—";

  try {
    const { Resend } = await import("resend");
    const resend = new Resend(RESEND_KEY);

    await resend.emails.send({
      from: "AI Lead Intel <onboarding@resend.dev>",
      to: NOTIFY_EMAIL,
      subject: `New Client Onboarding: ${businessName}`,
      html: `
        <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:640px;margin:0 auto;background:#0d1422;color:#f0f4ff;padding:28px;border-radius:10px;">
          <div style="border-bottom:1px solid rgba(240,244,255,0.1);padding-bottom:16px;margin-bottom:20px;">
            <div style="color:#ff8c00;font-size:11px;letter-spacing:0.1em;text-transform:uppercase;margin-bottom:8px;font-weight:600;">NEW CLIENT ONBOARDING</div>
            <h2 style="margin:0;font-size:22px;">${escapeHtml(businessName)}</h2>
            <div style="color:rgba(240,244,255,0.6);font-size:14px;margin-top:4px;">${escapeHtml(industry)} · ${escapeHtml(city)}, ${escapeHtml(state)}</div>
          </div>

          <div style="margin-bottom:20px;">
            <div style="color:#ff8c00;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;margin-bottom:10px;font-weight:600;">Business Info</div>
            <p style="margin:4px 0;"><strong>Name (DBA):</strong> ${escapeHtml(businessName)}</p>
            <p style="margin:4px 0;"><strong>Industry:</strong> ${escapeHtml(industry)}</p>
            <p style="margin:4px 0;"><strong>Phone:</strong> <a href="tel:${escapeHtml(phone)}" style="color:#ff8c00;">${escapeHtml(phone)}</a></p>
            <p style="margin:4px 0;"><strong>Website:</strong> ${escapeHtml(data.business?.website || (data.business?.hasWebsite === "no" ? "No website yet" : "—"))}</p>
          </div>

          <div style="margin-bottom:20px;">
            <div style="color:#ff8c00;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;margin-bottom:10px;font-weight:600;">Legal / A2P Registration</div>
            <p style="margin:4px 0;"><strong>Legal name:</strong> ${escapeHtml(data.legal?.legalName || "—")}</p>
            <p style="margin:4px 0;"><strong>EIN:</strong> ${escapeHtml(ein)}</p>
            <p style="margin:4px 0;"><strong>Entity type:</strong> ${escapeHtml(data.legal?.entityType || "—")}</p>
            <p style="margin:4px 0;"><strong>Address:</strong> ${escapeHtml(fullAddress)}</p>
          </div>

          <div style="margin-bottom:20px;">
            <div style="color:#ff8c00;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;margin-bottom:10px;font-weight:600;">Call Handling</div>
            <p style="margin:4px 0;"><strong>Primary transfer:</strong> ${escapeHtml(data.callHandling?.forwardNumber || "—")}</p>
            <p style="margin:4px 0;"><strong>Backup transfer:</strong> ${escapeHtml(data.callHandling?.backupNumber || "—")}</p>
            <p style="margin:4px 0;"><strong>Voicemail email:</strong> ${escapeHtml(email)}</p>
          </div>

          <div style="margin-bottom:20px;">
            <div style="color:#ff8c00;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;margin-bottom:10px;font-weight:600;">Hours &amp; Behavior</div>
            <p style="margin:4px 0;"><strong>Transfer hours:</strong> ${escapeHtml(data.hours?.transferHours || "—")}</p>
            <p style="margin:4px 0;"><strong>Outside hours:</strong> ${escapeHtml(outsideHoursLabel)}</p>
          </div>

          <div style="margin-bottom:20px;">
            <div style="color:#ff8c00;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;margin-bottom:10px;font-weight:600;">Operations</div>
            <p style="margin:4px 0;"><strong>Call reasons:</strong> ${escapeHtml(callReasonsList)}${data.callReasons?.other ? ` (${escapeHtml(data.callReasons.other)})` : ""}</p>
            <p style="margin:4px 0;"><strong>Contact method:</strong> ${escapeHtml(data.smsCompliance?.contactMethod || "—")}</p>
            <p style="margin:4px 0;"><strong>Sample message:</strong> ${escapeHtml(data.smsCompliance?.sampleMessage || "—")}</p>
            <p style="margin:4px 0;"><strong>AI tone:</strong> ${escapeHtml(tone)}${data.tone?.other ? ` (${escapeHtml(data.tone.other)})` : ""}</p>
          </div>

          <div style="margin-bottom:20px;">
            <div style="color:#ff8c00;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;margin-bottom:10px;font-weight:600;">Links</div>
            <p style="margin:4px 0;"><strong>Payment:</strong> ${escapeHtml(data.links?.payment || "—")}</p>
            <p style="margin:4px 0;"><strong>Booking:</strong> ${escapeHtml(data.links?.booking || "—")}</p>
            <p style="margin:4px 0;"><strong>FAQ/Info:</strong> ${escapeHtml(data.links?.info || "—")}</p>
          </div>

          ${data.notes ? `
            <div style="margin-top:20px;padding:14px 16px;background:rgba(255,140,0,0.08);border-left:3px solid #ff8c00;border-radius:4px;">
              <div style="color:#ff8c00;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;margin-bottom:6px;font-weight:600;">Client Notes</div>
              <div style="white-space:pre-wrap;font-size:14px;">${escapeHtml(data.notes)}</div>
            </div>
          ` : ""}

          <p style="margin-top:24px;padding-top:16px;border-top:1px solid rgba(240,244,255,0.1);color:rgba(240,244,255,0.5);font-size:12px;">
            Submitted ${new Date().toLocaleString("en-US", { timeZone: "America/Chicago" })} CST<br/>
            Via aileadintel.com/onboarding.html · Form v${escapeHtml(data.meta?.version || "?")}
          </p>
        </div>
      `,
    });
    console.log("EMAIL SENT to", NOTIFY_EMAIL);
  } catch (err) {
    console.log("EMAIL ERROR:", err.message);
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ═══════════════════════════════════════════════════════════
// 3. Save to Supabase client_onboarding table
// ═══════════════════════════════════════════════════════════
async function saveOnboardingToSupabase(data) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.log("SUPABASE SKIPPED — missing SUPABASE_URL or SUPABASE_SERVICE_KEY");
    return;
  }

  try {
    const row = {
      business_name:   data.business?.name,
      industry:        data.business?.industry,
      business_phone:  data.business?.phone,
      has_website:     data.business?.hasWebsite,
      website:         data.business?.website,

      legal_name:      data.legal?.legalName,
      same_as_dba:     data.legal?.sameAsDBA || false,
      ein:             data.legal?.ein,
      entity_type:     data.legal?.entityType,
      legal_address:   data.legal?.address,
      legal_city:      data.legal?.city,
      legal_state:     data.legal?.state,
      legal_zip:       data.legal?.zip,

      forward_number:  data.callHandling?.forwardNumber,
      backup_number:   data.callHandling?.backupNumber,
      voicemail_email: data.callHandling?.voicemailEmail,

      transfer_hours:  data.hours?.transferHours,
      outside_hours:   data.hours?.outsideHours,

      call_reasons:    data.callReasons || {},

      contact_method:  data.smsCompliance?.contactMethod,
      sample_message:  data.smsCompliance?.sampleMessage,

      payment_link:    data.links?.payment,
      booking_link:    data.links?.booking,
      info_link:       data.links?.info,

      tone:            data.tone?.selected,
      tone_other:      data.tone?.other,

      notes:           data.notes,

      status:          "new",
      user_agent:      data.meta?.userAgent,
      version:         data.meta?.version,
      raw_data:        data,
    };

    const res = await fetch(`${SUPABASE_URL}/rest/v1/client_onboarding`, {
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        "apikey":        SUPABASE_KEY,
        "Authorization": `Bearer ${SUPABASE_KEY}`,
        "Prefer":        "return=minimal",
      },
      body: JSON.stringify(row),
    });

    if (res.ok) {
      console.log("SUPABASE SAVED onboarding:", data.business?.name);
    } else {
      console.log("SUPABASE ERROR:", res.status, await res.text());
    }
  } catch (err) {
    console.log("SUPABASE ERROR:", err.message);
  }
}

// ═══════════════════════════════════════════════════════════
// Handler
// ═══════════════════════════════════════════════════════════
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).json({ ok: true });
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const data = req.body;
  if (!data || !data.business?.name) {
    return res.status(400).json({ error: "Missing required business info" });
  }

  const businessName = data.business.name;
  const industry     = data.business.industry || "—";
  const ein          = data.legal?.ein || "—";

  console.log("NEW ONBOARDING:", businessName, industry, ein);

  // Fire all three notifications in parallel
  await Promise.all([
    sendNtfyNotification(data, businessName, industry, ein),
    notifyOwnerEmail(data),
    saveOnboardingToSupabase(data),
  ]);

  return res.status(200).json({
    success: true,
    message: "Onboarding captured — we'll be in touch within 24 hours",
  });
}
