// Sends a password-reset email FROM hello@aileadintel.com (via Resend),
// instead of Supabase's default sender. It mints a recovery link with the
// Supabase admin API, then emails that link ourselves with our own branding.
//
// Flow: sign-in page → POST { email } here → we generate the recovery link →
// Resend emails it → user clicks → lands on /reset-password to set a new one.

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const SITE = "https://aileadintel.com";

  let email = "";
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    email = String(body.email || "").trim().toLowerCase();
  } catch (_) {}

  // Always answer the same way so we never reveal whether an email has an
  // account (standard security practice for password reset).
  const genericOk = () =>
    res.status(200).json({ ok: true, message: "If that email has an account, a reset link is on its way." });

  if (!email || !email.includes("@")) return genericOk();
  if (!SUPABASE_URL || !SERVICE_KEY || !RESEND_API_KEY) {
    console.error("[forgot-password] missing env (SUPABASE_URL / SUPABASE_SERVICE_KEY / RESEND_API_KEY)");
    return genericOk();
  }

  try {
    // 1) Mint a recovery link pointing at our reset page.
    const genResp = await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
      method: "POST",
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: "recovery",
        email,
        options: { redirect_to: `${SITE}/reset-password` },
      }),
    });

    const gen = await genResp.json().catch(() => ({}));
    // No account for this email (or any error) → stay generic, don't leak it.
    if (!genResp.ok) {
      console.log("[forgot-password] generate_link non-OK:", genResp.status);
      return genericOk();
    }
    const actionLink = gen.action_link || (gen.properties && gen.properties.action_link);
    if (!actionLink) {
      console.log("[forgot-password] no action_link in response");
      return genericOk();
    }

    // 2) Email the link ourselves, from hello@aileadintel.com.
    const html = `
    <div style="background:#f6f7f9;padding:24px 12px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
      <div style="max-width:480px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:14px;padding:32px 28px;">
        <div style="width:34px;height:34px;border-radius:9px;background:#ff6a00;margin-bottom:20px;"></div>
        <div style="font-size:19px;font-weight:700;color:#111827;margin-bottom:10px;">Reset your password</div>
        <div style="font-size:14px;line-height:1.65;color:#4b5563;margin-bottom:24px;">
          We got a request to reset the password for your AI Lead Intel account. Click the button below to choose a new password. This link expires shortly and can only be used once.
        </div>
        <a href="${actionLink}" style="display:inline-block;background:#ff6a00;color:#0a0a0d;font-size:15px;font-weight:600;text-decoration:none;padding:13px 26px;border-radius:10px;">Set a new password</a>
        <div style="font-size:13px;line-height:1.6;color:#9ca3af;margin-top:24px;">
          If you didn't request this, you can safely ignore this email — your password won't change.
        </div>
        <div style="font-size:12px;color:#c0c0c6;margin-top:22px;border-top:1px solid #f0f0f2;padding-top:16px;">AI Lead Intel · every call answered, every lead captured</div>
      </div>
    </div>`;

    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "AI Lead Intel <hello@aileadintel.com>",
        to: [email],
        replyTo: "hello@aileadintel.com",
        subject: "Reset your AI Lead Intel password",
        html,
      }),
    });

    return genericOk();
  } catch (e) {
    console.error("[forgot-password] error:", e.message);
    return genericOk();
  }
}
