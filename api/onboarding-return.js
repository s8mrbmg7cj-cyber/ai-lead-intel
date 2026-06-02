// api/onboarding-return.js
// PayPal sends customers here after successful subscription.
// Looks up client, marks paid, sends the setup email, then redirects:
//   - Pro     → /create-password  (then auto-signed-in → /setup → dashboard)
//   - Starter → /confirmation     (no dashboard access, no password needed)
export default async function handler(req, res) {
  console.log("[paypal-return] hit:", { query: req.query });
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY;
  const baseUrl = "https://aileadintel.com";
  const subscriptionId = (req.query.subscription_id || req.query.ba_token || "").toString();
  const customIdFromQuery = (req.query.custom_id || "").toString();
  let client = null;
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
          if (rows[0]) client = rows[0];
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
          if (rows[0]) client = rows[0];
        }
      } catch (e) {
        console.warn("[paypal-return] sub_id lookup:", e.message);
      }
    }
    // 3. Fallback — most recent unpaid
    if (!client) {
      try {
        const r = await fetch(
          `${supabaseUrl}/rest/v1/clients?payment_status=eq.unpaid&select=*&order=created_at.desc&limit=1`,
          { headers }
        );
        if (r.ok) {
          const rows = await r.json().catch(() => []);
          if (rows[0]) client = rows[0];
        }
      } catch (e) {
        console.warn("[paypal-return] fallback lookup:", e.message);
      }
    }
    // Mark client paid + active
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

      // ── SETUP EMAIL: fire immediately after payment is confirmed ──
      // Awaited before the redirect (the function can freeze after res.end()).
      // send-setup-email is idempotent (dedups on setup_email_sent), so a
      // PayPal double-fire won't send twice.
      // PRO ONLY: Starter has no password / no dashboard, so it gets the
      // /confirmation page instead — not a "Create My Password" email.
      if (client.client_slug && (client.plan || "").toLowerCase() === "pro") {
        try {
          const er = await fetch(`${baseUrl}/api/send-setup-email`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-internal-secret": process.env.SUPABASE_WEBHOOK_SECRET || "",
            },
            body: JSON.stringify({ client_slug: client.client_slug }),
          });
          if (er.ok) {
            console.log("[paypal-return] ✅ setup email triggered for", client.client_slug);
          } else {
            const t = await er.text().catch(() => "");
            console.error("[paypal-return] ⚠️ setup email failed:", er.status, t.slice(0, 300));
          }
        } catch (e) {
          console.error("[paypal-return] ⚠️ setup email trigger error:", e.message);
        }
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
  // PLAN-BASED ROUTING
  let redirectPath;
  if (plan === "pro") {
    // Pro: create password → setup → dashboard
    redirectPath = "/create-password";
  } else {
    // Starter: confirmation only (no dashboard, no password)
    redirectPath = "/confirmation";
  }
  const redirectUrl = `${baseUrl}${redirectPath}?${params.toString()}`;
  console.log("[paypal-return] plan:", plan, "→ 302:", redirectUrl);
  res.writeHead(302, { Location: redirectUrl });
  res.end();
}
