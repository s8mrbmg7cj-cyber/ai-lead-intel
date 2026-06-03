// api/provision.js
//
// ES MODULE, zero npm dependencies. Provisions a phone line per client from a
// pre-bought POOL of numbers (the phone_pool table). On each client setup it:
//   1. Creates/updates a Vapi assistant from the client's saved setup.
//   2. Atomically CLAIMS one free number from phone_pool (race-safe).
//   3. Attaches the assistant to that number in Vapi (importing it from Twilio
//      first if it isn't in Vapi yet).
//   4. Saves the number + IDs to the client and flips ai_setup_status -> 'ready'
//      (which fires your existing webhook + setup email + dashboard going live).
//   5. Pings your ntfy topic if the pool drops to <= LOW_STOCK free numbers.
//   6. If anything fails after claiming, the number is released back to the pool.
//
// Env: VAPI_PRIVATE_KEY (required), SUPABASE_SERVICE_KEY (recommended),
//      TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN (only needed to import not-yet-in-Vapi
//      numbers), NTFY_TOPIC (optional, for low-stock alerts), CLAUDE_MODEL (optional).

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://mbrhkeddgmywqqgdfdgx.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'sb_publishable__YkhmAu61Nr8VetJS8pJqA_MHrmO69t';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const VAPI_PRIVATE_KEY = process.env.VAPI_PRIVATE_KEY;
const VAPI_BASE = 'https://api.vapi.ai';
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || '';

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';

const NTFY_TOPIC = process.env.NTFY_TOPIC || '';
const LOW_STOCK = 3; // alert when free numbers drop to this or below

const VOICE_MAP = {
  warm_female:         { provider: 'openai', voiceId: 'shimmer' },
  professional_female: { provider: 'openai', voiceId: 'nova' },
  calm_male:           { provider: 'openai', voiceId: 'echo' },
  deep_male:           { provider: 'openai', voiceId: 'onyx' },
};

const enc = encodeURIComponent;

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

async function getUser(token) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  return r.json();
}

function sbHeaders(token, extra) {
  const useService = !!SUPABASE_SERVICE_ROLE_KEY;
  return Object.assign({
    apikey: useService ? SUPABASE_SERVICE_ROLE_KEY : SUPABASE_ANON_KEY,
    Authorization: `Bearer ${useService ? SUPABASE_SERVICE_ROLE_KEY : token}`,
    'Content-Type': 'application/json',
  }, extra || {});
}

async function vapi(path, method, payload) {
  const resp = await fetch(VAPI_BASE + path, {
    method,
    headers: { Authorization: `Bearer ${VAPI_PRIVATE_KEY}`, 'Content-Type': 'application/json' },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    let msg = json?.message || json?.error || `Vapi ${method} ${path} failed (${resp.status})`;
    if (Array.isArray(msg)) msg = msg.join('; ');
    throw new Error(msg);
  }
  return json;
}

async function notify(text) {
  if (!NTFY_TOPIC) return;
  try { await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, { method: 'POST', body: text }); } catch (_) {}
}

function buildSystemPrompt(c) {
  const L = [];
  L.push(`You are the AI receptionist for ${c.business_name || 'this business'}, a ${c.business_type || 'local service'} company.`);
  if (c.ai_personality) L.push(`Your tone is ${c.ai_personality}.`);
  if (c.service_area) L.push(`Service area: ${c.service_area}.`);
  if (c.business_hours) L.push(`Business hours: ${c.business_hours}.`);
  if (c.services_offered) L.push(`Services and any pricing you may quote: ${c.services_offered}.`);
  if (c.transfer_destination) L.push(`Offer to transfer the caller to a human when: ${c.transfer_destination}.`);
  if (c.emergency_rules) L.push(`Treat the call as an urgent emergency and escalate right away when: ${c.emergency_rules}.`);
  L.push("Always capture the caller's name, phone number, and reason for calling. Be concise and helpful.");
  return L.join('\n');
}

// Release a claimed number back to the pool (used if provisioning fails mid-way).
async function releaseNumber(token, phoneNumber) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/phone_pool?phone_number=eq.${enc(phoneNumber)}`, {
      method: 'PATCH',
      headers: sbHeaders(token),
      body: JSON.stringify({ client_id: null, assigned_at: null }),
    });
  } catch (e) { console.error('releaseNumber failed', e); }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  let claimedNumber = null;
  let token = null;

  try {
    if (!VAPI_PRIVATE_KEY) { res.status(500).json({ error: 'Server is missing VAPI_PRIVATE_KEY' }); return; }

    const authHeader = req.headers.authorization || '';
    token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) { res.status(401).json({ error: 'Missing authentication token' }); return; }

    const user = await getUser(token);
    if (!user || !user.id) { res.status(401).json({ error: 'Invalid or expired session' }); return; }
    const userId = user.id;

    const body = await readJsonBody(req);
    const clientSlug = body.client_slug;
    if (!clientSlug) { res.status(400).json({ error: 'Missing client_slug' }); return; }

    // Load the client row.
    const loadResp = await fetch(
      `${SUPABASE_URL}/rest/v1/clients?client_slug=eq.${enc(clientSlug)}&owner_user_id=eq.${enc(userId)}&select=*`,
      { headers: sbHeaders(token) }
    );
    const loadRows = await loadResp.json().catch(() => []);
    if (!loadResp.ok) { res.status(500).json({ error: (loadRows && loadRows.message) || 'Failed to load client' }); return; }
    const client = Array.isArray(loadRows) ? loadRows[0] : null;
    if (!client) { res.status(403).json({ error: 'No matching client for this account' }); return; }

    // Idempotent: already has a number → return it, claim nothing new.
    if (client.vapi_phone_number_id && client.twilio_number) {
      res.status(200).json({ ok: true, already: true, number: client.twilio_number });
      return;
    }

    // 1) Create or update the assistant, and persist its ID immediately so a retry reuses it.
    const voice = VOICE_MAP[client.voice_style] || VOICE_MAP.professional_female;
    const sysPrompt = { role: 'system', content: buildSystemPrompt(client) };
    const model = CLAUDE_MODEL
      ? { provider: 'anthropic', model: CLAUDE_MODEL, messages: [sysPrompt] }
      : { provider: 'openai', model: 'gpt-4o', messages: [sysPrompt] };
    const assistantPayload = {
      name: `${client.business_name || client.client_slug} receptionist`,
      firstMessage: client.caller_greeting || 'Thanks for calling. How can I help you today?',
      model,
      voice,
    };

    let assistantId = client.vapi_assistant_id;
    if (assistantId) {
      await vapi(`/assistant/${assistantId}`, 'PATCH', assistantPayload);
    } else {
      const assistant = await vapi('/assistant', 'POST', assistantPayload);
      assistantId = assistant.id;
      await fetch(`${SUPABASE_URL}/rest/v1/clients?client_slug=eq.${enc(clientSlug)}&owner_user_id=eq.${enc(userId)}`, {
        method: 'PATCH', headers: sbHeaders(token), body: JSON.stringify({ vapi_assistant_id: assistantId }),
      });
    }

    // 2) Atomically claim one free number from the pool.
    const claimResp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/claim_phone_number`, {
      method: 'POST', headers: sbHeaders(token), body: JSON.stringify({ p_client_id: client.id }),
    });
    const claimRows = await claimResp.json().catch(() => []);
    if (!claimResp.ok) { res.status(500).json({ error: (claimRows && claimRows.message) || 'Claim failed' }); return; }
    const claimed = Array.isArray(claimRows) ? claimRows[0] : claimRows;
    if (!claimed || !claimed.phone_number) {
      await notify('AI Lead Intel: phone number pool is EMPTY — a client could not be provisioned. Buy more numbers.');
      res.status(409).json({ error: 'No phone numbers available in the pool. Add more numbers.' });
      return;
    }
    claimedNumber = claimed.phone_number;

    // 3) Attach the assistant to that number (import from Twilio first if needed).
    let vapiPhoneId = claimed.vapi_phone_number_id;
    if (vapiPhoneId) {
      await vapi(`/phone-number/${vapiPhoneId}`, 'PATCH', { assistantId });
    } else {
      if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
        throw new Error(`Number ${claimedNumber} is not in Vapi and Twilio credentials are missing to import it.`);
      }
      const imported = await vapi('/phone-number', 'POST', {
        provider: 'twilio',
        number: claimedNumber,
        twilioAccountSid: TWILIO_ACCOUNT_SID,
        twilioAuthToken: TWILIO_AUTH_TOKEN,
        assistantId,
      });
      vapiPhoneId = imported.id;
      await fetch(`${SUPABASE_URL}/rest/v1/phone_pool?phone_number=eq.${enc(claimedNumber)}`, {
        method: 'PATCH', headers: sbHeaders(token), body: JSON.stringify({ vapi_phone_number_id: vapiPhoneId }),
      });
    }

    // 4) Save to the client + mark ready (fires your webhook → email + dashboard live).
    const saveResp = await fetch(`${SUPABASE_URL}/rest/v1/clients?client_slug=eq.${enc(clientSlug)}&owner_user_id=eq.${enc(userId)}`, {
      method: 'PATCH', headers: sbHeaders(token, { Prefer: 'return=representation' }),
      body: JSON.stringify({
        vapi_assistant_id: assistantId,
        vapi_phone_number_id: vapiPhoneId,
        twilio_number: claimedNumber,
        ai_setup_status: 'ready',
      }),
    });
    if (!saveResp.ok) {
      const e = await saveResp.json().catch(() => ({}));
      throw new Error('Saving the number to the client failed: ' + ((e && e.message) || saveResp.status));
    }

    // 5) Low-stock alert.
    try {
      const freeResp = await fetch(`${SUPABASE_URL}/rest/v1/phone_pool?client_id=is.null&select=id`, { headers: sbHeaders(token) });
      const freeRows = await freeResp.json().catch(() => []);
      const freeCount = Array.isArray(freeRows) ? freeRows.length : 0;
      if (freeCount <= LOW_STOCK) {
        await notify(`AI Lead Intel: only ${freeCount} phone number(s) left in the pool. Buy more soon.`);
      }
    } catch (e) { console.error('low-stock check failed', e); }

    res.status(200).json({ ok: true, number: claimedNumber, assistantId, phoneNumberId: vapiPhoneId });
  } catch (err) {
    console.error('provision error', err);
    if (claimedNumber && token) await releaseNumber(token, claimedNumber); // give the number back
    res.status(500).json({ error: err?.message || 'Provisioning failed' });
  }
}
