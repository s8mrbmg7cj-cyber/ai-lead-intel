// api/onboarding-submit.js
// Failsafe onboarding handler.
// - Only Supabase failures return 500. Emails/ntfy can never crash the request.
// - createClientRow uses lookup-then-PATCH-or-POST (no on_conflict, no upsert).
// - Sets payment_pending=true, payment_required=true, payment_status='unpaid' on insert.

import { rateLimit, getClientIp } from '../lib/rate-limit.js';
import { Resend } from "resend";

const NTFY_TOPIC = process.env.NTFY_TOPIC || "mcr-leads-andrew-2025";

// Pricing — single source of truth for the API
const PLAN_PRICING = {
  starter: { amount: 97.00, label: "Starter — $97/month" },
  pro: { amount: 297.00, label: "AI Front Desk Pro — $297/month" },
};

// ============================================================
// HELPERS
// ============================================================

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
    report_frequency: data.report_frequency || "",
    report_email: data.report_email || "",
    raw_data: data,
  };
}

function slugifyBase(businessName) {
  return String(businessName || "client")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 50) || "client";
}

async function isSlugTaken(slug, supabaseUrl, supabaseKey) {
  try {
    const r = await fetch(
      `${supabaseUrl}/rest/v1/clients?client_slug=eq.${encodeURIComponent(slug)}&select=id&limit=1`,
      { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } }
    );
    if (!r.ok) return false;
    const rows = await r.json();
    return Array.isArray(rows) && rows.length > 0;
  } catch (_) {
    return false;
  }
}

async function resolveSlug(data, supabaseUrl, supabaseKey) {
  let base = (data.client_slug_from_form || "").trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
  if (!base) base = slugifyBase(data.business_name);

  console.log("[onboarding] 🔧 base slug:", base);

  const taken = await isSlugTaken(base, supabaseUrl, supabaseKey);
  if (!taken) {
    console.log("[onboarding] 🔧 slug is free, using:", base);
    return base;
  }
  const suffix = Math.random().toString(36).slice(2, 6);
  const final = `${base}-${suffix}`;
  console.log("[onboarding] 🔧 slug collided, using:", final);
  return final;
}

// ============================================================
// SUPABASE — onboarding row (non-critical)
// ============================================================

async function saveOnboardingToSupabase(data, supabaseUrl, supabaseKey) {
  console.log("[onboarding] 💾 inserting client_onboarding row...");
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
      console.error("[onboarding] ❌ client_onboarding INSERT FAILED:", res.status, text);
      return null;
    }
    const rows = await res.json().catch(() => []);
    const id = rows && rows[0] ? rows[0].id : null;
    console.log("[onboarding] ✅ client_onboarding row created:", id);
    return id;
  } catch (error) {
    console.error("[onboarding] ❌ client_onboarding EXCEPTION:", error.message);
    return null;
  }
}

// ============================================================
// SUPABASE — clients row (CRITICAL: lookup-then-PATCH-or-POST)
// ============================================================

async function createClientRow(data, onboardingId, finalSlug, supabaseUrl, supabaseKey) {
  const phoneNumber = data.business_phone || null;
  const pricing = PLAN_PRICING[data.plan] || PLAN_PRICING.starter;

  const adminNotes = [
    `Industry: ${data.industry || "—"}`,
    `Forward to: ${data.transfer_primary || "—"}`,
    data.transfer_backup ? `Backup: ${data.transfer_backup}` : null,
    `Hours: ${data.transfer_hours || "—"}`,
    `Personality: ${data.personality || "—"}`,
    `Pricing rule: ${data.pricing_rule || "—"}`,
    data.topics && data.topics.length ? `Topics: ${data.topics.join(", ")}` : null,
  ].filter(Boolean).join("\n");

  const writeHeaders = {
    "Content-Type": "application/json",
    apikey: supabaseKey,
    Authorization: `Bearer ${supabaseKey}`,
    Prefer: "return=representation",
  };
  const readHeaders = {
    apikey: supabaseKey,
    Authorization: `Bearer ${supabaseKey}`,
  };

  // STEP 1 — Lookup
  let existingId = null;
  if (phoneNumber) {
    console.log("[onboarding] 🔍 Looking up client by phone:", phoneNumber);
    try {
      const lookupUrl = `${supabaseUrl}/rest/v1/clients?phone_number=eq.${encodeURIComponent(phoneNumber)}&select=id&limit=1`;
      const lookupRes = await fetch(lookupUrl, { headers: readHeaders });
      if (lookupRes.ok) {
        const rows = await lookupRes.json().catch(() => []);
        if (Array.isArray(rows) && rows.length > 0 && rows[0].id) {
          existingId = rows[0].id;
          console.log("[onboarding] ☎️ EXISTING CLIENT FOUND — id:", existingId);
        } else {
          console.log("[onboarding] ✅ No existing client with this phone");
        }
      } else {
        const text = await lookupRes.text().catch(() => "");
        console.warn("[onboarding] ⚠️ phone lookup non-OK (will INSERT):", lookupRes.status, text);
      }
    } catch (err) {
      console.warn("[onboarding] ⚠️ phone lookup exception (will INSERT):", err.message);
    }
  } else {
    console.log("[onboarding] 🔍 No phone provided — skipping lookup");
  }

  // STEP 2A — UPDATE path
  if (existingId) {
    console.log("[onboarding] 🔄 UPDATING EXISTING CLIENT — id:", existingId);

    const updatePayload = {
      business_name: data.business_name,
      client_slug: finalSlug,
      notify_email: data.notify_email,
      plan: data.plan,
      notes: adminNotes,
      onboarding_id: onboardingId || null,
      report_frequency: data.plan === "starter" ? (data.report_frequency || "monthly") : null,
      report_email: data.plan === "starter" ? (data.report_email || data.notify_email) : null,
      // Payment fields — keep existing if already set, otherwise update plan-based amount
      payment_amount: pricing.amount,
      payment_provider: "paypal",
    };

    const patchUrl = `${supabaseUrl}/rest/v1/clients?id=eq.${existingId}`;
    const patchRes = await fetch(patchUrl, {
      method: "PATCH",
      headers: writeHeaders,
      body: JSON.stringify(updatePayload),
    });

    if (!patchRes.ok) {
      const text = await patchRes.text().catch(() => "");
      console.error("[onboarding] ❌ UPDATE failed:", patchRes.status, text);
      throw new Error(`Could not update client (HTTP ${patchRes.status}): ${text.slice(0, 300)}`);
    }

    const rows = await patchRes.json().catch(() => []);
    const row = rows && rows[0] ? rows[0] : null;
    if (!row) throw new Error("Client update returned no row");

    console.log("[onboarding] ✅ UPDATE SUCCESS — id:", row.id, "slug:", row.client_slug, "plan:", row.plan);
    return { row, existing: true };
  }

  // STEP 2B — INSERT path
  console.log("[onboarding] 🆕 CREATING NEW CLIENT — slug:", finalSlug, "plan:", data.plan, "amount:", pricing.amount);

  const insertPayload = {
    business_name: data.business_name,
    client_slug: finalSlug,
    notify_email: data.notify_email,
    phone_number: phoneNumber,
    plan: data.plan,
    status: "trial",
    active: true,
    notes: adminNotes,
    onboarding_id: onboardingId || null,
    report_frequency: data.plan === "starter" ? (data.report_frequency || "monthly") : null,
    report_email: data.plan === "starter" ? (data.report_email || data.notify_email) : null,
    // Payment fields — required-but-pending on signup
    payment_required: true,
    payment_pending: true,
    payment_status: "unpaid",
    payment_provider: "paypal",
    payment_amount: pricing.amount,
  };

  const insertRes = await fetch(`${supabaseUrl}/rest/v1/clients`, {
    method: "POST",
    headers: writeHeaders,
    body: JSON.stringify(insertPayload),
  });

  if (!insertRes.ok) {
    const text = await insertRes.text().catch(() => "");
    console.error("[onboarding] ❌ INSERT failed:", insertRes.status, text);
    throw new Error(`Could not save client (HTTP ${insertRes.status}): ${text.slice(0, 300)}`);
  }

  const rows = await insertRes.json().catch(() => []);
  const row = rows && rows[0] ? rows[0] : null;
  if (!row) throw new Error("Client insert returned no row");

  console.log("[onboarding] ✅ INSERT SUCCESS — id:", row.id, "slug:", row.client_slug, "amount:", row.payment_amount);
  return { row, existing: false };
}

// ============================================================
// NOTIFICATIONS — fully isolated, never crash the request
// ============================================================

async function safeNtfy(data) {
  try {
    const body = `New AI Lead Intel onboarding
Business: ${data.business_name || "—"}
Industry: ${data.industry || "—"}
Phone: ${data.business_phone || "—"}
Transfer: ${data.transfer_primary || "—"}
Email: ${data.notify_email || "—"}
Plan: ${data.plan}
Submitted: ${new Date().toLocaleString("en-US", { timeZone: "America/Denver" })}`;
    const r = await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
      method: "POST",
      headers: {
        Title: `New Onboarding (${data.plan}): ${data.business_name || "AI Lead Intel"}`,
        Priority: "high",
        Tags: "rocket",
      },
      body,
    });
    if (!r.ok) console.warn("[onboarding] ⚠️ ntfy non-OK:", r.status);
    else console.log("[onboarding] ✅ ntfy sent");
  } catch (err) {
    console.error("[onboarding] ⚠️ ntfy error (non-fatal):", err.message);
  }
}

async function safeOwnerEmail(data) {
  try {
    const resendKey = process.env.RESEND_API_KEY;
    const notifyEmail = process.env.NOTIFY_EMAIL;
    if (!resendKey || !notifyEmail) { console.warn("[onboarding] ⚠️ owner email skipped"); return; }

    const resend = new Resend(resendKey);
    const result = await resend.emails.send({
      from: "AI Lead Intel <onboarding@resend.dev>",
      to: notifyEmail.split(",").map((e) => e.trim()).filter(Boolean),
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
          ${data.plan === "starter" ? `<h3>Lead Reports</h3><p><strong>Frequency:</strong> ${escapeHtml(data.report_frequency || "monthly")}</p><p><strong>Report email:</strong> ${escapeHtml(data.report_email || data.notify_email)}</p>` : ""}
          <h3>Notes</h3>
          <p style="white-space:pre-wrap;">${escapeHtml(data.notes || "—")}</p>
          <hr style="border:none;border-top:1px solid rgba(255,255,255,0.15);margin:24px 0;" />
          <p style="color:#aaa;font-size:12px;">View in admin: <a href="https://aileadintel.com/admin" style="color:#ff6a00;">aileadintel.com/admin</a></p>
        </div>
      `,
    });
    if (result && result.error) console.error("[onboarding] ⚠️ owner email error (non-fatal):", result.error);
    else console.log("[onboarding] ✅ owner email sent");
  } catch (err) {
    console.error("[onboarding] ⚠️ owner email EXCEPTION (non-fatal):", err.message);
  }
}

async function safeCustomerEmail(data, finalSlug) {
  try {
    const resendKey = process.env.RESEND_API_KEY;
    if (!resendKey || !data.notify_email) { console.warn("[onboarding] ⚠️ customer email skipped"); return; }

    const resend = new Resend(resendKey);
    const businessName = data.business_name || "your business";
    const isPro = data.plan === "pro";
    const dashboardLine = isPro
      ? `<p style="margin:0 0 14px 0;font-size:14.5px;color:#374151;line-height:1.55;">Your private dashboard URL is reserved: <a href="https://aileadintel.com/dashboard/${finalSlug}" style="color:#ff6a00;">aileadintel.com/dashboard/${finalSlug}</a></p>`
      : "";
    const reportsLine = !isPro && data.report_frequency
      ? `<p style="margin:0 0 14px 0;font-size:14.5px;color:#374151;line-height:1.55;">You'll get <strong>${escapeHtml(data.report_frequency)}</strong> lead reports sent to <strong>${escapeHtml(data.report_email || data.notify_email)}</strong>.</p>`
      : "";

    const result = await resend.emails.send({
      from: "AI Lead Intel <onboarding@resend.dev>",
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
      ${reportsLine}
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
    if (result && result.error) console.error("[onboarding] ⚠️ customer email error (non-fatal):", result.error);
    else console.log("[onboarding] ✅ customer email sent to", data.notify_email);
  } catch (err) {
    console.error("[onboarding] ⚠️ customer email EXCEPTION (non-fatal):", err.message);
  }
}

async function runAllNotificationsSafely(data, finalSlug) {
  try {
    console.log("[onboarding] 📨 starting notifications...");
    await Promise.allSettled([
      safeNtfy(data),
      safeOwnerEmail(data),
      safeCustomerEmail(data, finalSlug),
    ]);
    console.log("[onboarding] 📨 notifications complete");
  } catch (err) {
    console.error("[onboarding] ⚠️ notifications wrapper exception (non-fatal):", err.message);
  }
}

// ============================================================
// HANDLER
// ============================================================

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).json({ ok: true });
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "Method not allowed" });

  let ip = "unknown";
  try {
    ip = getClientIp(req);
    const limit = rateLimit(`onboarding:${ip}`, 5, 60 * 60);
    if (!limit.ok) {
      res.setHeader("Retry-After", String(limit.retryAfter));
      console.warn(`[onboarding] 🚫 RATE LIMITED ip=${ip}`);
      return res.status(429).json({ success: false, error: "Too many submissions. Try again later." });
    }
  } catch (err) {
    console.error("[onboarding] ⚠️ rate-limit subsystem error:", err.message);
  }

  let body = req.body || {};
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (_) { body = {}; }
  }

  if (body.website_url || body.company_size_other || body._gotcha) {
    console.warn(`[onboarding] 🍯 HONEYPOT TRIGGERED ip=${ip}`);
    return res.status(200).json({ success: true });
  }

  try {
    const data = normalizeData(body);

    console.log("[onboarding] 📥 RECEIVED PAYLOAD:", {
      ip, business: data.business_name, plan: data.plan,
      slug_from_form: data.client_slug_from_form, email: data.notify_email,
      phone: data.business_phone, report_frequency: data.report_frequency,
    });

    if (!data.business_name) {
      return res.status(400).json({ success: false, error: "Missing business name" });
    }
    if (!data.notify_email) {
      return res.status(400).json({ success: false, error: "Missing notification email" });
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY;
    if (!supabaseUrl || !supabaseKey) {
      console.error("[onboarding] ❌ Supabase env vars missing");
      return res.status(500).json({ success: false, error: "Server misconfigured" });
    }

    const finalSlug = await resolveSlug(data, supabaseUrl, supabaseKey);
    console.log("[onboarding] 🔧 FINAL SLUG:", finalSlug);

    const onboardingId = await saveOnboardingToSupabase(data, supabaseUrl, supabaseKey);

    let clientResult;
    try {
      clientResult = await createClientRow(data, onboardingId, finalSlug, supabaseUrl, supabaseKey);
    } catch (err) {
      console.error("[onboarding] ❌ FATAL: clients save failed:", err.message);
      runAllNotificationsSafely(data, finalSlug).catch(() => {});
      return res.status(500).json({
        success: false,
        error: "Could not save your submission. Please email hello@aileadintel.com.",
      });
    }
    const clientRow = clientResult.row;

    runAllNotificationsSafely(data, finalSlug).catch((err) => {
      console.error("[onboarding] ⚠️ notification wrapper:", err.message);
    });

    const responseBody = {
      success: true,
      existing_client: clientResult.existing,
      client_slug: clientRow.client_slug,
      plan: clientRow.plan || data.plan,
      report_frequency: clientRow.report_frequency || null,
      report_email: clientRow.report_email || null,
    };
    console.log("[onboarding] ✅ FINAL RESPONSE:", responseBody);
    return res.status(200).json(responseBody);

  } catch (error) {
    console.error("[onboarding] ❌ UNHANDLED EXCEPTION:", error.message, error.stack);
    return res.status(500).json({
      success: false,
      error: "Unexpected server error. Please email hello@aileadintel.com.",
    });
  }
}
