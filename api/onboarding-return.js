// api/onboarding-return.js
// PayPal returns here after subscription.
// Fix: hosted PayPal links often DO NOT return custom_id, so if exact match fails,
// safely match the most recent unpaid / setup-not-sent client from the last 30 minutes.

export default async function handler(req, res) {
  console.log("[paypal-return] hit:", { query: req.query });

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY;
  const baseUrl = "https://aileadintel.com";

  const subscriptionId = String(req.query.subscription_id || req.query.ba_token || "");
  const customId = String(req.query.custom_id || req.query.slug || "");

  if (!supabaseUrl || !supabaseKey) {
    console.error("[paypal-return] missing Supabase env vars");
    return redirect(res, `${baseUrl}/confirmation?paid=0&error=server`);
  }

  const headers = {
    apikey: supabaseKey,
    Authorization: `Bearer ${supabaseKey}`,
  };

  let client = null;
  let matchedBy = null;

  async function fetchRows(url) {
    const r = await fetch(url, { headers });
    const text = await r.text();
    if (!r.ok) {
      console.error("[paypal-return] fetch failed:", r.status, text.slice(0, 500));
      return [];
    }
    try {
      return JSON.parse(text);
    } catch {
      return [];
    }
  }

  // 1. Try slug/custom_id if present
  if (customId) {
    const rows = await fetchRows(
      `${supabaseUrl}/rest/v1/clients?client_slug=eq.${encodeURIComponent(customId)}&select=*&limit=1`
    );
    if (rows[0]) {
      client = rows[0];
      matchedBy = "custom_id";
    }
  }

  // 2. Try PayPal subscription ID
  if (!client && subscriptionId) {
    const rows = await fetchRows(
      `${supabaseUrl}/rest/v1/clients?payment_external_id=eq.${encodeURIComponent(subscriptionId)}&select=*&limit=1`
    );
    if (rows[0]) {
      client = rows[0];
      matchedBy = "subscription_id";
    }
  }

  // 3. Hosted PayPal fallback:
  // Find newest client that just onboarded and has not received setup email.
  if (!client) {
    const since = new Date(Date.now() - 30 * 60 * 1000).toISOString();

    const rows = await fetchRows(
      `${supabaseUrl}/rest/v1/clients?created_at=gte.${encodeURIComponent(since)}&setup_email_sent=is.false&select=*&order=created_at.desc&limit=1`
    );

    if (rows[0]) {
      client = rows[0];
      matchedBy = "recent_unfinished_client";
    }
  }

  console.log("[paypal-return] client match:", {
    matchedBy,
    slug: client?.client_slug,
    plan: client?.plan,
    subscriptionId,
  });

  if (!client) {
    console.error("[paypal-return] no client found");
    return redirect(res, `${baseUrl}/confirmation?paid=1&error=no_client`);
  }

  // 4. Mark paid + save PayPal subscription id
  try {
    const patchBody = {
      payment_pending: false,
      payment_status: "paid",
      paid_at: new Date().toISOString(),
      status: "active",
    };

    if (subscriptionId) {
      patchBody.payment_external_id = subscriptionId;
    }

    const patch = await fetch(`${supabaseUrl}/rest/v1/clients?id=eq.${client.id}`, {
      method: "PATCH",
      headers: {
        ...headers,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify(patchBody),
    });

    const patchText = await patch.text();
    if (!patch.ok) {
      console.error("[paypal-return] paid patch failed:", patch.status, patchText);
    } else {
      const rows = JSON.parse(patchText || "[]");
      if (rows[0]) client = rows[0];
      console.log("[paypal-return] marked paid:", client.client_slug);
    }
  } catch (e) {
    console.error("[paypal-return] paid patch exception:", e.message);
  }

  // 5. Trigger setup email for Pro
  const plan = String(client.plan || "starter").toLowerCase();

  if (plan === "pro" && client.client_slug) {
    console.log("[paypal-return] triggering setup email:", client.client_slug);

    try {
      const er = await fetch(`${baseUrl}/api/send-setup-email`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-internal-secret": process.env.SUPABASE_WEBHOOK_SECRET || "",
        },
        body: JSON.stringify({
          client_slug: client.client_slug,
          force: true,
        }),
      });

      const text = await er.text();

      if (er.ok) {
        console.log("[paypal-return] setup email sent:", text.slice(0, 300));
      } else {
        console.error("[paypal-return] setup email failed:", er.status, text.slice(0, 500));
      }
    } catch (e) {
      console.error("[paypal-return] setup email exception:", e.message);
    }
  } else {
    console.log("[paypal-return] no setup email needed:", {
      plan,
      slug: client.client_slug,
    });
  }

  // 6. Final redirect
  const params = new URLSearchParams();
  params.set("plan", plan);
  params.set("slug", client.client_slug || "");
  params.set("business", client.business_name || "");
  params.set("paid", "1");
  if (subscriptionId) params.set("paypal_sub", subscriptionId);
  if (client.notify_email) params.set("email", client.notify_email);

  const path = plan === "pro" ? "/confirmation" : "/confirmation";
  return redirect(res, `${baseUrl}${path}?${params.toString()}`);
}

function redirect(res, url) {
  console.log("[paypal-return] redirect:", url);
  res.writeHead(302, { Location: url });
  res.end();
}
