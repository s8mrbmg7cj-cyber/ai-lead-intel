import { rateLimit, getClientIp } from '../lib/rate-limit.js';
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
    plan: data.plan === "pro" ? "pro" : "starter",
    client_slug_from_form: data.client_slug || "",
    raw_data: data,
  };
}

/**
 * Slugify a business name. Used as fallback / collision suffix.
 */
function slugifyBase(businessName) {
  return String(businessName || "client")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 50) || "client";
}

/**
 * Check if a slug is already taken.
 */
async function isSlugTaken(slug, supabaseUrl, supabaseKey) {
  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/clients?client_slug=eq.${encodeURIComponent(slug)}&select=id&limit=1`,
      { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } }
    );
    if (!res.ok) return false;
    const rows = await res.json();
    return Array.isArray(rows) && rows.length > 0;
  } catch (_) {
    return false;
  }
}

/**
 * Take the slug the frontend sent, fall back to slugify(business_name) if missing,
 * then add a suffix only if there's a collision.
 */
async function resolveSlug(data, supabaseUrl, supabaseKey) {
  let base = (data.client_slug_from_form || "").trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
  if (!base) base = slugifyBase(data.business_name);

  if (!await isSlugTaken(base, supabaseUrl, supabaseKey)) {
    return base;
  }
  // Collision — add 4 char suffix
  const suffix = Math.random().toString(36).slice(2, 6);
  return `${base}-${suffix}`;
}

async function sendNtfyNotification(data) {
  try {
    const body = `New AI Lead Intel onboarding
Business: ${data.business_name || "—"}
Industry: ${data.industry || "—"}
Phone: ${data.business_phone || "—"}
Transfer: ${data.transfer_primary || "—"}
Email: ${data.notify_email || "—"}
Plan: ${data.plan}
Submitted: ${new Date().toLocaleString("en-US", { timeZone: "America/Denver" })}`;
    await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
      method: "POST",
      headers: {
        Title: `New Onboarding (${data.plan}): ${data.business_name || "AI Lead Intel"}`,
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
    console.log("OWNER EMAIL SKIPPED — missing RESEND_API_KEY or NOTIFY_EMAIL");
    return;
  }
  try {
    const resend = new Resend(resendKey);
    await resend.emails.send({
      from: "AI Lead Intel <hello@aileadintel.com>",
      to: notifyEmail.split(",").map((e) => e.trim()),
      subject: `[${data.plan.toUpperCase()}] New onboarding: ${data.business_name || "New lead"}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:650px;margin:0 auto;background:#0a0a0c;color:#ffffff;padding:28px;border-radius:12px;">
          <h2 style="color:#ff6a00;margin-top:0;">New AI Lead Intel Onboarding</h2>
          <p><strong>Plan:</strong> ${escapeHtml(data.plan.toUpperCase())}</p>
          <h3>Business</h3>
          <p><strong>Name:</strong> ${escapeHtml(data.business_name)}</p>
          <p><strong>Industry:</strong> ${escapeHtml(data.industry)}</p>
          <p><strong>Main Phone:</strong> ${escapeHtml(data.business_phone)}</p>
          <h3>Call Handling</h3>
          <p><strong>Primary Transfer:</strong> ${escapeHtml(data.transfer_primary)}</p>
          <p><strong>Backup Transfer:</strong> ${escapeHtml(data.transfer_backup || "—")}</p>
          <p><strong>Notification Email:</strong> ${escapeHtml(data.notify_email)}</p>
          <p><strong>Transfer Hours:</strong> ${escapeHtml(data.transfer_hours)}</p>
          <h3>Topics</h3>
          <p>${escapeHtml((data.topics || []).join(", ") || "—")}</p>
          <h3>Personality / Pricing</h3>
          <p><strong>Personality:</strong> ${escapeHtml(data.personality || "—")}</p>
          <p><strong>Pricing Rule:</strong> ${escapeHtml(data.pricing_rule || "—")}</p>
          <p><strong>Pricing Examples:</strong><br>${escapeHtml(data.pricing_examples || "—")}</p>
          <h3>Notes</h3>
          <p style="white-space:pre-wrap;">${escapeHtml(data.notes || "—")}</p>
          <hr style="border:none;border-top:1px solid rgba(255,255,255,0.15);margin:24px 0;" />
          <p style="color:#aaa;font-size:12px;">View in admin: <a href="https://aileadintel.com/admin" style="color:#ff6a00;">aileadintel.com/admin</a></p>
        </div>
      `,
    });
    console.log("OWNER EMAIL SENT to", notifyEmail);
  } catch (e) {
    console.error("OWNER EMAIL FAILED:", e.message);
  }
}

/**
 * Confirmation email to the CUSTOMER (different from owner email above).
 */
async function sendCustomerConfirmation(data, finalSlug) {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey || !data.notify_email) {
    console.log("CUSTOMER EMAIL SKIPPED — missing key or email");
    return;
  }
  try {
    const resend = new Resend(resendKey);
    const businessName = data.business_name || "your business";
    const isPro = data.plan === "pro";
    const dashboardLine = isPro
      ? `<p style="margin:0 0 14px 0;font-size:14.5px;color:#374151;line-height:1.55;">Your private dashboard URL is reserved: <a href="https://aileadintel.com/dashboard/${finalSlug}" style="color:#ff6a00;">aileadintel.com/dashboard/${finalSlug}</a></p>`
      : "";

    await resend.emails.send({
      from: "AI Lead Intel <hello@aileadintel.com>",
      to: [data.notify_email],
      reply_to: "hello@aileadintel.com",
      subject: `We got your onboarding — ${businessName}`,
      html: `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;font-family:-apple-system,sans-serif;background:#f9fafb;">
  <div style="max-width:560px;margin:0 auto;padding:32px 20px;">
    <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:14px;padding:36px 32px;">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:24px;">
        <div style="width:30px;height:30px;border-radius:8px;background:linear-gradient(135deg,#ff6a00,#ff9a00);"></div>
        <strong style="font-size:14px;color:#111827;">AI Lead Intel</strong>
      </div>
      <h1 style="font-size:22px;font-weight:600;color:#111827;margin:0 0 14px 0;line-height:1.25;">We got your onboarding ✅</h1>
      <p style="margin:0 0 16px 0;font-size:15px;color:#374151;line-height:1.55;">Hey ${escapeHtml(businessName)},</p>
      <p style="margin:0 0 16px 0;font-size:15px;color:#374151;line-height:1.55;">Thanks for signing up for the <strong>${isPro ? "AI Front Desk Pro" : "Starter"}</strong> plan. We've got everything we need to start building your AI receptionist.</p>
      ${dashboardLine}
      <h2 style="font-size:16px;font-weight:600;color:#111827;margin:24px 0 10px 0;">What happens next</h2>
      <ol style="margin:0 0 18px 0;padding-left:20px;font-size:14px;color:#374151;line-height:1.7;">
        <li><strong>Within 24 hours:</strong> Andrew personally builds your AI's voice, tone, services, and transfer rules.</li>
        <li><strong>Setup email:</strong> You'll get a one-click guide to forward your business calls to your AI (~2 minutes).</li>
        <li><strong>Test & go live:</strong> Hear your AI work, then mark it live. Payment link only after you've heard it work.</li>
      </ol>
      <p style="margin:18px 0 6px 0;font-size:14px;color:#374151;">Reply to this email if you have any questions — I'll respond fast.</p>
      <p style="margin:0;font-size:14px;color:#374151;">— Andrew</p>
    </div>
    <p style="text-align:center;margin:18px 0 0 0;font-size:11px;color:#9ca3af;">AI Lead Intel · Apex Growth Investments LLC</p>
  </div>
</body></html>`,
    });
    console.log("CUSTOMER EMAIL SENT to", data.notify_email);
  } catch (e) {
    console.error("CUSTOMER EMAIL FAILED:", e.message);
  }
}

/**
 * Save onboarding row. Returns the row ID.
 */
async function saveOnboardingToSupabase(data) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (!supabaseUrl || !supabaseKey) {
    console.error("SUPABASE creds missing");
    return null;
  }
  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/client_onboarding`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        Prefer: "return=representation",
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
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error("ONBOARDING INSERT FAILED:", res.status, text);
      return null;
    }
    const rows = await res.json().catch(() => []);
    return rows && rows[0] ? rows[0].id : null;
  } catch (error) {
    console.error("ONBOARDING INSERT EXCEPTION:", error.message);
    return null;
  }
}

/**
 * Create a row in the `clients` table. Returns { id, client_slug } or throws.
 */
async function createClientRow(data, onboardingId, finalSlug) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (!supabaseUrl || !supabaseKey) {
    throw new Error("Supabase credentials missing");
  }

  const adminNotes = [
    `Industry: ${data.industry || "—"}`,
    `Forward to: ${data.transfer_primary || "—"}`,
    data.transfer_backup ? `Backup: ${data.transfer_backup}` : null,
    `Hours: ${data.transfer_hours || "—"}`,
    `Personality: ${data.personality || "—"}`,
    `Pricing rule: ${data.pricing_rule || "—"}`,
    data.topics && data.topics.length ? `Topics: ${data.topics.join(", ")}` : null,
  ].filter(Boolean).join("\n");

  const payload = {
    business_name: data.business_name,
    client_slug: finalSlug,
    notify_email: data.notify_email,
    phone_number: data.business_phone || null,
    plan: data.plan,
    status: "trial",
    active: true,
    notes: adminNotes,
    onboarding_id: onboardingId || null,
  };

  console.log("CREATING CLIENT ROW:", { slug: finalSlug, plan: data.plan, email: data.notify_email });

  const res = await fetch(`${supabaseUrl}/rest/v1/clients`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
      Prefer: "return=representation",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error("CLIENT ROW INSERT FAILED:", res.status, text);
    throw new Error(`Could not save client: HTTP ${res.status} — ${text.slice(0, 200)}`);
  }

  const rows = await res.json().catch(() => []);
  const row = rows && rows[0] ? rows[0] : null;
  if (!row) throw new Error("Client row creation returned no row");

  console.log("CLIENT ROW CREATED:", row.id, row.client_slug);
  return row;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).json({ ok: true });
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "Method not allowed" });

  const ip = getClientIp(req);

  // Rate limit
  const limit = rateLimit(`onboarding:${ip}`, 5, 60 * 60);
  if (!limit.ok) {
    res.setHeader('Retry-After', String(limit.retryAfter));
    console.warn(`[onboarding] 🚫 RATE LIMITED ip=${ip}`);
    return res.status(429).json({ success: false, error: "Too many submissions. Try again later." });
  }

  // Honeypot
  let body = req.body || {};
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (_) { body = {}; }
  }
  if (body.website_url || body.company_size_other || body._gotcha) {
    console.warn(`[onboarding] 🍯 HONEYPOT ip=${ip}`);
    return res.status(200).json({ success: true });
  }

  try {
    const data = normalizeData(body);
    console.log("[onboarding] received:", { business: data.business_name, plan: data.plan, slug_from_form: data.client_slug_from_form });

    if (!data.business_name) return res.status(400).json({ success: false, error: "Missing business name" });
    if (!data.notify_email) return res.status(400).json({ success: false, error: "Missing notification email" });

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY;
    if (!supabaseUrl || !supabaseKey) {
      console.error("[onboarding] Supabase env vars missing");
      return res.status(500).json({ success: false, error: "Server misconfigured" });
    }

    // Resolve final slug (use frontend's if available + free, else collision-suffix it)
    const finalSlug = await resolveSlug(data, supabaseUrl, supabaseKey);
    console.log("[onboarding] final slug:", finalSlug);

    // Save onboarding row
    const onboardingId = await saveOnboardingToSupabase(data);

    // Create client row — THIS MUST SUCCEED
    let clientRow;
    try {
      clientRow = await createClientRow(data, onboardingId, finalSlug);
    } catch (e) {
      console.error("[onboarding] client row failed:", e.message);
      // Still notify owner so we don't lose the lead
      await Promise.all([sendNtfyNotification(data), notifyOwnerEmail(data)]);
      return res.status(500).json({ success: false, error: "Could not save client. Please contact hello@aileadintel.com." });
    }

    // Fire off non-blocking notifications (don't await — let them run after response)
    Promise.all([
      sendNtfyNotification(data),
      notifyOwnerEmail(data),
      sendCustomerConfirmation(data, finalSlug),
    ]).catch(e => console.error("[onboarding] notification error:", e));

    return res.status(200).json({
      success: true,
      client_slug: clientRow.client_slug,
      plan: data.plan,
    });

  } catch (error) {
    console.error("[onboarding] FATAL:", error);
    return res.status(500).json({ success: false, error: "Failed to submit onboarding" });
  }
}
