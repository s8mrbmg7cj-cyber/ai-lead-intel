import { Resend } from "resend";

const NTFY_TOPIC = process.env.NTFY_TOPIC || "mcr-leads-andrew-2025";

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function normalizeData(data) {
  return {
    business_name: data.business_name || data.business?.name || "",
    industry: data.industry || data.business?.industry || "",
    business_phone: data.business_phone || data.business?.phone || "",
    transfer_primary: data.transfer_primary || data.callHandling?.forwardNumber || "",
    transfer_backup: data.transfer_backup || data.callHandling?.backupNumber || "",
    notify_email: data.notify_email || data.callHandling?.voicemailEmail || "",
    transfer_hours: data.transfer_hours || data.hours?.transferHours || "",
    sms_consent: Boolean(data.sms_consent),
    topics: data.topics || data.callReasons?.selected || [],
    booking_link: data.booking_link || data.links?.booking || "",
    payment_link: data.payment_link || data.links?.payment || "",
    website: data.website || data.business?.website || data.links?.info || "",
    personality: data.personality || data.tone?.selected || "",
    pricing_rule: data.pricing_rule || "",
    pricing_examples: data.pricing_examples || "",
    notes: data.notes || "",
    raw_data: data,
  };
}

async function sendNtfyNotification(data) {
  try {
    const body = `New AI Lead Intel onboarding
Business: ${data.business_name || "—"}
Industry: ${data.industry || "—"}
Phone: ${data.business_phone || "—"}
Transfer: ${data.transfer_primary || "—"}
Email: ${data.notify_email || "—"}
Submitted: ${new Date().toLocaleString("en-US", { timeZone: "America/Denver" })}`;

    await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
      method: "POST",
      headers: {
        Title: `New Onboarding: ${data.business_name || "AI Lead Intel"}`,
        Priority: "high",
        Tags: "rocket",
      },
      body,
    });
  } catch (error) {
    console.log("NTFY ERROR:", error.message);
  }
}

async function notifyOwnerEmail(data) {
  const resendKey = process.env.RESEND_API_KEY;
  const notifyEmail = process.env.NOTIFY_EMAIL;

  if (!resendKey || !notifyEmail) {
    console.log("EMAIL SKIPPED — missing RESEND_API_KEY or NOTIFY_EMAIL");
    return;
  }

  const resend = new Resend(resendKey);

  await resend.emails.send({
    from: "AI Lead Intel <onboarding@resend.dev>",
    to: notifyEmail.split(",").map((email) => email.trim()),
    subject: `New AI Lead Intel onboarding: ${data.business_name || "New lead"}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:650px;margin:0 auto;background:#0a0a0c;color:#ffffff;padding:28px;border-radius:12px;">
        <h2 style="color:#ff6a00;margin-top:0;">New AI Lead Intel Onboarding</h2>

        <h3>Business</h3>
        <p><strong>Name:</strong> ${escapeHtml(data.business_name)}</p>
        <p><strong>Industry:</strong> ${escapeHtml(data.industry)}</p>
        <p><strong>Main Phone:</strong> ${escapeHtml(data.business_phone)}</p>

        <h3>Call Handling</h3>
        <p><strong>Primary Transfer:</strong> ${escapeHtml(data.transfer_primary)}</p>
        <p><strong>Backup Transfer:</strong> ${escapeHtml(data.transfer_backup || "—")}</p>
        <p><strong>Notification Email:</strong> ${escapeHtml(data.notify_email)}</p>
        <p><strong>Transfer Hours:</strong> ${escapeHtml(data.transfer_hours)}</p>
        <p><strong>SMS Consent:</strong> ${data.sms_consent ? "Yes" : "No"}</p>

        <h3>Topics</h3>
        <p>${escapeHtml((data.topics || []).join(", ") || "—")}</p>

        <h3>Links</h3>
        <p><strong>Booking:</strong> ${escapeHtml(data.booking_link || "—")}</p>
        <p><strong>Payment:</strong> ${escapeHtml(data.payment_link || "—")}</p>
        <p><strong>Website:</strong> ${escapeHtml(data.website || "—")}</p>

        <h3>Personality / Pricing</h3>
        <p><strong>Personality:</strong> ${escapeHtml(data.personality || "—")}</p>
        <p><strong>Pricing Rule:</strong> ${escapeHtml(data.pricing_rule || "—")}</p>
        <p><strong>Pricing Examples:</strong><br>${escapeHtml(data.pricing_examples || "—")}</p>

        <h3>Notes</h3>
        <p style="white-space:pre-wrap;">${escapeHtml(data.notes || "—")}</p>

        <hr style="border:none;border-top:1px solid rgba(255,255,255,0.15);margin:24px 0;" />
        <p style="color:#aaa;font-size:12px;">Submitted ${new Date().toLocaleString("en-US", { timeZone: "America/Denver" })}</p>
      </div>
    `,
  });

  console.log("EMAIL SENT to", notifyEmail);
}

async function saveOnboardingToSupabase(data) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY;

  if (!supabaseUrl || !supabaseKey) {
    console.log("SUPABASE SKIPPED — missing keys");
    return;
  }

  try {
    await fetch(`${supabaseUrl}/rest/v1/client_onboarding`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        business_name: data.business_name,
        industry: data.industry,
        business_phone: data.business_phone,
        forward_number: data.transfer_primary,
        backup_number: data.transfer_backup,
        voicemail_email: data.notify_email,
        transfer_hours: data.transfer_hours,
        call_reasons: data.topics,
        payment_link: data.payment_link,
        booking_link: data.booking_link,
        info_link: data.website,
        tone: data.personality,
        notes: data.notes,
        status: "new",
        raw_data: data.raw_data,
      }),
    });
  } catch (error) {
    console.log("SUPABASE ERROR:", error.message);
  }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).json({ ok: true });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const data = normalizeData(req.body || {});

    if (!data.business_name) {
      return res.status(400).json({ error: "Missing business name" });
    }

    await Promise.all([
      sendNtfyNotification(data),
      notifyOwnerEmail(data),
      saveOnboardingToSupabase(data),
    ]);

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("ONBOARDING ERROR:", error);
    return res.status(500).json({ error: "Failed to submit onboarding" });
  }
}
