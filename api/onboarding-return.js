// api/onboarding-return.js
// PayPal sends customers here after successful subscription.
// Looks up client, marks paid, sends the setup email (Pro), then redirects:
//   - Pro     → /create-password
//   - Starter → /confirmation  (no password, no dashboard, no setup email)
export default async function handler(req, res) {
  console.log("[paypal-return] hit:", { query: req.query });
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY;
  const baseUrl = "https://aileadintel.com";
  const subscriptionId = (req.query.subscription_id || req.query.ba_token || "").toString();
  const customIdFromQuery = (req.query.custom_id || "").toString();
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

    // Mark client paid + active (only when we actually have a subscription id)
    if (client && subscriptionId) {
      try {
        await fetch(`${supabaseUrl}/rest/v1/clients?id=eq.${client.id}`, {
          method: "PATCH",
          headers: { ...headers, "Content-Type": "application/json", Prefer: "return=minimal" },
          body: JSON.stringify({
            payment_external_id: subscriptionId,
            payment_pending: false,
            payment_status: "paid",
            paid_at: new Date().toISOString(),
            status: "active",
          }),
        });
        console.log("[paypal-return] marked client paid:", client.client_slug);
      } catch (e) {
        console.error("[paypal-return] update failed:", e.message);
      }
    }

    // ── SETUP EMAIL (Pro only) ──
    // Fires on a CONFIDENT match (slug or subscription id) even if PayPal
    // didn't include subscription_id. Not on the "most recent unpaid" guess.
    // send-setup-email dedups, so a PayPal double-return won't send twice.
    const planLower = (client?.plan || "").toLowerCase();
    const confidentMatch = matchedBy === "custom_id" || matchedBy === "subscription_id";
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
  // PLAN-BASED ROUTING
  let redirectPath;
  if (plan === "pro") {
    redirectPath = "/create-password";
  } else {
    redirectPath = "/confirmation";
  }
  const redirectUrl = `${baseUrl}${redirectPath}?${params.toString()}`;
  console.log("[paypal-return] plan:", plan, "→ 302:", redirectUrl);
  res.writeHead(302, { Location: redirectUrl });
  res.end();
}
