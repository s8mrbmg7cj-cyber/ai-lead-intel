// api/onboarding-submit.js
import { rateLimit, getClientIp } from '../lib/rate-limit.js';
import { Resend } from "resend";
import { buildPaypalRedirect } from '../lib/paypal-redirect.js';

const NTFY_TOPIC = process.env.NTFY_TOPIC || "mcr-leads-andrew-2025";
const PLAN_PRICING = { starter: { amount: 97.00 }, pro: { amount: 297.00 } };

const INDUSTRY_LABELS = { self_storage: "Self Storage", hvac: "HVAC", plumbing: "Plumbing", electrician: "Electrician", landscaping: "Landscaping / Lawn Care", auto_detailing: "Auto Detailing", auto_repair: "Auto Repair", salon: "Salon / Spa", pest_control: "Pest Control", cleaning: "Cleaning Services", roofing: "Roofing", locksmith: "Locksmith", real_estate: "Real Estate", dental: "Dental / Medical", other: "Other" };
const PERSONALITY_LABELS = { warm: "Warm & Conversational — friendly, approachable, talks like a real person", professional: "Professional — polished, corporate, formal", direct: "Direct — efficient, to-the-point, no fluff" };
const PRICING_LABELS = { yes_specific: "Give exact prices when asked", yes_ranges: "Give price ranges only — never exact figures", no_quote: "Never quote prices — say 'I'll have someone send you a quote'", no_transfer: "Never quote prices — transfer pricing questions to the owner" };
const TOPIC_LABELS = { new_customer: "New customer / booking", payments: "Payments / billing", support: "Customer support", other: "Other" };
const VALID_STATUSES = new Set(["pending", "active", "paused"]);

const EMERGENCY_GUIDANCE = {
  plumbing: "If the caller mentions active flooding, a burst pipe, no water shut-off, or a gas leak, calmly say: 'This sounds urgent — please call 911 or your local emergency line right now. We'll follow up as soon as we receive your message.' Then capture their name and number.",
  hvac: "If the caller mentions no heat or AC in extreme weather, a gas smell, or carbon monoxide concerns, calmly say: 'Please contact 911 or your gas company right away if you smell gas. We'll be in touch as soon as we get your message.' Capture their name and number.",
  electrician: "If the caller mentions sparks, exposed wires, a burning smell, or smoke, calmly say: 'Please call 911 right away if there's smoke or fire. We'll respond as soon as we receive your message.' Then capture their info.",
  self_storage: "If the caller says they've been locked in, locked out after hours, or there's a security issue, direct them to local non-emergency services first. Capture their name, unit number, and callback number.",
  locksmith: "If the caller says they're locked in somewhere unsafe or in danger, direct them to 911 first. For standard lockouts, capture their location and callback number and let them know someone will respond quickly.",
  roofing: "If the caller mentions an active leak causing damage, structural failure, or a downed power line, direct them to 911 or their insurance carrier first. Capture their info for a fast follow-up.",
  pest_control: "If the caller mentions a venomous animal or serious health hazard, direct them to local animal control or 911. For routine pest issues, capture their info and urgency level.",
  auto_repair: "If the caller says their vehicle is unsafe to drive or they're stranded, direct them to roadside assistance or 911. For routine issues, capture vehicle info, location, and urgency.",
  dental: "If the caller mentions severe bleeding, swelling, or trauma, direct them to their nearest emergency room. Capture their info for follow-up.",
  real_estate: "If the caller mentions a safety or security emergency at a property, direct them to 911 first. Capture property address and their callback info.",
  cleaning: "If there's a serious safety concern at the property, direct the caller to 911 or building management first. Capture their info for follow-up.",
  salon: "If the caller mentions a serious allergic reaction or injury, direct them to 911. Capture their info for follow-up.",
  auto_detailing: "If there's a serious safety concern, direct the caller to 911 first. Capture their info for follow-up.",
  landscaping: "If the caller mentions a downed power line, gas leak, or injury, direct them to 911 first. Capture info for follow-up.",
  other: "If the caller mentions any urgent or unsafe situation, direct them to contact emergency services right away. Capture their name and callback number for follow-up.",
};

function escapeHtml(value) { return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;"); }

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
  return `${base}-${Math.random().toString(36).slice(2, 6)}`;
}

function parseUrgentTransfer(value) { if (value === "yes") return true; if (value === "no") return false; return null; }
function safeStatus(value) { if (typeof value === "string" && VALID_STATUSES.has(value.toLowerCase())) return value.toLowerCase(); return "pending"; }

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
  const emergencyGuidance = EMERGENCY_GUIDANCE[data.industry] || EMERGENCY_GUIDANCE.other;

  let ai_greeting;
  if (data.personality === "professional") ai_greeting = `Thank you for calling ${businessName}. How may I assist you?`;
  else if (data.personality === "direct") ai_greeting = `Thanks for calling ${businessName}. How can I help?`;
  else ai_greeting = `Thanks for calling ${businessName}. How can I help you today?`;

  const ai_personality = personalityLabel;

  const transferLines = [];
  transferLines.push(`Business hours: ${hours}.`);
  if (transferPrimary) transferLines.push(`Primary transfer: ${transferPrimary}.`);
  if (transferBackup) transferLines.push(`Backup transfer: ${transferBackup}.`);
  transferLines.push(`Only transfer when the caller explicitly asks to speak to someone, or for a confirmed emergency.`);
  if (offerUrgent) {
    transferLines.push(`Emergency transfers: If a caller mentions an emergency, follow the emergency guidance below. After acknowledging and giving safety instructions, ask if they'd like to be connected with someone immediately. Only transfer if they confirm yes.`);
  } else {
    transferLines.push(`Emergency handling: Follow the emergency guidance below. Do NOT transfer. Capture their info thoroughly and notify the owner.`);
  }
  const transfer_behavior = transferLines.join(" ");

  const servicesParts = [`${businessName} is a ${industryLabel.toLowerCase()} business.`];
  if (services) servicesParts.push(`Services: ${services}.`);
  if (serviceArea) servicesParts.push(`Service area: ${serviceArea}.`);
  const services_summary = servicesParts.join(" ");

  const faqParts = [`Pricing rule: ${pricingRuleLabel}.`];
  if (pricingExamples) faqParts.push(`Known prices:\n${pricingExamples}`);
  if (topicsList.length) faqParts.push(`Common reasons people call: ${topicsList.join(", ")}.`);
  if (notes) faqParts.push(`Notes from the owner: ${notes}`);
  const faq_summary = faqParts.join("\n\n");

  const promptLines = [];
  promptLines.push(`You are the AI receptionist for ${businessName}, a ${industryLabel.toLowerCase()} business.`);
  promptLines.push("");
  promptLines.push(`# OPENING`);
  promptLines.push(`Greeting: "${ai_greeting}"`);
  promptLines.push("");
  promptLines.push(`# PERSONALITY`);
  promptLines.push(ai_personality);
  promptLines.push("");
  promptLines.push(`# BUSINESS DETAILS`);
  if (services) promptLines.push(`Services offered: ${services}`);
  if (serviceArea) promptLines.push(`Service area: ${serviceArea}`);
  promptLines.push(`Hours: ${hours}`);
  promptLines.push("");
  promptLines.push(`# WHAT TO COLLECT ON EVERY CALL`);
  promptLines.push(`- Caller's full name`);
  promptLines.push(`- Best callback number`);
  promptLines.push(`- What they need (service, issue, or question)`);
  promptLines.push(`- Urgency level`);
  promptLines.push(`- Address or location if relevant`);
  promptLines.push("");
  promptLines.push(`# PRICING POLICY`);
  promptLines.push(pricingRuleLabel);
  if (pricingExamples) { promptLines.push(""); promptLines.push(`Known prices you may reference:`); promptLines.push(pricingExamples); }
  promptLines.push("");
  promptLines.push(`# CALL TRANSFER RULES`);
  promptLines.push(transfer_behavior);
  promptLines.push("");
  promptLines.push(`# EMERGENCY HANDLING`);
  promptLines.push(emergencyGuidance);
  promptLines.push("");
  if (topicsList.length) { promptLines.push(`# COMMON CALL REASONS`); promptLines.push(`Be ready for: ${topicsList.join(", ")}`); promptLines.push(""); }
  if (notes) { promptLines.push(`# IMPORTANT NOTES FROM THE OWNER`); promptLines.push(notes); promptLines.push(""); }
  promptLines.push(`# HARD RULES`);
  promptLines.push(`- Never invent prices, services, or hours.`);
  promptLines.push(`- Never promise something the business hasn't confirmed it offers.`);
  promptLines.push(`- For emergencies, always direct the caller to emergency services first.`);
  promptLines.push(`- If unsure, capture the info and promise a callback. Don't guess.`);
  promptLines.push(`- Stay in character as ${businessName}'s receptionist.`);
  promptLines.push(`- Keep responses short and natural — like a real person.`);
  promptLines.push(`- Confirm contact info before ending the call.`);

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
    if (!res.ok) { const t = await res.text().catch(() => ""); console.error("[onboarding] onboarding insert failed:", res.status, t); return null; }
    const rows = await res.json().catch(() => []);
    return rows && rows[0] ? rows[0].id : null;
  } catch (e) { console.error("[onboarding] onboarding EXC:", e.message); return null; }
}

async function createClientRow(data, onboardingId, finalSlug, supabaseUrl, supabaseKey) {
  const phoneNumber = data.business_phone || null;
  const pricing = PLAN_PRICING[data.plan] || PLAN_PRICING.starter;
  const urgentBool = parseUrgentTransfer(data.offer_urgent_transfer);
  const aiConfig = generateAiConfig(data);
  console.log("[onboarding] AI prompt generated:", aiConfig.ai_prompt.length, "chars");

  const adminNotes = [
    `Industry: ${data.industry || "—"}`, `Forward: ${data.transfer_primary || "—"}`,
    data.transfer_backup ? `Backup: ${data.transfer_backup}` : null,
    `Hours: ${data.transfer_hours || "—"}`, `Personality: ${data.personality || "—"}`,
    `Pricing rule: ${data.pricing_rule || "—"}`,
    data.services_offered ? `Services: ${data.services_offered}` : null,
    data.service_area ? `Area: ${data.service_area}` : null,
    urgentBool !== null ? `Urgent transfer: ${urgentBool ? "Yes" : "No"}` : null,
    data.topics && data.topics.length ? `Topics: ${data.topics.join(", ")}` : null,
  ].filter(Boolean).join("\n");

  const writeHeaders = { "Content-Type": "application/json", apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}`, Prefer: "return=representation" };
  const readHeaders = { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` };

  let existingId = null;
  if (phoneNumber) {
    try {
      const r = await fetch(`${supabaseUrl}/rest/v1/clients?phone_number=eq.${encodeURIComponent(phoneNumber)}&select=id&limit=1`, { headers: readHeaders });
      if (r.ok) { const rows = await r.json().catch(() => []); if (rows[0]) existingId = rows[0].id; }
    } catch (e) { console.warn("[onboarding] phone lookup:", e.message); }
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
    const r = await fetch(`${supabaseUrl}/rest/v1/clients?id=eq.${existingId}`, { method: "PATCH", headers: writeHeaders, body: JSON.stringify(baseFields) });
    if (!r.ok) { const t = await r.text().catch(() => ""); throw new Error(`Update failed (${r.status}): ${t.slice(0,300)}`); }
    const rows = await r.json().catch(() => []);
    const row = rows[0]; if (!row) throw new Error("Update returned no row");
    return { row, existing: true };
  }

  const insertPayload = { ...baseFields, phone_number: phoneNumber, active: true, payment_required: true, payment_pending: true, payment_status: "unpaid" };
  const r = await fetch(`${supabaseUrl}/rest/v1/clients`, { method: "POST", headers: writeHeaders, body: JSON.stringify(insertPayload) });
  if (!r.ok) { const t = await r.text().catch(() => ""); throw new Error(`Insert failed (${r.status}): ${t.slice(0,300)}`); }
  const rows = await r.json().catch(() => []);
  const row = rows[0]; if (!row) throw new Error("Insert returned no row");
  return { row, existing: false };
}

async function safeNtfy(data) {
  try {
    const body = `New onboarding\nBusiness: ${data.business_name}\nIndustry: ${data.industry}\nPhone: ${data.business_phone}\nEmail: ${data.notify_email}\nPlan: ${data.plan}`;
    await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, { method: "POST", headers: { Title: `New Onboarding (${data.plan}): ${data.business_name}`, Priority: "high", Tags: "rocket" }, body });
  } catch (e) { console.error("[onboarding] ntfy:", e.message); }
}

async function safeOwnerEmail(data) {
  try {
    const resendKey = process.env.RESEND_API_KEY;
    const notifyEmail = process.env.NOTIFY_EMAIL;
    if (!resendKey || !notifyEmail) return;
    const resend = new Resend(resendKey);
    await resend.emails.send({
      from: "AI Lead Intel <hello@aileadintel.com>",
      to: notifyEmail.split(",").map(e => e.trim()).filter(Boolean),
      subject: `[${data.plan.toUpperCase()}] New onboarding: ${data.business_name}`,
      html: `<div style="font-family:Arial,sans-serif;max-width:650px;margin:0 auto;background:#0a0a0c;color:#fff;padding:28px;border-radius:12px;"><h2 style="color:#ff6a00;margin-top:0;">New Onboarding</h2><p><strong>Plan:</strong> ${escapeHtml(data.plan.toUpperCase())}</p><p><strong>Business:</strong> ${escapeHtml(data.business_name)}</p><p><strong>Industry:</strong> ${escapeHtml(data.industry)}</p><p><strong>Phone:</strong> ${escapeHtml(data.business_phone)}</p><p><strong>Email:</strong> ${escapeHtml(data.notify_email)}</p><p><strong>Services:</strong> ${escapeHtml(data.services_offered || "—")}</p><p><strong>Area:</strong> ${escapeHtml(data.service_area || "—")}</p><p><strong>Notes:</strong><br>${escapeHtml(data.notes || "—")}</p></div>`,
    });
  } catch (e) { console.error("[onboarding] owner email:", e.message); }
}

async function safeCustomerEmail(data, finalSlug) {
  try {
    const resendKey = process.env.RESEND_API_KEY;
    if (!resendKey || !data.notify_email) return;
    const resend = new Resend(resendKey);
    const businessName = data.business_name || "your business";
    const isPro = data.plan === "pro";
    const dashboardBlock = isPro ? `<div style="background:linear-gradient(135deg,rgba(255,106,0,0.06),transparent);border:1px solid rgba(255,106,0,0.22);border-radius:12px;padding:18px 20px;margin:0 0 20px 0;"><div style="font-family:monospace;font-size:10px;color:#ff6a00;letter-spacing:0.14em;text-transform:uppercase;font-weight:700;margin-bottom:8px;">★ Your Pro Dashboard</div><a href="https://aileadintel.com/dashboard/${finalSlug}" style="display:inline-block;font-family:monospace;font-size:13px;color:#ff6a00;background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:8px 12px;text-decoration:none;">aileadintel.com/dashboard/${finalSlug}</a></div>` : "";
    await resend.emails.send({
      from: "AI Lead Intel <hello@aileadintel.com>",
      to: [data.notify_email],
      replyTo: "hello@aileadintel.com",
      subject: `We got your onboarding — ${businessName}`,
      html: `<!DOCTYPE html><html><body style="margin:0;padding:0;font-family:-apple-system,sans-serif;background:#f9fafb;"><div style="max-width:560px;margin:0 auto;padding:32px 20px;"><div style="background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:36px 32px;"><div style="display:flex;align-items:center;gap:10px;margin-bottom:24px;"><div style="width:30px;height:30px;border-radius:8px;background:linear-gradient(135deg,#ff6a00,#ff9a00);"></div><strong style="font-size:14px;color:#111827;">AI Lead Intel</strong></div><h1 style="font-size:22px;font-weight:600;color:#111827;margin:0 0 14px 0;">We got your onboarding ✅</h1><p style="margin:0 0 16px 0;font-size:15px;color:#374151;">Hey ${escapeHtml(businessName)},</p><p style="margin:0 0 20px 0;font-size:15px;color:#374151;">Thanks for signing up for the <strong>${isPro ? "AI Front Desk Pro" : "Starter"}</strong> plan.</p>${dashboardBlock}<h2 style="font-size:16px;font-weight:600;color:#111827;margin:24px 0 12px 0;">What happens next</h2><ol style="margin:0 0 20px 0;padding-left:20px;font-size:14px;color:#374151;line-height:1.7;"><li><strong>Within 24 hours:</strong> Our team builds your AI's voice, tone, services, and transfer rules.</li><li><strong>Setup email:</strong> You'll get a one-click guide to forward your business calls to your AI.</li><li><strong>Test &amp; go live:</strong> Hear your AI work, then mark it live.</li></ol><p style="margin:18px 0 6px 0;font-size:14px;color:#374151;">Reply anytime — our team responds fast.</p><p style="margin:0;font-size:14px;color:#374151;">— AI Lead Intel</p></div></div></body></html>`,
    });
  } catch (e) { console.error("[onboarding] customer email:", e.message); }
}

async function runAllNotificationsSafely(data, finalSlug) {
  try { await Promise.allSettled([safeNtfy(data), safeOwnerEmail(data), safeCustomerEmail(data, finalSlug)]); }
  catch (e) { console.error("[onboarding] notif wrap:", e.message); }
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
  } catch (e) { console.error("[onboarding] rate-limit:", e.message); }

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
      console.error("[onboarding] FATAL clients save:", err.message);
      try { await runAllNotificationsSafely(data, finalSlug); } catch (_) {}
      return res.status(500).json({ success: false, error: "Could not save your submission." });
    }
    const clientRow = clientResult.row;

    try { await runAllNotificationsSafely(data, finalSlug); } catch (e) { console.error("[onboarding] notif:", e.message); }

    // Build PayPal redirect URL
    const r = buildPaypalRedirect({
  plan: clientRow.plan || data.plan,
  clientSlug: clientRow.client_slug,
});
console.log('[onboarding] paypal:', JSON.stringify(r.log));
if (!r.ok) {
  console.error('[onboarding] paypal misconfig:', r.error);
  return res.status(502).json({ error: 'PayPal checkout is not configured correctly: ' + r.error });
}
const paypalRedirect = r.redirect;

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
    console.log("[onboarding] FINAL RESPONSE — paypal_redirect:", paypalRedirect ? paypalRedirect : "(EMPTY)");
    return res.status(200).json(responseBody);
  } catch (error) {
    console.error("[onboarding] UNHANDLED:", error.message);
    return res.status(500).json({ success: false, error: "Unexpected server error." });
  }
}
