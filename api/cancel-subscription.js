// api/cancel-subscription.js
// Lets a signed-in customer cancel their own subscription from /account.
//  1) Verifies their Supabase session and that they own the client row.
//  2) Cancels the PayPal subscription via the PayPal API.
//  3) Marks the client cancelled, frees their number, deletes Vapi resources.
//  4) Alerts the owner (push + email).
// The PayPal CANCELLED webhook that follows is harmless — the webhook skips
// its own alert when the client is already marked cancelled.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, PAYPAL_CLIENT_ID,
//      PAYPAL_CLIENT_SECRET, PAYPAL_ENV, VAPI_PRIVATE_KEY (optional),
//      NTFY_TOPIC / RESEND_API_KEY / NOTIFY_EMAIL (for the owner alert)

export const config = { maxDuration: 30 };

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_ANON_KEY = 'sb_publishable__YkhmAu61Nr8VetJS8pJqA_MHrmO69t';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY || '';
const PAYPAL_ENV = process.env.PAYPAL_ENV || 'live';
const PAYPAL_BASE = PAYPAL_ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';

function sbHeaders(extra) {
  return Object.assign(
    { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
    extra || {}
  );
}

async function getUser(token) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  return r.json();
}

async function paypalToken() {
  const id = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!id || !secret) throw new Error('PayPal credentials missing');
  const auth = Buffer.from(`${id}:${secret}`).toString('base64');
  const r = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!r.ok) throw new Error(`PayPal token error ${r.status}`);
  const j = await r.json();
  return j.access_token;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!SUPABASE_URL || !SERVICE_KEY) return res.status(500).json({ error: 'Server misconfigured' });

  try {
    // ── 1) Who is asking, and do they own this client? ──
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Not signed in' });
    const user = await getUser(token);
    if (!user || !user.id) return res.status(401).json({ error: 'Invalid or expired session' });

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    const clientSlug = (body && body.client_slug) || '';
    if (!clientSlug) return res.status(400).json({ error: 'Missing client_slug' });

    const loadResp = await fetch(
      `${SUPABASE_URL}/rest/v1/clients?client_slug=eq.${encodeURIComponent(clientSlug)}&owner_user_id=eq.${encodeURIComponent(user.id)}&select=*&limit=1`,
      { headers: sbHeaders() }
    );
    const rows = await loadResp.json().catch(() => []);
    let client = Array.isArray(rows) ? rows[0] : null;

    // Fallback: the ownership link can be stale (e.g. the original login was
    // deleted and recreated). If the signed-in email matches the account's
    // notification email, accept them and repair the link.
    if (!client) {
      const r2 = await fetch(
        `${SUPABASE_URL}/rest/v1/clients?client_slug=eq.${encodeURIComponent(clientSlug)}&select=*&limit=1`,
        { headers: sbHeaders() }
      );
      const rows2 = await r2.json().catch(() => []);
      const cand = Array.isArray(rows2) ? rows2[0] : null;
      const userEmail = String(user.email || '').toLowerCase();
      if (cand && userEmail && String(cand.notify_email || '').toLowerCase() === userEmail) {
        client = cand;
        try {
          await fetch(`${SUPABASE_URL}/rest/v1/clients?id=eq.${client.id}`, {
            method: 'PATCH',
            headers: sbHeaders({ Prefer: 'return=minimal' }),
            body: JSON.stringify({ owner_user_id: user.id }),
          });
          console.log('[cancel-subscription] repaired stale owner link for', client.client_slug);
        } catch (_) {}
      }
    }
    if (!client) return res.status(403).json({ error: 'No matching subscription for this account' });

    if ((client.status || '').toLowerCase() === 'cancelled') {
      return res.status(200).json({ ok: true, already: true, message: 'Already cancelled.' });
    }

    // ── 2) Cancel the PayPal subscription itself ──
    let paypalResult = 'no_subscription_on_file';
    if (client.payment_external_id) {
      try {
        const pt = await paypalToken();
        const cr = await fetch(`${PAYPAL_BASE}/v1/billing/subscriptions/${encodeURIComponent(client.payment_external_id)}/cancel`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${pt}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: 'Customer requested cancellation from account page' }),
        });
        if (cr.status === 204) {
          paypalResult = 'cancelled';
        } else {
          const t = await cr.text().catch(() => '');
          // 422 usually means it's already cancelled/expired on PayPal's side.
          if (cr.status === 422) paypalResult = 'already_inactive_on_paypal';
          else {
            console.error('[cancel-subscription] PayPal cancel failed:', cr.status, t.slice(0, 300));
            return res.status(502).json({ error: 'PayPal could not cancel the subscription. Please try again or email hello@aileadintel.com.' });
          }
        }
      } catch (e) {
        console.error('[cancel-subscription] PayPal error:', e.message);
        return res.status(502).json({ error: 'PayPal could not be reached. Please try again or email hello@aileadintel.com.' });
      }
    }
    console.log('[cancel-subscription]', clientSlug, 'paypal:', paypalResult);

    // ── 3) Local cleanup: mark cancelled, free number, remove Vapi resources ──
    const VAPI_PRIVATE_KEY = process.env.VAPI_PRIVATE_KEY;
    if (VAPI_PRIVATE_KEY) {
      const vapiDel = async (path) => {
        try {
          const r = await fetch(`https://api.vapi.ai${path}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${VAPI_PRIVATE_KEY}` },
          });
          if (!r.ok && r.status !== 404) console.error('[cancel-subscription] vapi delete failed', path, r.status);
        } catch (e) { console.error('[cancel-subscription] vapi delete error', path, e.message); }
      };
      if (client.vapi_phone_number_id) await vapiDel(`/phone-number/${client.vapi_phone_number_id}`);
      if (client.vapi_assistant_id) await vapiDel(`/assistant/${client.vapi_assistant_id}`);
    }

    // Free ANY pool number still credited to this client — keyed on client_id,
    // the pool's source of truth, so it works even if the client row's
    // twilio_number was already cleared.
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/phone_pool?client_id=eq.${encodeURIComponent(client.id)}`, {
        method: 'PATCH',
        headers: sbHeaders({ Prefer: 'return=minimal' }),
        body: JSON.stringify({ client_id: null, assigned_at: null, vapi_phone_number_id: null }),
      });
    } catch (e) { console.error('[cancel-subscription] pool release (by client_id) error:', e.message); }
    if (client.twilio_number) {
      try {
        await fetch(`${SUPABASE_URL}/rest/v1/phone_pool?phone_number=eq.${encodeURIComponent(client.twilio_number)}`, {
          method: 'PATCH',
          headers: sbHeaders({ Prefer: 'return=minimal' }),
          body: JSON.stringify({ client_id: null, assigned_at: null, vapi_phone_number_id: null }),
        });
      } catch (e) { console.error('[cancel-subscription] pool release (by number) error:', e.message); }
    }

    await fetch(`${SUPABASE_URL}/rest/v1/clients?id=eq.${client.id}`, {
      method: 'PATCH',
      headers: sbHeaders({ Prefer: 'return=minimal' }),
      body: JSON.stringify({
        status: 'cancelled',
        active: false,
        payment_status: 'cancelled',
        payment_pending: false,
        twilio_number: null,
        vapi_phone_number_id: null,
        vapi_assistant_id: null,
        setup_complete: false,
      }),
    });

    // ── 4) Tell the owner, and email the customer how to turn off forwarding ──
    await alertOwnerCancelled(client);
    await sendCancelEmailToCustomer(client);

    return res.status(200).json({ ok: true, cancelled: true, paypal: paypalResult });
  } catch (err) {
    console.error('[cancel-subscription] ERROR:', err.message);
    return res.status(500).json({ error: 'Something went wrong. Please try again or email hello@aileadintel.com.' });
  }
}

async function sendCancelEmailToCustomer(client) {
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_API_KEY || !client.notify_email) return;
  const biz = client.business_name || "your business";
  const html = `
  <div style="background:#f6f7f9;padding:24px 12px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
    <div style="max-width:480px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:14px;padding:32px 28px;">
      <div style="width:34px;height:34px;border-radius:9px;background:#ff6a00;margin-bottom:20px;"></div>
      <div style="font-size:19px;font-weight:700;color:#111827;margin-bottom:10px;">Your subscription is cancelled</div>
      <div style="font-size:14px;line-height:1.65;color:#4b5563;margin-bottom:18px;">
        Your AI Lead Intel subscription for ${biz} has been cancelled and you won't be billed again. Your AI receptionist has stopped answering and its phone number has been released.
      </div>
      <div style="background:#fff8f3;border:1px solid #ffd9bd;border-radius:10px;padding:14px 16px;font-size:14px;line-height:1.6;color:#111827;margin-bottom:18px;">
        <strong>Important — if you forwarded your business line to the AI:</strong> turn that forwarding OFF now, or calls to your business number will stop going through. Dial the code for your carrier from your business phone:
        <div style="margin-top:10px;font-size:13.5px;color:#4b5563;">
          • Verizon, US Cellular &amp; most landlines: <strong>*73</strong><br/>
          • AT&amp;T: <strong>#21#</strong><br/>
          • T-Mobile, Metro, Mint: <strong>##21#</strong><br/>
          • Internet / VoIP phones: turn off call forwarding in your provider's app or settings
        </div>
      </div>
      <div style="font-size:13.5px;line-height:1.6;color:#4b5563;">
        Changed your mind? You're welcome back anytime at <a href="https://aileadintel.com" style="color:#c2410c;text-decoration:none;">aileadintel.com</a>. Questions? Just reply to this email.
      </div>
      <div style="font-size:12px;color:#c0c0c6;margin-top:22px;border-top:1px solid #f0f0f2;padding-top:16px;">AI Lead Intel</div>
    </div>
  </div>`;
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "AI Lead Intel <hello@aileadintel.com>",
        to: [client.notify_email],
        replyTo: "hello@aileadintel.com",
        subject: "Your AI Lead Intel subscription is cancelled",
        html,
      }),
    });
  } catch (e) {
    console.error("[cancel-subscription] customer email error:", e.message);
  }
}

async function alertOwnerCancelled(client) {
  const biz = client.business_name || client.client_slug || 'A client';
  const msg = `${biz} cancelled their subscription from the account page.` +
    (client.twilio_number ? ` Their number ${client.twilio_number} was freed.` : '');
  const topic = process.env.NTFY_TOPIC;
  if (topic) {
    try {
      await fetch(`https://ntfy.sh/${topic}`, {
        method: 'POST',
        headers: { Title: 'Client cancelled', Priority: 'high', Tags: 'warning' },
        body: msg,
      });
    } catch (e) { console.error('[cancel-subscription] ntfy failed:', e.message); }
  }
  const key = process.env.RESEND_API_KEY;
  const to = process.env.NOTIFY_EMAIL;
  if (key && to) {
    try {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'AI Lead Intel <hello@aileadintel.com>',
          to: [to],
          subject: `Client cancelled — ${biz}`,
          text: msg,
        }),
      });
    } catch (e) { console.error('[cancel-subscription] email failed:', e.message); }
  }
}
