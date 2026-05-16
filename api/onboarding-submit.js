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
    plan: data.plan || "starter", // 'starter' or 'pro' - default to starter
    raw_data: data,
  };
}

/**
 * Generate a URL-friendly slug from a business name.
 * Adds a short random suffix to avoid collisions.
 * Example: "Prime Vault Self Storage" -> "prime-vault-self-storage-x7k2"
 */
function generateSlug(businessName) {
  const base = String(businessName || "client")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "") // strip punctuation
    .replace(/\s+/g, "-")          // spaces to dashes
    .replace(/-+/g, "-")           // collapse repeats
    .slice(0, 40);                 // cap length

  // 4-char random suffix for uniqueness
  const suffix = Math.random().toString(36).slice(2, 6);

  return `${base || "client"}-${suffix}`;
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
        <p><strong>Plan Requested:</strong> ${escapeHtml(data.plan)}</p>

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
        <p style="color:#aaa;font-size:12px;">View in admin: <a href="https://aileadintel.com/admin" style="color:#ff6a00;">aileadintel.com/admin</a></p>
      </div>
    `,
  });

  console.log("EMAIL SENT to", notifyEmail);
}

/**
 * Save the raw onboarding submission to the client_onboarding table.
 * Returns the created row's ID (so we can link it to the clients row).
 */
async function saveOnboardingToSupabase(data) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY;

  if (!supabaseUrl || !supabaseKey) {
    console.log("SUPABASE SKIPPED — missing keys");
    return null;
  }

  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/client_onboarding`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        Prefer: "return=representation", // changed from minimal so we can get the inserted ID
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
      console.log("SUPABASE onboarding INSERT failed:", res.status, text);
      return null;
    }

    const rows = await res.json().catch(() => []);
    return rows && rows[0] ? rows[0].id : null;
  } catch (error) {
    console.log("SUPABASE ONBOARDING ERROR:", error.message);
    return null;
  }
}

/**
 * Create a row in the `clients` table so the customer appears in /admin.
 * - status: 'trial' (they haven't paid yet)
 * - plan: from form (defaults to 'starter')
 * - active: true (they're a real prospect)
 * - onboarding_id: links back to client_onboarding row for full context
 */
async function createClientRow(data, onboardingId) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY;

  if (!supabaseUrl || !supabaseKey) {
    console.log("CLIENT ROW SKIPPED — missing Supabase keys");
    return null;
  }

  // Force plan to one of the allowed values (CHECK constraint = 'starter' | 'pro')
  const safePlan = data.plan === "pro" ? "pro" : "starter";

  // Build a notes string with onboarding details so the admin row is useful at a glance
  const adminNotes = [
    `Industry: ${data.industry || "—"}`,
    `Forward to: ${data.transfer_primary || "—"}`,
    data.transfer_backup ? `Backup: ${data.transfer_backup}` : null,
    `Hours: ${data.transfer_hours || "—"}`,
    `Personality: ${data.personality || "—"}`,
    `Pricing rule: ${data.pricing_rule || "—"}`,
    data.topics && data.topics.length ? `Topics: ${data.topics.join(", ")}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const payload = {
    business_name: data.business_name,
    client_slug: generateSlug(data.business_name),
    notify_email: data.notify_email,
    phone_number: data.business_phone || null,
    plan: safePlan,
    status: "trial",
    active: true,
    notes: adminNotes,
    onboarding_id: onboardingId || null,
    // status_changed_at + created_at + updated_at use the column defaults
    // owner_user_id stays null — you'll wire up an auth user manually for now
    // assistant_id, vapi_phone_number_id, twilio_number stay null until you build the AI
  };

  try {
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
      console.log("CLIENT ROW INSERT failed:", res.status, text);
      return null;
    }

    const rows = await res.json().catch(() => []);
    const newClient = rows && rows[0] ? rows[0] : null;
    if (newClient) {
      console.log("CLIENT ROW CREATED:", newClient.id, newClient.client_slug);
    }
    return newClient;
  } catch (error) {
    console.log("CLIENT ROW ERROR:", error.message);
    return null;
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
    if (!data.notify_email) {
      return res.status(400).json({ error: "Missing notification email" });
    }

    // Step 1 — Fire ntfy + owner email + onboarding insert in parallel.
    // We need the onboarding row's ID to link to the clients row, so we await it.
    const [, , onboardingId] = await Promise.all([
      sendNtfyNotification(data),
      notifyOwnerEmail(data),
      saveOnboardingToSupabase(data),
    ]);

    // Step 2 — Create the clients row so they appear in /admin immediately.
    // Runs after onboarding insert so we can link via onboarding_id.
    await createClientRow(data, onboardingId);

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("ONBOARDING ERROR:", error);
    return res.status(500).json({ error: "Failed to submit onboarding" });
  }
}
