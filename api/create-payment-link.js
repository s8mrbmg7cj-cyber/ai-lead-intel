// api/create-payment-link.js
//
// Generate or fetch a payment link for a given client_slug.
//
// USAGE:
//   POST /api/create-payment-link
//   Body: { client_slug: "andrew-afnz", admin_token: "..." }
//
// FLOW:
//   1. Lookup client by client_slug in Supabase
//   2. If they already have a payment_link, return it
//   3. Otherwise, generate a new link (PayPal for now; Stripe-ready stub below)
//   4. Save link + external_id back to the client row
//   5. Return { success, payment_link, provider, amount }
//
// THIS IS AN ADMIN-ONLY ENDPOINT — protected by ADMIN_API_TOKEN.

import { rateLimit, getClientIp } from '../lib/rate-limit.js';

const PLAN_PRICING = {
  starter: { amount: 97.00, label: "AI Lead Intel — Starter" },
  pro: { amount: 297.00, label: "AI Lead Intel — Pro" },
};

// ============================================================
// PROVIDER IMPLEMENTATIONS
// ============================================================

/**
 * PAYPAL — Current provider.
 *
 * For NOW: returns a manual PayPal.me link pointing to your PayPal handle.
 * You manually verify payment when it comes in, then call /api/mark-paid.
 *
 * LATER (when you have PayPal Business + API keys):
 * Replace the body of this function with a real call to PayPal's
 * Orders API or Invoicing API to create a hosted checkout URL.
 *
 * Required env vars when you go live with PayPal API:
 *   PAYPAL_CLIENT_ID
 *   PAYPAL_CLIENT_SECRET
 *   PAYPAL_MODE = "sandbox" or "live"
 *   PAYPAL_ME_HANDLE = your @paypal.me handle (fallback)
 */
async function createPayPalLink(client, planAmount, planLabel) {
  const paypalMeHandle = process.env.PAYPAL_ME_HANDLE || "aileadintel";

  // ====== REAL PAYPAL API INTEGRATION (uncomment when ready) ======
  //
  // const clientId = process.env.PAYPAL_CLIENT_ID;
  // const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  // const mode = process.env.PAYPAL_MODE === "live" ? "live" : "sandbox";
  // const base = mode === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
  //
  // // 1. Get an OAuth access token
  // const authRes = await fetch(`${base}/v1/oauth2/token`, {
  //   method: "POST",
  //   headers: {
  //     "Authorization": "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
  //     "Content-Type": "application/x-www-form-urlencoded",
  //   },
  //   body: "grant_type=client_credentials",
  // });
  // const { access_token } = await authRes.json();
  //
  // // 2. Create an order
  // const orderRes = await fetch(`${base}/v2/checkout/orders`, {
  //   method: "POST",
  //   headers: { "Authorization": `Bearer ${access_token}`, "Content-Type": "application/json" },
  //   body: JSON.stringify({
  //     intent: "CAPTURE",
  //     purchase_units: [{
  //       reference_id: client.client_slug,
  //       description: planLabel,
  //       amount: { currency_code: "USD", value: planAmount.toFixed(2) },
  //     }],
  //     application_context: {
  //       return_url: `https://aileadintel.com/dashboard/${client.client_slug}?paid=1`,
  //       cancel_url: `https://aileadintel.com/dashboard/${client.client_slug}?paid=0`,
  //       brand_name: "AI Lead Intel",
  //       user_action: "PAY_NOW",
  //     },
  //   }),
  // });
  // const order = await orderRes.json();
  // const approvalLink = order.links.find((l) => l.rel === "approve").href;
  // return {
  //   provider: "paypal",
  //   payment_link: approvalLink,
  //   external_id: order.id,
  //   amount: planAmount,
  // };
  //
  // ====== END REAL PAYPAL API ======

  // FALLBACK: paypal.me link (manual verification)
  // You'll get an email when paid; call /api/mark-paid to mark client paid.
  const amountFormatted = planAmount.toFixed(2);
  const link = `https://paypal.me/${paypalMeHandle}/${amountFormatted}USD`;
  const externalId = `manual-${client.client_slug}-${Date.now()}`;
  return {
    provider: "paypal",
    payment_link: link,
    external_id: externalId,
    amount: planAmount,
  };
}

/**
 * STRIPE — Future provider (commented stub).
 *
 * Uncomment + fill in when you switch from PayPal to Stripe.
 *
 * Required env vars when you switch:
 *   STRIPE_SECRET_KEY
 *   STRIPE_STARTER_PRICE_ID
 *   STRIPE_PRO_PRICE_ID
 */
// async function createStripeLink(client, planAmount, planLabel) {
//   const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
//   const priceId = client.plan === "pro"
//     ? process.env.STRIPE_PRO_PRICE_ID
//     : process.env.STRIPE_STARTER_PRICE_ID;
//
//   const session = await stripe.checkout.sessions.create({
//     mode: "subscription",
//     line_items: [{ price: priceId, quantity: 1 }],
//     success_url: `https://aileadintel.com/dashboard/${client.client_slug}?paid=1`,
//     cancel_url: `https://aileadintel.com/dashboard/${client.client_slug}?paid=0`,
//     client_reference_id: client.client_slug,
//     customer_email: client.notify_email,
//   });
//   return {
//     provider: "stripe",
//     payment_link: session.url,
//     external_id: session.id,
//     amount: planAmount,
//   };
// }

// ============================================================
// HANDLER
// ============================================================

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).json({ ok: true });
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  // Rate limit
  const ip = getClientIp(req);
  const limit = rateLimit(`payment-link:${ip}`, 30, 60 * 60);
  if (!limit.ok) {
    res.setHeader("Retry-After", String(limit.retryAfter));
    return res.status(429).json({ success: false, error: "Too many requests" });
  }

  // Parse body
  let body = req.body || {};
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (_) { body = {}; }
  }

  // Admin auth — required for this endpoint
  const adminToken = body.admin_token || req.headers["x-admin-token"];
  if (!adminToken || adminToken !== process.env.ADMIN_API_TOKEN) {
    console.warn("[payment-link] 🚫 unauthorized");
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }

  const clientSlug = (body.client_slug || "").toLowerCase().replace(/[^a-z0-9-]/g, "");
  if (!clientSlug) {
    return res.status(400).json({ success: false, error: "Missing client_slug" });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (!supabaseUrl || !supabaseKey) {
    console.error("[payment-link] ❌ Supabase env vars missing");
    return res.status(500).json({ success: false, error: "Server misconfigured" });
  }

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

  // 1. Lookup client
  console.log("[payment-link] 🔍 looking up client:", clientSlug);
  let client;
  try {
    const lookupRes = await fetch(
      `${supabaseUrl}/rest/v1/clients?client_slug=eq.${encodeURIComponent(clientSlug)}&select=*&limit=1`,
      { headers: readHeaders }
    );
    if (!lookupRes.ok) throw new Error(`Lookup failed (HTTP ${lookupRes.status})`);
    const rows = await lookupRes.json();
    if (!rows || rows.length === 0) {
      console.warn("[payment-link] ❌ client not found:", clientSlug);
      return res.status(404).json({ success: false, error: "Client not found" });
    }
    client = rows[0];
  } catch (err) {
    console.error("[payment-link] ❌ lookup exception:", err.message);
    return res.status(500).json({ success: false, error: "Could not find client" });
  }

  // 2. If they already have a payment_link AND it's still pending, return it
  if (client.payment_link && client.payment_pending === true && body.force_new !== true) {
    console.log("[payment-link] ✅ returning existing payment link");
    return res.status(200).json({
      success: true,
      payment_link: client.payment_link,
      provider: client.payment_provider || "paypal",
      amount: client.payment_amount,
      external_id: client.payment_external_id,
      reused: true,
    });
  }

  // 3. Build a new link (PayPal for now)
  const planKey = (client.plan === "pro") ? "pro" : "starter";
  const pricing = PLAN_PRICING[planKey];
  console.log(`[payment-link] 💳 creating PayPal link — plan: ${planKey}, amount: $${pricing.amount}`);

  let result;
  try {
    result = await createPayPalLink(client, pricing.amount, pricing.label);
    // FUTURE: result = await createStripeLink(client, pricing.amount, pricing.label);
  } catch (err) {
    console.error("[payment-link] ❌ provider error:", err.message);
    return res.status(500).json({ success: false, error: "Could not create payment link" });
  }

  // 4. Save link back to client row
  console.log("[payment-link] 💾 saving payment link to client row");
  try {
    const patchRes = await fetch(
      `${supabaseUrl}/rest/v1/clients?id=eq.${client.id}`,
      {
        method: "PATCH",
        headers: writeHeaders,
        body: JSON.stringify({
          payment_link: result.payment_link,
          payment_external_id: result.external_id,
          payment_provider: result.provider,
          payment_amount: result.amount,
          payment_pending: true,
          payment_status: "unpaid",
          payment_required: true,
        }),
      }
    );
    if (!patchRes.ok) {
      const text = await patchRes.text().catch(() => "");
      console.error("[payment-link] ❌ save failed:", patchRes.status, text);
      return res.status(500).json({ success: false, error: "Could not save payment link" });
    }
  } catch (err) {
    console.error("[payment-link] ❌ save exception:", err.message);
    return res.status(500).json({ success: false, error: "Could not save payment link" });
  }

  console.log("[payment-link] ✅ link created and saved");
  return res.status(200).json({
    success: true,
    payment_link: result.payment_link,
    provider: result.provider,
    amount: result.amount,
    external_id: result.external_id,
    reused: false,
  });
}
