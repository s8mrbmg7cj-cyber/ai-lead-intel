// api/onboarding-return.js
// PayPal sends customers here after successful subscription.
// Looks up client, marks paid, redirects to success page with all params.

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

    if (customIdFromQuery) {
      try {
        const r = await fetch(`${supabaseUrl}/rest/v1/clients?client_slug=eq.${encodeURIComponent(customIdFromQuery)}&select=*&limit=1`, { headers });
        if (r.ok) { const rows = await r.json().catch(() => []); if (rows[0]) client = rows[0]; }
      } catch (e) { console.warn("[paypal-return] custom_id lookup:", e.message); }
    }

    if (!client && subscriptionId) {
      try {
        const r = await fetch(`${supabaseUrl}/rest/v1/clients?payment_external_id=eq.${encodeURIComponent(subscriptionId)}&select=*&limit=1`, { headers });
        if (r.ok) { const rows = await r.json().catch(() => []); if (rows[0]) client = rows[0]; }
      } catch (e) { console.warn("[paypal-return] sub_id lookup:", e.message); }
    }

    if (!client) {
      try {
        const r = await fetch(`${supabaseUrl}/rest/v1/clients?payment_status=eq.unpaid&select=*&order=created_at.desc&limit=1`, { headers });
        if (r.ok) { const rows = await r.json().catch(() => []); if (rows[0]) client = rows[0]; }
      } catch (e) { console.warn("[paypal-return] fallback lookup:", e.message); }
    }

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
      } catch (e) { console.error("[paypal-return] update failed:", e.message); }
    }
  }

  const params = new URLSearchParams();
  params.set("plan", client?.plan || "starter");
  params.set("slug", client?.client_slug || "");
  params.set("business", client?.business_name || "");
  if (client?.report_frequency) params.set("freq", client.report_frequency);
  if (client?.report_email) params.set("report_email", client.report_email);
  if (subscriptionId) params.set("paypal_sub", subscriptionId);
  params.set("paid", subscriptionId ? "1" : "0");

  // After payment, send customer to create-password (they'll then sign in)
  const redirectUrl = `${baseUrl}/create-password?${params.toString()}`;
  console.log("[paypal-return] 302 →", redirectUrl);
  res.writeHead(302, { Location: redirectUrl });
  res.end();
}
