// api/onboarding-submit.js
import { rateLimit, getClientIp } from '../lib/rate-limit.js';
import { Resend } from "resend";

const NTFY_TOPIC = process.env.NTFY_TOPIC || "mcr-leads-andrew-2025";

const PLAN_PRICING = {
  starter: { amount: 97.00, label: "Starter — $97/month" },
  pro: { amount: 297.00, label: "AI Front Desk Pro — $297/month" },
};

const INDUSTRY_LABELS = {
  self_storage: "Self Storage", hvac: "HVAC", plumbing: "Plumbing",
  electrician: "Electrician", landscaping: "Landscaping / Lawn Care",
  auto_detailing: "Auto Detailing", auto_repair: "Auto Repair",
  salon: "Salon / Spa", pest_control: "Pest Control",
  cleaning: "Cleaning Services", roofing: "Roofing", locksmith: "Locksmith",
  real_estate: "Real Estate", dental: "Dental / Medical", other: "Other",
};

const PERSONALITY_LABELS = {
  warm: "Warm & Conversational — friendly, approachable, talks like a real person",
  professional: "Professional — polished, corporate, formal",
  direct: "Direct — efficient, to-the-point, no fluff",
};

const PRICING_LABELS = {
  yes_specific: "Give exact prices when asked",
  yes_ranges: "Give price ranges only — never exact figures",
  no_quote: "Never quote prices — say 'I'll have someone send you a quote'",
  no_transfer: "Never quote prices — transfer pricing questions to the owner",
};

const TOPIC_LABELS = {
  new_customer: "New customer / booking",
  payments: "Payments / billing",
  support: "Customer support",
  other: "Other",
};

const VALID_STATUSES = new Set(["pending", "active", "paused"]);

function escapeHtml(value) {
  return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
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
    services_offered: data.services_offered || "",
    service_area: data.service_area || "",
    offer_urgent_transfer: data.offer_urgent_transfer || "",
    plan: data.plan === "pro" ? "pro" : "starter",
    client_slug_from_form: data.client_slug || "",
    report_frequency: data.report_frequency || "",
    report_email: data.report_email || "",
    raw_data: data,
  };
}

function slugifyBase(businessName) {
  return String(businessName || "client").toLowerCase().trim().replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, "-").replace(/-+/g, "-").slice(0, 50) || "client";
}

async function isSlugTaken(slug, supabaseUrl, supabaseKey) {
  try {
    const r = await fetch(`${supabaseUrl}/rest/v1/clients?client_slug=eq.${encodeURIComponent(slug)}&select=id&limit=1`, { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } });
    if (!r.ok) return false;
    const rows = await r.json();
    return Array.isArray(rows) && rows.length > 0;
  } catch (_) { return false; }
}

async function resolveSlug(data, supabaseUrl, supabaseKey) {
  let base = (data.client_slug_from_form || "").trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
  if (!base) base = slugifyBase(data.business_name);
  const taken = await isSlugTaken(base, supabaseUrl, supabaseKey);
  if (!taken) return base;
  const suffix = Math.random().toString(36).slice(2, 6);
  return `${base}-${suffix}`;
}

function parseUrgentTransfer(value) {
  if (value === "yes") return true;
  if (value === "no") return false;
  return null;
}

function safeStatus(value) {
  if (typeof value === "string" && VALID_STATUSES.has(value.toLowerCase())) return value.toLowerCase();
  return "pending";
}

function generateAiConfig(data) {
  const businessName = data.business_name || "the business";
  const industryLabel = INDUSTRY_LABELS[data.industry] || data.industry || "service business";
  const personalityLabel = PERSONALITY_LABELS[data.personality] || "warm and friendly";
  const pricingRuleLabel = PRICING_LABELS[data.pricing_rule] || "transfer pricing questions to the owner";
  const services = (data.services_offered || "").trim();
  const serviceArea = (data.service_area || "").trim();
  const hours = (data.transfer_hours || "regular business hours").trim();
  const transferPrimary = (data.transfer_primary || "").trim();
  const transferBackup = (data.transfer_backup || "").trim();
  const pricingExamples = (data.pricing_examples || "").trim();
  const notes = (data.notes || "").trim();
  const topicsList = Array.isArray(data.topics) ? data.topics.map(t => TOPIC_LABELS[t] || t).filter(Boolean) : [];
  const offerUrgent = data.offer_urgent_transfer === "yes";

  let ai_greeting;
  if (data.personality === "professional") ai_greeting = `Good day, thank you for calling ${businessName}. How may I assist you?`;
  else if (data.personality === "direct") ai_greeting = `Thanks for calling ${businessName}. How can I help?`;
  else ai_greeting = `Hey, thanks for calling ${businessName}! What can I do for you today?`;

  const ai_personality = personalityLabel;

  const transferLines = [];
  transferLines.push(`Business hours: ${hours}.`);
  if (transferPrimary) transferLines.push(`Primary transfer number: ${transferPrimary}.`);
  if (transferBackup) transferLines.push(`Backup transfer number: ${transferBackup}.`);
  transferLines.push(`Only transfer when a caller explicitly asks to speak to a human, OR for confirmed emergencies.`);
  if (offerUrgent) {
    transferLines.push(`Urgent call handling: If a caller mentions an emergency, lockout, flooding, urgent access issue, outage, or similar urgent situation: 1) acknowledge the urgency calmly, 2) ask if they would like to be connected with someone immediately, 3) only transfer if the caller confirms yes. Never transfer automatically without asking.`);
  } else {
    transferLines.push(`Urgent calls: Capture the lead in detail (name, callback number, nature of urgency), assure the caller someone will be in touch quickly, and notify the owner via the lead summary. Do NOT transfer.`);
  }
  const transfer_behavior = transferLines.join(" ");

  const servicesParts = [];
  servicesParts.push(`${businessName} is a ${industryLabel.toLowerCase()} business.`);
  if (services) servicesParts.push(`Services offered: ${services}.`);
  if (serviceArea) servicesParts.push(`Service area: ${serviceArea}.`);
  const services_summary = servicesParts.join(" ");

  const faqParts = [];
  faqParts.push(`Pricing rule: ${pricingRuleLabel}.`);
  if (pricingExamples) faqParts.push(`Common prices the AI should know:\n${pricingExamples}`);
  if (topicsList.length) faqParts.push(`Most common reasons people call: ${topicsList.join(", ")}.`);
  if (notes) faqParts.push(`Additional notes from the owner: ${notes}`);
  const faq_summary = faqParts.join("\n\n");

  const promptLines = [];
  promptLines.push(`You are the AI receptionist for ${businessName}, a ${industryLabel.toLowerCase()} business.`);
  promptLines.push("");
  promptLines.push(`# OPENING\nGreeting: "${ai_greeting}"\n`);
  promptLines.push(`# PERSONALITY\n${ai_personality}\n`);
  promptLines.push(`# BUSINESS DETAILS`);
  if (services) promptLines.push(`Services offered: ${services}`);
  if (serviceArea) promptLines.push(`Service area: ${serviceArea}`);
  promptLines.push(`Hours: ${hours}\n`);
  promptLines.push(`# WHAT TO COLLECT ON EVERY CALL\n- Caller's full name\n- Best callback number\n- What they need\n- Urgency\n- Address if relevant\n`);
  promptLines.push(`# PRICING POLICY\n${pricingRuleLabel}`);
  if (pricingExamples) promptLines.push(`\nKnown prices:\n${pricingExamples}`);
  promptLines.push("");
  promptLines.push(`# CALL TRANSFER RULES\n${transfer_behavior}\n`);
  if (topicsList.length) promptLines.push(`# COMMON CALL REASONS\nBe ready for: ${topicsList.join(", ")}\n`);
  if (notes) promptLines.push(`# IMPORTANT NOTES FROM THE OWNER\n${notes}\n`);
  promptLines.push(`# HARD RULES\n- Never make up prices, services, or hours.\n- Never promise something the business hasn't said it can do.\n- If you don't know, capture the info and promise a callback.\n- Stay in character as ${businessName}'s receptionist at all times.\n- Keep responses short and conversational.\n- Confirm the caller's contact info before ending the call.`);

  return { ai_prompt: promptLines.join("\n"), ai_greeting, ai_personality, transfer_behavior, services_summary, faq_summary };
}

async function saveOnboardingToSupabase(data, supabaseUrl, supabaseKey) {
  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/client_onboarding`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}`, Prefer: "return=representation" },
      body: JSON.stringify({
        business_name: data.business_name, industry: data.industry, business_phone: data.business_phone,
        forward_number: data.transfer_primary, backup_number: data.transfer_backup,
        voicemail_email: data.notify_email, transfer_hours: data.transfer_hours,
        call_reasons: data.topics, payment_link: data.payment_link, booking_link: data.booking_link,
        info_link: data.website, tone: data.personality, notes: data.notes,
        services_offered: data.services_offered, service_area: data.service_area,
        offer_urgent_transfer: parseUrgentTransfer(data.offer_urgent_transfer),
        status: "new", raw_data: data.raw_data,
      }),
    });
    if (!res.ok) { const text = await res.text().catch(() => ""); console.error("[onboarding] client_onboarding INSERT failed:", res.status, text); return null; }
    const rows = await res.json().catch(() => []);
    return rows && rows[0] ? rows[0].id : null;
  } catch (error) { console.error("[onboarding] client_onboarding EXCEPTION:", error.message); return null; }
}

async function createClientRow(data, onboardingId, finalSlug, supabaseUrl, supabaseKey) {
  const phoneNumber = data.business_phone || null;
  const pricing = PLAN_PRICING[data.plan] || PLAN_PRICING.starter;
  const urgentBool = parseUrgentTransfer(data.offer_urgent_transfer);
  const aiConfig = generateAiConfig(data);

  const adminNotes = [
    `Industry: ${data.industry || "—"}`, `Forward to: ${data.transfer_primary || "—"}`,
    data.transfer_backup ? `Backup: ${data.transfer_backup}` : null,
    `Hours: ${data.transfer_hours || "—"}`, `Personality: ${data.personality || "—"}`,
    `Pricing rule: ${data.pricing_rule || "—"}`,
    data.services_offered ? `Services: ${data.services_offered}` : null,
    data.service_area ? `Service area: ${data.service_area}` : null,
    urgentBool !== null ? `Urgent transfer: ${urgentBool ? "Yes" : "No"}` : null,
    data.topics && data.topics.length ? `Topics: ${data.topics.join(", ")}` : null,
  ].filter(Boolean).join("\n");

  const writeHeaders = { "Content-Type": "application/json", apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}`, Prefer: "return=representation" };
  const readHeaders = { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` };

  let existingId = null;
  if (phoneNumber) {
    try {
      const lookupRes = await fetch(`${supabaseUrl}/rest/v1/clients?phone_number=eq.${encodeURIComponent(phoneNumber)}&select=id&limit=1`, { headers: readHeaders });
      if (lookupRes.ok) {
        const rows = await lookupRes.json().catch(() => []);
        if (Array.isArray(rows) && rows.length > 0 && rows[0].id) existingId = rows[0].id;
      }
    } catch (err) { console.warn("[onboarding] phone lookup exception:", err.message); }
  }

  const baseFields = {
    business_name: data.business_name, client_slug: finalSlug, notify_email: data.notify_email,
    plan: data.plan, status: safeStatus("pending"), notes: adminNotes,
    onboarding_id: onboardingId || null,
    report_frequency: data.plan === "starter" ? (data.report_frequency || "monthly") : null,
    report_email: data.plan === "starter" ? (data.report_email || data.notify_email) : null,
    services_offered: data.services_offered, service_area: data.service_area,
    offer_urgent_transfer: urgentBool, payment_amount: pricing.amount, payment_provider: "paypal",
    ai_prompt: aiConfig.ai_prompt, ai_greeting: aiConfig.ai_greeting,
    ai_personality: aiConfig.ai_personality, transfer_behavior: aiConfig.transfer_behavior,
    services_summary: aiConfig.services_summary, faq_summary: aiConfig.faq_summary,
  };

  if (existingId) {
    const patchRes = await fetch(`${supabaseUrl}/rest/v1/clients?id=eq.${existingId}`, { method: "PATCH", headers: writeHeaders, body: JSON.stringify(baseFields) });
    if (!patchRes.ok) { const text = await patchRes.text().catch(() => ""); throw new Error(`Could not update client (HTTP ${patchRes.status}): ${text.slice(0, 300)}`); }
    const rows = await patchRes.json().catch(() => []);
    const row = rows && rows[0] ? rows[0] : null;
    if (!row) throw new Error("Client update returned no row");
    return { row, existing: true };
  }

  const insertPayload = {
    ...baseFields, phone_number: phoneNumber, active: true,
    payment_required: true, payment_pending: true, payment_status: "unpaid",
  };
  const insertRes = await fetch(`${supabaseUrl}/rest/v1/clients`, { method: "POST", headers: writeHeaders, body: JSON.stringify(insertPayload) });
  if (!insertRes.ok) { const text = await insertRes.text().catch(() => ""); throw new Error(`Could not save client (HTTP ${insertRes.status}): ${text.slice(0, 300)}`); }
  const rows = await insertRes.json().catch(() => []);
  const row = rows && rows[0] ? rows[0] : null;
  if (!row) throw new Error("Client insert returned no row");
  return { row, existing: false };
}

async function safeNtfy(data) {
  try {
    const body = `New AI Lead Intel onboarding\nBusiness: ${data.business_name || "—"}\nIndustry: ${data.industry || "—"}\nPhone: ${data.business_phone || "—"}\nServices: ${data.services_offered || "—"}\nService area: ${data.service_area || "—"}\nTransfer: ${data.transfer_primary || "—"}\nEmail: ${data.notify_email || "—"}\nPlan: ${data.plan}\nSubmitted: ${new Date().toLocaleString("en-US", { timeZone: "America/Denver" })}`;
    await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, { method: "POST", headers: { Title: `New Onboarding (${data.plan}): ${data.business_name || "AI Lead Intel"}`, Priority: "high", Tags: "rocket" }, body });
  } catch (err) { console.error("[onboarding] ntfy error (non-fatal):", err.message); }
}

async function safeOwnerEmail(data) {
  try {
    const resendKey = process.env.RESEND_API_KEY;
    const notifyEmail = process.env.NOTIFY_EMAIL;
    if (!resendKey || !notifyEmail) return;
    const resend = new Resend(resendKey);
    const urgentDisplay = data.offer_urgent_transfer === "yes" ? "Yes — offer transfer" : data.offer_urgent_transfer === "no" ? "No — capture & notify" : "—";
    await resend.emails.send({
      from: "AI Lead Intel <hello@aileadintel.com>",
      to: notifyEmail.split(",").map((e) => e.trim()).filter(Boolean),
      subject: `[${data.plan.toUpperCase()}] New onboarding: ${data.business_name || "New lead"}`,
      html: `<div style="font-family:Arial,sans-serif;max-width:650px;margin:0 auto;background:#0a0a0c;color:#fff;padding:28px;border-radius:12px;"><h2 style="color:#ff6a00;margin-top:0;">New AI Lead Intel Onboarding</h2><p><strong>Plan:</strong> ${escapeHtml(data.plan.toUpperCase())}</p><h3>Business</h3><p><strong>Name:</strong> ${escapeHtml(data.business_name)}</p><p><strong>Industry:</strong> ${escapeHtml(data.industry)}</p><p><strong>Phone:</strong> ${escapeHtml(data.business_phone)}</p><p><strong>Services:</strong> ${escapeHtml(data.services_offered || "—")}</p><p><strong>Area:</strong> ${escapeHtml(data.service_area || "—")}</p><h3>Calls</h3><p><strong>Transfer:</strong> ${escapeHtml(data.transfer_primary)} / ${escapeHtml(data.transfer_backup || "—")}</p><p><strong>Email:</strong> ${escapeHtml(data.notify_email)}</p><p><strong>Hours:</strong> ${escapeHtml(data.transfer_hours)}</p><p><strong>Urgent:</strong> ${escapeHtml(urgentDisplay)}</p><h3>Topics</h3><p>${escapeHtml((data.topics || []).join(", ") || "—")}</p><h3>Personality / Pricing</h3><p><strong>Tone:</strong> ${escapeHtml(data.personality || "—")}</p><p><strong>Pricing:</strong> ${escapeHtml(data.pricing_rule || "—")}</p><p><strong>Examples:</strong><br>${escapeHtml(data.pricing_examples || "—")}</p><h3>Notes</h3><p style="white-space:pre-wrap;">${escapeHtml(data.notes || "—")}</p></div>`,
    });
  } catch (err) { console.error("[onboarding] owner email error (non-fatal):", err.message); }
}

async function safeCustomerEmail(data, finalSlug) {
  try {
    const resendKey = process.env.RESEND_API_KEY;
    if (!resendKey || !data || !data.notify_email) return;
    const resend = new Resend(resendKey);
    const businessName = data.business_name || "your business";
    const isPro = data.plan === "pro";
    const reportFreq = (data.report_frequency || "monthly").toLowerCase();
    const reportEmail = data.report_email || data.notify_email;
    const reportFreqLabel = reportFreq === "weekly" ? "every Monday morning" : "on the 1st of each month";

    const dashboardBlock = isPro ? `<div style="background:linear-gradient(135deg,rgba(255,106,0,0.06),transparent);border:1px solid rgba(255,106,0,0.22);border-radius:12px;padding:18px 20px;margin:0 0 20px 0;"><div style="font-family:monospace;font-size:10px;color:#ff6a00;letter-spacing:0.14em;text-transform:uppercase;font-weight:700;margin-bottom:8px;">★ Your Pro Dashboard</div><a href="https://aileadintel.com/dashboard/${finalSlug}" style="display:inline-block;font-family:monospace;font-size:13px;color:#ff6a00;background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:8px 12px;text-decoration:none;">aileadintel.com/dashboard/${finalSlug}</a></div>` : "";
    const reportsBlock = !isPro ? `<div style="background:linear-gradient(135deg,rgba(255,106,0,0.06),transparent);border:1px solid rgba(255,106,0,0.22);border-radius:12px;padding:18px 20px;margin:0 0 20px 0;"><div style="font-family:monospace;font-size:10px;color:#ff6a00;letter-spacing:0.14em;text-transform:uppercase;font-weight:700;margin-bottom:8px;">★ Your lead reports</div><p style="margin:0 0 6px 0;font-size:14px;color:#111827;font-weight:600;">We'll email you ${escapeHtml(reportFreqLabel)}.</p><p style="margin:0;font-size:13px;color:#6b7280;">Sent to <strong>${escapeHtml(reportEmail)}</strong>.</p></div>` : "";

    await resend.emails.send({
      from: "AI Lead Intel <hello@aileadintel.com>",
      to: [data.notify_email],
      replyTo: "hello@aileadintel.com",
      subject: `We got your onboarding — ${businessName}`,
      html: `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="margin:0;padding:0;font-family:-apple-system,sans-serif;background:#f9fafb;"><div style="max-width:560px;margin:0 auto;padding:32px 20px;"><div style="background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:36px 32px;"><div style="display:flex;align-items:center;gap:10px;margin-bottom:24px;"><div style="width:30px;height:30px;border-radius:8px;background:linear-gradient(135deg,#ff6a00,#ff9a00);"></div><strong style="font-size:14px;color:#111827;">AI Lead Intel</strong></div><h1 style="font-size:22px;font-weight:600;color:#111827;margin:0 0 14px 0;">We got your onboarding ✅</h1><p style="margin:0 0 16px 0;font-size:15px;color:#374151;">Hey ${escapeHtml(businessName)},</p><p style="margin:0 0 20px 0;font-size:15px;color:#374151;">Thanks for signing up for the <strong>${isPro ? "AI Front Desk Pro" : "Starter"}</strong> plan. We've got everything we need to start building your AI receptionist.</p>${dashboardBlock}${reportsBlock}<h2 style="font-size:16px;font-weight:600;color:#111827;margin:24px 0 12px 0;">What happens next</h2><ol style="margin:0 0 20px 0;padding-left:20px;font-size:14px;color:#374151;line-height:1.7;"><li><strong>Within 24 hours:</strong> Our team builds your AI's voice, tone, services, and transfer rules.</li><li><strong>Setup email:</strong> You'll get a one-click guide to forward your business calls to your AI.</li><li><strong>Test &amp; go live:</strong> Hear your AI work, then mark it live.</li></ol><p style="margin:18px 0 6px 0;font-size:14px;color:#374151;">Reply anytime — our team responds fast.</p><p style="margin:0;font-size:14px;color:#374151;">— AI Lead Intel</p></div><p style="text-align:center;margin:18px 0 0 0;font-size:11px;color:#9ca3af;">AI Lead Intel · Apex Growth Investments LLC</p></div></body></html>`,
    });
  } catch (err) { console.error("[onboarding] customer email error (non-fatal):", err.message); }
}

async function runAllNotificationsSafely(data, finalSlug) {
  try { await Promise.allSettled([safeNtfy(data), safeOwnerEmail(data), safeCustomerEmail(data, finalSlug)]); }
  catch (err) { console.error("[onboarding] notifications wrapper exception:", err.message); }
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).json({ ok: true });
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "Method not allowed" });

  let ip = "unknown";
  try {
    ip = getClientIp(req);
    const limit = rateLimit(`onboarding:${ip}`, 5, 60 * 60);
    if (!limit.ok) { res.setHeader("Retry-After", String(limit.retryAfter)); return res.status(429).json({ success: false, error: "Too many submissions." }); }
  } catch (err) { console.error("[onboarding] rate-limit error:", err.message); }

  let body = req.body || {};
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (_) { body = {}; } }

  if (body.website_url || body.company_size_other || body._gotcha) return res.status(200).json({ success: true });

  try {
    const data = normalizeData(body);
    if (!data.business_name) return res.status(400).json({ success: false, error: "Missing business name" });
    if (!data.notify_email) return res.status(400).json({ success: false, error: "Missing notification email" });

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY;
    if (!supabaseUrl || !supabaseKey) return res.status(500).json({ success: false, error: "Server misconfigured" });

    const finalSlug = await resolveSlug(data, supabaseUrl, supabaseKey);
    const onboardingId = await saveOnboardingToSupabase(data, supabaseUrl, supabaseKey);

    let clientResult;
    try { clientResult = await createClientRow(data, onboardingId, finalSlug, supabaseUrl, supabaseKey); }
    catch (err) {
      console.error("[onboarding] FATAL: clients save failed:", err.message);
      try { await runAllNotificationsSafely(data, finalSlug); } catch (_) {}
      return res.status(500).json({ success: false, error: "Could not save your submission. Please email hello@aileadintel.com." });
    }
    const clientRow = clientResult.row;

    try { await runAllNotificationsSafely(data, finalSlug); } catch (notifyErr) { console.error("[onboarding] notification error swallowed:", notifyErr.message); }

    // Build PayPal redirect
    const paypalStarterUrl = process.env.PAYPAL_STARTER_URL || "";
    const paypalProUrl = process.env.PAYPAL_PRO_URL || "";
    const paypalUrl = (clientRow.plan || data.plan) === "pro" ? paypalProUrl : paypalStarterUrl;
    let paypalRedirect = paypalUrl;
    if (paypalRedirect) {
      const sep = paypalRedirect.includes("?") ? "&" : "?";
      paypalRedirect = `${paypalRedirect}${sep}custom_id=${encodeURIComponent(clientRow.client_slug)}`;
    }

    const responseBody = {
      success: true,
      existing_client: clientResult.existing,
      client_slug: clientRow.client_slug,
      plan: clientRow.plan || data.plan,
      business_name: clientRow.business_name || data.business_name || "",
      report_frequency: clientRow.report_frequency || null,
      report_email: clientRow.report_email || null,
      paypal_redirect: paypalRedirect,
    };
    console.log("[onboarding] FINAL RESPONSE:", { ...responseBody, paypal_redirect: paypalRedirect ? "(set)" : "(empty)" });
    return res.status(200).json(responseBody);
  } catch (error) {
    console.error("[onboarding] UNHANDLED EXCEPTION:", error.message);
    return res.status(500).json({ success: false, error: "Unexpected server error." });
  }
}
