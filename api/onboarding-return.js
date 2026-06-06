// api/onboarding-return.js
// PayPal sends customers here after successful subscription.
// Looks up client, marks paid, sends the setup email (Pro), then redirects:
//   - Pro     → /create-password
//   - Starter → /confirmation  (no password, no dashboard, no setup email)
//
// STARTER AUTO-PROVISION: Starter never visits /setup, so this handler also
// provisions the Starter client (number + AI assistant) on a confident paid
// match, then emails them their new number with forwarding instructions.
// A one-time lock column (provision_requested_at) + provision's own
// idempotency guarantee a client is only ever provisioned once, even though
// paypal-webhook.js carries the same hook as a backup.
export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  console.log("[paypal-return] hit:", { query: req.query });
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY;
  const baseUrl = "https://aileadintel.com";
  const subscriptionId = (req.query.subscription_id || req.query.ba_token || "").toString();
  // We control the return_url when creating the subscription via the API, so we
  // embed ?slug=<client_slug>. Also accept ?custom_id= for backward-compat.
  const customIdFromQuery = (req.query.slug || req.query.custom_id || "").toString();
  let client = null;
  let matchedBy = null;   // 'custom_id' | 'subscription_id' | 'fallback'
  if (supabaseUrl && supabaseKey) {
    const headers = { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` };
    // 1. Try custom_id (slug) — set by PayPal redirect URL in onboarding-submit.js
    if (customIdFromQuery) {
      try {
        const r = await fetch(
          `${supabaseUrl}/rest/v1/clients?client_slug=eq.${encodeURIComponent(customIdFromQuery)}&select=*&limit=1`,
          { headers }
        );
        if (r.ok) {
          const rows = await r.json().catch(() => []);
          if (rows[0]) { client = rows[0]; matchedBy = "custom_id"; }
        }
      } catch (e) {
        console.warn("[paypal-return] custom_id lookup:", e.message);
      }
    }
    // 2. Try subscription_id
    if (!client && subscriptionId) {
      try {
        const r = await fetch(
          `${supabaseUrl}/rest/v1/clients?payment_external_id=eq.${encodeURIComponent(subscriptionId)}&select=*&limit=1`,
          { headers }
        );
        if (r.ok) {
          const rows = await r.json().catch(() => []);
          if (rows[0]) { client = rows[0]; matchedBy = "subscription_id"; }
        }
      } catch (e) {
        console.warn("[paypal-return] sub_id lookup:", e.message);
      }
    }
    // 3. Fallback — most recent unpaid (a GUESS — we won't email on this match)
    if (!client) {
      try {
        const r = await fetch(
          `${supabaseUrl}/rest/v1/clients?payment_status=eq.unpaid&select=*&order=created_at.desc&limit=1`,
          { headers }
        );
        if (r.ok) {
          const rows = await r.json().catch(() => []);
          if (rows[0]) { client = rows[0]; matchedBy = "fallback"; }
        }
      } catch (e) {
        console.warn("[paypal-return] fallback lookup:", e.message);
      }
    }
    console.log("[paypal-return] client match:", { matchedBy, slug: client?.client_slug, plan: client?.plan });

    // A confident match = we identified the client by the slug we embedded in
    // the PayPal link (custom_id) or by the subscription id. NOT the "most
    // recent unpaid" fallback guess.
    const confidentMatch = matchedBy === "custom_id" || matchedBy === "subscription_id";
    const planLower = (client?.plan || "").toLowerCase();

    // Mark client paid + active on a confident match — do NOT require
    // subscription_id (PayPal hosted subscribe links often omit it on return).
    if (client && confidentMatch) {
      try {
        const patchBody = {
          payment_pending: false,
          payment_status: "paid",
          paid_at: new Date().toISOString(),
          status: "active",
        };
        if (subscriptionId) patchBody.payment_external_id = subscriptionId;  // record it when present
        await fetch(`${supabaseUrl}/rest/v1/clients?id=eq.${client.id}`, {
          method: "PATCH",
          headers: { ...headers, "Content-Type": "application/json", Prefer: "return=minimal" },
          body: JSON.stringify(patchBody),
        });
        console.log("[paypal-return] ✅ marked client paid:", client.client_slug, "(sub_id:", subscriptionId || "none", ")");
      } catch (e) {
        console.error("[paypal-return] update failed:", e.message);
      }
    } else {
      console.log("[paypal-return] NOT marking paid:", { confidentMatch, matchedBy });
    }

    // ── SETUP EMAIL (Pro only) ──
    // Same confident-match rule. send-setup-email dedups on double-return.
    if (client && client.client_slug && confidentMatch && planLower === "pro") {
      console.log("[paypal-return] → triggering setup email for", client.client_slug);
      try {
        const er = await fetch(`${baseUrl}/api/send-setup-email`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-internal-secret": process.env.SUPABASE_WEBHOOK_SECRET || "",
          },
          body: JSON.stringify({ client_slug: client.client_slug }),
        });
        const t = await er.text().catch(() => "");
        if (er.ok) {
          console.log("[paypal-return] ✅ setup email triggered:", t.slice(0, 200));
        } else {
          console.error("[paypal-return] ⚠️ setup email failed:", er.status, t.slice(0, 300));
        }
      } catch (e) {
        console.error("[paypal-return] ⚠️ setup email trigger error:", e.message);
      }
    } else {
      console.log("[paypal-return] setup email NOT triggered:", { confidentMatch, plan: planLower, hasSlug: !!client?.client_slug });
    }

    // ── STARTER AUTO-PROVISION ──
    // Starter never visits /setup, so provision the number + AI right here on
    // a confident paid match, then email the customer their number.
    if (client && client.client_slug && confidentMatch && planLower === "starter") {
      try {
        await autoProvisionStarter(client, supabaseUrl, headers, baseUrl);
      } catch (e) {
        console.error("[paypal-return] auto-provision error:", e.message);
      }
    }
  }
  // Build redirect params (kept for both flows)
  const params = new URLSearchParams();
  const plan = (client?.plan || "starter").toLowerCase();
  params.set("plan", plan);
  params.set("slug", client?.client_slug || "");
  params.set("business", client?.business_name || "");
  if (client?.notify_email) params.set("email", client.notify_email);
  if (client?.report_frequency) params.set("freq", client.report_frequency);
  if (client?.report_email) params.set("report_email", client.report_email);
  if (subscriptionId) params.set("paypal_sub", subscriptionId);
  params.set("paid", subscriptionId ? "1" : "0");
  // PLAN-BASED ROUTING — both plans now create a login (so /account and the
  // self-service cancel button work for everyone). create-password reads the
  // ?plan param and routes Starter on to /confirmation, Pro to /setup.
  const redirectPath = "/create-password";
  const redirectUrl = `${baseUrl}${redirectPath}?${params.toString()}`;
  console.log("[paypal-return] plan:", plan, "→ 302:", redirectUrl);
  res.writeHead(302, { Location: redirectUrl });
  res.end();
}

// ── Starter auto-provision ──
// 1) Take a one-time lock (provision_requested_at) so only ONE of
//    onboarding-return / paypal-webhook ever provisions this client.
// 2) Call /api/provision server-to-server with x-internal-secret.
// 3) On success: email the customer their AI's number + forwarding steps.
//    On failure: urgently alert the owner so they can fix it by hand.
async function autoProvisionStarter(client, supabaseUrl, sbAuthHeaders, baseUrl) {
  const secret = process.env.SUPABASE_WEBHOOK_SECRET || "";
  if (!secret) {
    console.error("[paypal-return] SUPABASE_WEBHOOK_SECRET missing — cannot auto-provision");
    await alertOwnerStarterProblem(
      `URGENT: Starter client ${client.business_name || client.client_slug} PAID but auto-provision could not run — the SUPABASE_WEBHOOK_SECRET environment variable is missing in Vercel. Add it, then set this client up manually.`
    );
    return;
  }
  if (client.twilio_number && client.vapi_phone_number_id) {
    console.log("[paypal-return] already provisioned:", client.client_slug);
    return;
  }

  // One-time lock: this PATCH only matches while provision_requested_at IS NULL,
  // so exactly one caller can win it.
  try {
    const r = await fetch(
      `${supabaseUrl}/rest/v1/clients?id=eq.${client.id}&provision_requested_at=is.null`,
      {
        method: "PATCH",
        headers: { ...sbAuthHeaders, "Content-Type": "application/json", Prefer: "return=representation" },
        body: JSON.stringify({ provision_requested_at: new Date().toISOString() }),
      }
    );
    const rows = await r.json().catch(() => []);
    if (!r.ok) {
      const detail = JSON.stringify(rows).slice(0, 250);
      console.error("[paypal-return] provision lock PATCH failed:", r.status, detail);
      await alertOwnerStarterProblem(
        `URGENT: Starter client ${client.business_name || client.client_slug} PAID but the provision lock failed (${r.status}: ${detail}). ` +
        `If this mentions provision_requested_at, run this in Supabase: alter table clients add column if not exists provision_requested_at timestamptz; ` +
        `Then set this client up manually.`
      );
      return;
    }
    if (!Array.isArray(rows) || rows.length === 0) {
      console.log("[paypal-return] provision lock not acquired (already started elsewhere) —", client.client_slug);
      return;
    }
  } catch (e) {
    console.error("[paypal-return] provision lock error:", e.message);
    await alertOwnerStarterProblem(
      `URGENT: Starter client ${client.business_name || client.client_slug} PAID but the provision lock threw an error (${e.message}). Set them up manually.`
    );
    return;
  }

  let result = null;
  try {
    const pr = await fetch(`${baseUrl}/api/provision`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-secret": secret },
      body: JSON.stringify({ client_slug: client.client_slug }),
    });
    result = await pr.json().catch(() => ({}));
    if (!pr.ok) console.error("[paypal-return] provision failed:", pr.status, JSON.stringify(result).slice(0, 300));
  } catch (e) {
    console.error("[paypal-return] provision call threw:", e.message);
  }

  const number = result && result.number;
  if (number) {
    console.log("[paypal-return] ✅ starter provisioned:", client.client_slug, number);
    await sendStarterLiveEmail(client, number);
  } else {
    await alertOwnerStarterProblem(
      `URGENT: Starter client ${client.business_name || client.client_slug} PAID but auto-provisioning FAILED` +
      ` (${(result && result.error) || "unknown error"}). Set them up manually ASAP.`
    );
  }
}

// Email the Starter customer their live AI number + how to forward to it.
async function sendStarterLiveEmail(client, number) {
  const key = process.env.RESEND_API_KEY;
  const to = client.notify_email;
  if (!key || !to) {
    console.warn("[paypal-return] starter live email skipped (missing RESEND_API_KEY or notify_email)");
    return;
  }
  const pretty = String(number).replace(/^\+1(\d{3})(\d{3})(\d{4})$/, "($1) $2-$3");
  const digits = String(number).replace(/[^\d]/g, "").replace(/^1/, "");
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "AI Lead Intel <hello@aileadintel.com>",
        to: [to],
        subject: `Your AI receptionist is live — your number is ${pretty}`,
        text: [
          `Great news — your AI receptionist for ${client.business_name || "your business"} is set up and answering calls right now.`,
          ``,
          `Your AI's phone number: ${pretty}`,
          ``,
          `Try it: call the number above and talk to your AI. You'll get a summary email at this address the moment the call ends.`,
          ``,
          `To connect your existing business number, forward it to your AI. Dial the code for your carrier from your business phone, then press call:`,
          `- Verizon, US Cellular & most landlines: dial *72${digits}   (to turn off later: *73)`,
          `- AT&T: dial *21*${digits}#   (to turn off later: #21#)`,
          `- T-Mobile, Metro, Mint: dial **21*${digits}#   (to turn off later: ##21#)`,
          `- Internet/VoIP phone systems (Spectrum, Xfinity, RingCentral, etc.): turn on call forwarding in your provider's app or settings instead.`,
          `After dialing, call your business number from another phone — your AI should pick up.`,
          ``,
          `Or skip forwarding entirely and use ${pretty} as your business line on Google, your website, and your cards.`,
          ``,
          `Manage or cancel your subscription anytime at: https://aileadintel.com/account`,
          `(First time? Create your login here: https://aileadintel.com/create-password?plan=starter&slug=${client.client_slug || ""}&email=${encodeURIComponent(to)})`,
          ``,
          `Questions or want a hand? Just reply to this email.`,
          ``,
          `— AI Lead Intel`,
        ].join("\n"),
      }),
    });
    console.log("[paypal-return] ✅ starter live email sent to", to);
  } catch (e) {
    console.error("[paypal-return] starter live email failed:", e.message);
  }
}

// Urgent owner alert (push + email) when a paid Starter could not be provisioned.
async function alertOwnerStarterProblem(message) {
  const topic = process.env.NTFY_TOPIC;
  if (topic) {
    try {
      await fetch(`https://ntfy.sh/${topic}`, {
        method: "POST",
        headers: { Title: "Starter provisioning problem", Priority: "urgent", Tags: "rotating_light" },
        body: message,
      });
    } catch (e) { console.error("[paypal-return] ntfy alert failed:", e.message); }
  }
  const key = process.env.RESEND_API_KEY;
  const to = process.env.NOTIFY_EMAIL;
  if (key && to) {
    try {
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "AI Lead Intel <hello@aileadintel.com>",
          to: [to],
          subject: "URGENT: Starter provisioning failed",
          text: message,
        }),
      });
    } catch (e) { console.error("[paypal-return] alert email failed:", e.message); }
  }
}
