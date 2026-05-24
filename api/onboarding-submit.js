// api/onboarding-submit.js
// Production onboarding handler for AI Lead Intel.
// - Status uses "pending" / "active" / "paused" (no more "trial")
// - Customer email rewritten to use "our team" / "AI Lead Intel" — no Andrew, no payment block
// - All notifications isolated with try/catch — they NEVER fail the onboarding
// - generateAiConfig() builds Vapi-ready prompt + summary fields synchronously
// - Resilient against email/ntfy failures
// - Clean logging

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

// Valid status values allowed by Supabase constraint
const VALID_STATUSES = new Set(["pending", "active", "paused"]);

// ============================================================
// HELPERS
// ============================================================

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
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
  return String(businessName || "client")
    .toLowerCase().trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-").replace(/-+/g, "-").slice(0, 50) || "client";
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
  } catch (_) { return false; }
}

async function resolveSlug(data, supabaseUrl, supabaseKey) {
  let base = (data.client_slug_from_form || "").trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
  if (!base) base = slugifyBase(data.business_name);
  console.log("[onboarding] slug base:", base);
  const taken = await isSlugTaken(base, supabaseUrl, supabaseKey);
  if (!taken) {
    console.log("[onboarding] slug available:", base);
    return base;
  }
  const suffix = Math.random().toString(36).slice(2, 6);
  const final = `${base}-${suffix}`;
  console.log("[onboarding] slug collision → using:", final);
  return final;
}

function parseUrgentTransfer(value) {
  if (value === "yes") return true;
  if (value === "no") return false;
  return null;
}

function safeStatus(value) {
  // Map any incoming value to a valid status; default to "pending"
  if (typeof value === "string" && VALID_STATUSES.has(value.toLowerCase())) {
    return value.toLowerCase();
  }
  return "pending";
}

// ============================================================
// AI CONFIG GENERATOR — synchronous, builds Vapi-ready prompt
// ============================================================

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

  // GREETING
  let ai_greeting;
  if (data.personality === "professional") {
    ai_greeting = `Good day, thank you for calling ${businessName}. How may I assist you?`;
  } else if (data.personality === "direct") {
    ai_greeting = `Thanks for calling ${businessName}. How can I help?`;
  } else {
    ai_greeting = `Hey, thanks for calling ${businessName}! What can I do for you today?`;
  }

  // PERSONALITY
  const ai_personality = personalityLabel;

  // TRANSFER BEHAVIOR
  const transferLines = [];
  transferLines.push(`Business hours: ${hours}.`);
  if (transferPrimary) transferLines.push(`Primary transfer number: ${transferPrimary}.`);
  if (transferBackup) transferLines.push(`Backup transfer number: ${transferBackup}.`);
  transferLines.push(`Only transfer when a caller explicitly asks to speak to a human, OR for confirmed emergencies (see below).`);
  if (offerUrgent) {
    transferLines.push(
      `Urgent call handling: If a caller mentions an emergency, lockout, flooding, urgent access issue, outage, or similar urgent situation, do the following — 1) acknowledge the urgency calmly, 2) ask if they would like to be connected with someone immediately, 3) only transfer if the caller confirms yes. Never transfer automatically without asking.`
    );
  } else {
    transferLines.push(
      `Urgent calls: Capture the lead in detail (name, callback number, nature of urgency), assure the caller someone will be in touch quickly, and notify the owner via the lead summary. Do NOT transfer.`
    );
  }
  const transfer_behavior = transferLines.join(" ");

  // SERVICES SUMMARY
  const servicesParts = [];
  servicesParts.push(`${businessName} is a ${industryLabel.toLowerCase()} business.`);
  if (services) servicesParts.push(`Services offered: ${services}.`);
  if (serviceArea) servicesParts.push(`Service area: ${serviceArea}.`);
  const services_summary = servicesParts.join(" ");

  // FAQ SUMMARY
  const faqParts = [];
  faqParts.push(`Pricing rule: ${pricingRuleLabel}.`);
  if (pricingExamples) faqParts.push(`Common prices the AI should know:\n${pricingExamples}`);
  if (topicsList.length) faqParts.push(`Most common reasons people call: ${topicsList.join(", ")}.`);
  if (notes) faqParts.push(`Additional notes from the owner: ${notes}`);
  const faq_summary = faqParts.join("\n\n");

  // FULL VAPI SYSTEM PROMPT
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
  promptLines.push(`- What they need (be specific — the service, the issue, or the question)`);
  promptLines.push(`- Urgency (today, this week, flexible)`);
  promptLines.push(`- Any address or location info if relevant to the service`);
  promptLines.push("");
  promptLines.push(`# PRICING POLICY`);
  promptLines.push(pricingRuleLabel);
  if (pricingExamples) {
    promptLines.push("");
    promptLines.push(`Known prices you may quote when appropriate:`);
    promptLines.push(pricingExamples);
  }
  promptLines.push("");
  promptLines.push(`# CALL TRANSFER RULES`);
  promptLines.push(transfer_behavior);
  promptLines.push("");
  if (topicsList.length) {
    promptLines.push(`# COMMON CALL REASONS`);
    promptLines.push(`Be ready for callers asking about: ${topicsList.join(", ")}`);
    promptLines.push("");
  }
  if (notes) {
    promptLines.push(`# IMPORTANT NOTES FROM THE OWNER`);
    promptLines.push(notes);
    promptLines.push("");
  }
  promptLines.push(`# HARD RULES`);
  promptLines.push(`- Never make up prices, services, or hours.`);
  promptLines.push(`- Never promise something the business hasn't said it can do.`);
  promptLines.push(`- If you don't know an answer, say "Great question — let me have someone follow up with that," capture the info, and move on.`);
  promptLines.push(`- Stay in character as ${businessName}'s receptionist at all times.`);
  promptLines.push(`- Keep responses short and conversational. Don't lecture or over-explain.`);
  promptLines.push(`- Confirm the caller's contact info before ending the call.`);

  const ai_prompt = promptLines.join("\n");

  return {
    ai_prompt,
    ai_greeting,
    ai_personality,
    transfer_behavior,
    services_summary,
    faq_summary,
  };
}

// ============================================================
// SUPABASE — client_onboarding (non-critical, never crashes flow)
// ============================================================

async function saveOnboardingToSupabase(data, supabaseUrl, supabaseKey) {
  console.log("[onboarding] saving client_onboarding row...");
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
        services_offered: data.services_offered,
        service_area: data.service_area,
        offer_urgent_transfer: parseUrgentTransfer(data.offer_urgent_transfer),
        status: "new",
        raw_data: data.raw_data,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error("[onboarding] client_onboarding INSERT failed:", res.status, text);
      return null;
    }
    const rows = await res.json().catch(() => []);
    const id = rows && rows[0] ? rows[0].id : null;
    console.log("[onboarding] client_onboarding row created:", id);
    return id;
  } catch (error) {
    console.error("[onboarding] client_onboarding EXCEPTION:", error.message);
    return null;
  }
}

// ============================================================
// SUPABASE — clients (CRITICAL: lookup-then-PATCH-or-POST)
// ============================================================

async function createClientRow(data, onboardingId, finalSlug, supabaseUrl, supabaseKey) {
  const phoneNumber = data.business_phone || null;
  const pricing = PLAN_PRICING[data.plan] || PLAN_PRICING.starter;
  const urgentBool = parseUrgentTransfer(data.offer_urgent_transfer);

  // Generate AI config synchronously
  const aiConfig = generateAiConfig(data);
  console.log("[onboarding] AI config generated — prompt length:", aiConfig.ai_prompt.length, "chars");

  const adminNotes = [
    `Industry: ${data.industry || "—"}`,
    `Forward to: ${data.transfer_primary || "—"}`,
    data.transfer_backup ? `Backup: ${data.transfer_backup}` : null,
    `Hours: ${data.transfer_hours || "—"}`,
    `Personality: ${data.personality || "—"}`,
    `Pricing rule: ${data.pricing_rule || "—"}`,
    data.services_offered ? `Services: ${data.services_offered}` : null,
    data.service_area ? `Service area: ${data.service_area}` : null,
    urgentBool !== null ? `Urgent transfer: ${urgentBool ? "Yes" : "No"}` : null,
    data.topics && data.topics.length ? `Topics: ${data.topics.join(", ")}` : null,
  ].filter(Boolean).join("\n");

  const writeHeaders = {
    "Content-Type": "application/json",
    apikey: supabaseKey,
    Authorization: `Bearer ${supabaseKey}`,
    Prefer: "return=representation",
  };
  const readHeaders = { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` };

  let existingId = null;
  if (phoneNumber) {
    console.log("[onboarding] looking up client by phone:", phoneNumber);
    try {
      const lookupUrl = `${supabaseUrl}/rest/v1/clients?phone_number=eq.${encodeURIComponent(phoneNumber)}&select=id&limit=1`;
      const lookupRes = await fetch(lookupUrl, { headers: readHeaders });
      if (lookupRes.ok) {
        const rows = await lookupRes.json().catch(() => []);
        if (Array.isArray(rows) && rows.length > 0 && rows[0].id) {
          existingId = rows[0].id;
          console.log("[onboarding] existing client found — id:", existingId);
        } else {
          console.log("[onboarding] no existing client with this phone");
        }
      }
    } catch (err) {
      console.warn("[onboarding] phone lookup exception:", err.message);
    }
  }

  // Note: status uses safeStatus() to guarantee a valid value (pending/active/paused)
  if (existingId) {
    console.log("[onboarding] UPDATING existing client — id:", existingId);
    const updatePayload = {
      business_name: data.business_name,
      client_slug: finalSlug,
      notify_email: data.notify_email,
      plan: data.plan,
      status: safeStatus("pending"),
      notes: adminNotes,
      onboarding_id: onboardingId || null,
      report_frequency: data.plan === "starter" ? (data.report_frequency || "monthly") : null,
      report_email: data.plan === "starter" ? (data.report_email || data.notify_email) : null,
      services_offered: data.services_offered,
      service_area: data.service_area,
      offer_urgent_transfer: urgentBool,
      payment_amount: pricing.amount,
      payment_provider: "paypal",
      ai_prompt: aiConfig.ai_prompt,
      ai_greeting: aiConfig.ai_greeting,
      ai_personality: aiConfig.ai_personality,
      transfer_behavior: aiConfig.transfer_behavior,
      services_summary: aiConfig.services_summary,
      faq_summary: aiConfig.faq_summary,
    };
    const patchRes = await fetch(`${supabaseUrl}/rest/v1/clients?id=eq.${existingId}`, {
      method: "PATCH", headers: writeHeaders, body: JSON.stringify(updatePayload),
    });
    if (!patchRes.ok) {
      const text = await patchRes.text().catch(() => "");
      throw new Error(`Could not update client (HTTP ${patchRes.status}): ${text.slice(0, 300)}`);
    }
    const rows = await patchRes.json().catch(() => []);
    const row = rows && rows[0] ? rows[0] : null;
    if (!row) throw new Error("Client update returned no row");
    console.log("[onboarding] UPDATE success — id:", row.id);
    return { row, existing: true };
  }

  console.log("[onboarding] CREATING new client — slug:", finalSlug, "plan:", data.plan);
  const insertPayload = {
    business_name: data.business_name,
    client_slug: finalSlug,
    notify_email: data.notify_email,
    phone_number: phoneNumber,
    plan: data.plan,
    status: safeStatus("pending"),
    active: true,
    notes: adminNotes,
    onboarding_id: onboardingId || null,
    report_frequency: data.plan === "starter" ? (data.report_frequency || "monthly") : null,
    report_email: data.plan === "starter" ? (data.report_email || data.notify_email) : null,
    services_offered: data.services_offered,
    service_area: data.service_area,
    offer_urgent_transfer: urgentBool,
    payment_required: true,
    payment_pending: true,
    payment_status: "pending",
    payment_provider: "paypal",
    payment_amount: pricing.amount,
    ai_prompt: aiConfig.ai_prompt,
    ai_greeting: aiConfig.ai_greeting,
    ai_personality: aiConfig.ai_personality,
    transfer_behavior: aiConfig.transfer_behavior,
    services_summary: aiConfig.services_summary,
    faq_summary: aiConfig.faq_summary,
  };
  const insertRes = await fetch(`${supabaseUrl}/rest/v1/clients`, {
    method: "POST", headers: writeHeaders, body: JSON.stringify(insertPayload),
  });
  if (!insertRes.ok) {
    const text = await insertRes.text().catch(() => "");
    throw new Error(`Could not save client (HTTP ${insertRes.status}): ${text.slice(0, 300)}`);
  }
  const rows = await insertRes.json().catch(() => []);
  const row = rows && rows[0] ? rows[0] : null;
  if (!row) throw new Error("Client insert returned no row");
  console.log("[onboarding] INSERT success — id:", row.id);
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
Services: ${data.services_offered || "—"}
Service area: ${data.service_area || "—"}
Transfer: ${data.transfer_primary || "—"}
Email: ${data.notify_email || "—"}
Plan: ${data.plan}
Submitted: ${new Date().toLocaleString("en-US", { timeZone: "America/Denver" })}`;
    const r = await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
      method: "POST",
      headers: {
        Title: `New Onboarding (${data.plan}): ${data.business_name || "AI Lead Intel"}`,
        Priority: "high", Tags: "rocket",
      },
      body,
    });
    if (!r.ok) console.warn("[onboarding] ntfy non-OK:", r.status);
    else console.log("[onboarding] ntfy sent");
  } catch (err) {
    console.error("[onboarding] ntfy error (non-fatal):", err.message);
  }
}

async function safeOwnerEmail(data) {
  try {
    const resendKey = process.env.RESEND_API_KEY;
    const notifyEmail = process.env.NOTIFY_EMAIL;
    if (!resendKey || !notifyEmail) { console.warn("[onboarding] owner email skipped — env missing"); return; }
    const resend = new Resend(resendKey);
    const urgentDisplay = data.offer_urgent_transfer === "yes" ? "Yes — offer transfer" :
                          data.offer_urgent_transfer === "no" ? "No — capture & notify" : "—";
    const result = await resend.emails.send({
      from: "AI Lead Intel <hello@aileadintel.com>",
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
          <p><strong>Services offered:</strong> ${escapeHtml(data.services_offered || "—")}</p>
          <p><strong>Service area:</strong> ${escapeHtml(data.service_area || "—")}</p>
          <h3>Call Handling</h3>
          <p><strong>Primary Transfer:</strong> ${escapeHtml(data.transfer_primary)}</p>
          <p><strong>Backup Transfer:</strong> ${escapeHtml(data.transfer_backup || "—")}</p>
          <p><strong>Notification Email:</strong> ${escapeHtml(data.notify_email)}</p>
          <p><strong>Transfer Hours:</strong> ${escapeHtml(data.transfer_hours)}</p>
          <p><strong>Urgent transfer:</strong> ${escapeHtml(urgentDisplay)}</p>
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
    if (result && result.error) console.error("[onboarding] owner email error (non-fatal):", result.error);
    else console.log("[onboarding] owner email sent");
  } catch (err) {
    console.error("[onboarding] owner email EXCEPTION (non-fatal):", err.message);
  }
}

async function safeCustomerEmail(data, finalSlug) {
  console.log("[onboarding] safeCustomerEmail entered", {
    has_notify_email: !!data?.notify_email,
    plan: data?.plan,
    finalSlug,
  });

  try {
    const resendKey = process.env.RESEND_API_KEY;
    if (!resendKey) {
      console.warn("[onboarding] customer email skipped — RESEND_API_KEY missing");
      return;
    }
    if (!data || !data.notify_email) {
      console.warn("[onboarding] customer email skipped — notify_email empty");
      return;
    }

    const resend = new Resend(resendKey);
    const businessName = data.business_name || "your business";
    const isPro = data.plan === "pro";
    const reportFreq = (data.report_frequency || "monthly").toLowerCase();
    const reportEmail = data.report_email || data.notify_email;
    const reportFreqLabel = reportFreq === "weekly" ? "every Monday morning" : "on the 1st of each month";
    const reportFreqShort = reportFreq === "weekly" ? "weekly" : "monthly";

    const dashboardBlock = isPro
      ? `<div style="background:linear-gradient(135deg,rgba(255,106,0,0.06),transparent);border:1px solid rgba(255,106,0,0.22);border-radius:12px;padding:18px 20px;margin:0 0 20px 0;"><div style="font-family:'SF Mono',Menlo,monospace;font-size:10px;color:#ff6a00;letter-spacing:0.14em;text-transform:uppercase;font-weight:700;margin-bottom:8px;">★ Your Pro Dashboard</div><p style="margin:0 0 10px 0;font-size:14px;color:#374151;line-height:1.55;">Bookmark this — your private dashboard URL:</p><a href="https://aileadintel.com/dashboard/${finalSlug}" style="display:inline-block;font-family:'SF Mono',Menlo,monospace;font-size:13px;color:#ff6a00;background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:8px 12px;text-decoration:none;">aileadintel.com/dashboard/${finalSlug}</a></div>`
      : "";

    const reportsBlock = !isPro
      ? `<div style="background:linear-gradient(135deg,rgba(255,106,0,0.06),transparent);border:1px solid rgba(255,106,0,0.22);border-radius:12px;padding:18px 20px;margin:0 0 20px 0;"><div style="font-family:'SF Mono',Menlo,monospace;font-size:10px;color:#ff6a00;letter-spacing:0.14em;text-transform:uppercase;font-weight:700;margin-bottom:8px;">★ Your ${escapeHtml(reportFreqShort)} lead reports</div><p style="margin:0 0 6px 0;font-size:14px;color:#111827;line-height:1.55;font-weight:600;">We'll email you ${escapeHtml(reportFreqLabel)}.</p><p style="margin:0;font-size:13px;color:#6b7280;line-height:1.55;">Each report includes every lead captured, missed call, callback request, and booking — sent to <strong style="color:#374151;">${escapeHtml(reportEmail)}</strong>.</p></div>`
      : "";

    console.log("[onboarding] sending customer email now →", data.notify_email);

    const result = await resend.emails.send({
      from: "AI Lead Intel <hello@aileadintel.com>",
      to: [data.notify_email],
      replyTo: "hello@aileadintel.com",
      subject: `We got your onboarding — ${businessName}`,
      html: `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#f9fafb;"><div style="max-width:560px;margin:0 auto;padding:32px 20px;"><div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:14px;padding:36px 32px;"><div style="display:flex;align-items:center;gap:10px;margin-bottom:24px;"><div style="width:30px;height:30px;border-radius:8px;background:linear-gradient(135deg,#ff6a00,#ff9a00);"></div><strong style="font-size:14px;color:#111827;">AI Lead Intel</strong></div><h1 style="font-size:22px;font-weight:600;color:#111827;margin:0 0 14px 0;line-height:1.25;letter-spacing:-0.02em;">We got your onboarding ✅</h1><p style="margin:0 0 16px 0;font-size:15px;color:#374151;line-height:1.55;">Hey ${escapeHtml(businessName)},</p><p style="margin:0 0 20px 0;font-size:15px;color:#374151;line-height:1.55;">Thanks for signing up for the <strong>${isPro ? "AI Front Desk Pro" : "Starter"}</strong> plan. We've got everything we need to start building your AI receptionist.</p>${dashboardBlock}${reportsBlock}<h2 style="font-size:16px;font-weight:600;color:#111827;margin:24px 0 12px 0;letter-spacing:-0.01em;">What happens next</h2><ol style="margin:0 0 20px 0;padding-left:20px;font-size:14px;color:#374151;line-height:1.7;"><li><strong>Within 24 hours:</strong> Our team builds your AI's voice, tone, services, and transfer rules.</li><li><strong>Setup email:</strong> You'll get a one-click guide to forward your business calls to your AI (~2 minutes).</li><li><strong>Test &amp; go live:</strong> Hear your AI work, then mark it live.</li></ol><p style="margin:18px 0 6px 0;font-size:14px;color:#374151;">Reply to this email anytime if you have questions — our team responds fast.</p><p style="margin:0;font-size:14px;color:#374151;">— AI Lead Intel</p></div><p style="text-align:center;margin:18px 0 0 0;font-size:11px;color:#9ca3af;">AI Lead Intel · Apex Growth Investments LLC</p></div></body></html>`,
    });

    if (result && result.error) {
      console.error("[onboarding] customer email FAILED (non-fatal):", JSON.stringify(result.error));
    } else if (result && result.data && result.data.id) {
      console.log("[onboarding] customer email SENT — Resend id:", result.data.id);
    } else {
      console.log("[onboarding] customer email returned without error");
    }
  } catch (err) {
    console.error("[onboarding] customer email EXCEPTION (non-fatal):", err.message);
  }
}

async function runAllNotificationsSafely(data, finalSlug) {
  try {
    console.log("[onboarding] starting notifications...");
    await Promise.allSettled([
      safeNtfy(data),
      safeOwnerEmail(data),
      safeCustomerEmail(data, finalSlug),
    ]);
    console.log("[onboarding] notifications complete");
  } catch (err) {
    console.error("[onboarding] notifications wrapper exception (non-fatal):", err.message);
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
      console.warn(`[onboarding] rate limited ip=${ip}`);
      return res.status(429).json({ success: false, error: "Too many submissions. Try again later." });
    }
  } catch (err) {
    console.error("[onboarding] rate-limit subsystem error:", err.message);
  }

  let body = req.body || {};
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (_) { body = {}; }
  }

  if (body.website_url || body.company_size_other || body._gotcha) {
    console.warn(`[onboarding] honeypot triggered ip=${ip}`);
    return res.status(200).json({ success: true });
  }

  try {
    const data = normalizeData(body);

    console.log("[onboarding] received payload:", {
      ip, business: data.business_name, plan: data.plan,
      email: data.notify_email, phone: data.business_phone,
      services_offered: data.services_offered, service_area: data.service_area,
      offer_urgent_transfer: data.offer_urgent_transfer,
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
      console.error("[onboarding] Supabase env vars missing");
      return res.status(500).json({ success: false, error: "Server misconfigured" });
    }

    const finalSlug = await resolveSlug(data, supabaseUrl, supabaseKey);
    console.log("[onboarding] FINAL SLUG:", finalSlug);

    const onboardingId = await saveOnboardingToSupabase(data, supabaseUrl, supabaseKey);

    let clientResult;
    try {
      clientResult = await createClientRow(data, onboardingId, finalSlug, supabaseUrl, supabaseKey);
    } catch (err) {
      console.error("[onboarding] FATAL: clients save failed:", err.message);
      // Still try notifications so owner gets alerted
      await runAllNotificationsSafely(data, finalSlug);
      return res.status(500).json({
        success: false,
        error: "Could not save your submission. Please email hello@aileadintel.com.",
      });
    }
    const clientRow = clientResult.row;

    // AWAITED — guarantees Vercel doesn't terminate before Resend completes
    // Wrapped to GUARANTEE no email failure can ever bubble up and break onboarding
    try {
      await runAllNotificationsSafely(data, finalSlug);
    } catch (notifyErr) {
      console.error("[onboarding] notifications top-level exception (swallowed):", notifyErr.message);
    }

    // Pick PayPal hosted subscription URL based on plan
const paypalStarterUrl = process.env.PAYPAL_STARTER_URL || "";
const paypalProUrl = process.env.PAYPAL_PRO_URL || "";

const paypalUrl =
  (clientRow.plan || data.plan) === "pro"
    ? paypalProUrl
    : paypalStarterUrl;

// Build PayPal redirect URL
let paypalRedirect = paypalUrl;

if (paypalRedirect) {
  const sep = paypalRedirect.includes("?") ? "&" : "?";

  paypalRedirect =
    `${paypalRedirect}${sep}custom_id=` +
    encodeURIComponent(clientRow.client_slug);
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

console.log(
  "[onboarding] ✅ FINAL RESPONSE:",
  {
    ...responseBody,
    paypal_redirect: paypalRedirect ? "(set)" : "(empty)"
  }
);

return res.status(200).json(responseBody);
  } catch (error) {
    console.error("[onboarding] UNHANDLED EXCEPTION:", error.message, error.stack);
    return res.status(500).json({
      success: false,
      error: "Unexpected server error. Please email hello@aileadintel.com.",
    });
  }
}
