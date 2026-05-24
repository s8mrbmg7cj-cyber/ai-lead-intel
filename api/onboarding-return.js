export default async function handler(req, res) {
  console.log("[paypal-return] hit:", {
    method: req.method,
    query: req.query
  });

  const baseUrl = "https://aileadintel.com";

  const subscriptionId =
    (req.query.subscription_id || "").toString();

  const redirectUrl =
    `${baseUrl}/onboarding/success?paypal_sub=` +
    encodeURIComponent(subscriptionId);

  console.log("[paypal-return] redirect:", redirectUrl);

  res.writeHead(302, {
    Location: redirectUrl
  });

  res.end();
}
