// api/provision.js
//
// ES MODULE, ZERO npm dependencies (plain fetch for both Supabase and Vapi).
// Auto-provisions a phone line for a client:
//   1. Creates/updates a Vapi assistant from the client's saved setup.
//   2. Creates a Vapi-managed US number and attaches that assistant for inbound calls.
//   3. Saves the number + Vapi IDs back onto the client's row so the UI shows it.
// Idempotent: if a number already exists, it returns it without creating duplicates.
//
// Required env var:  VAPI_PRIVATE_KEY
// Recommended:       SUPABASE_SERVICE_ROLE_KEY  (so DB writes bypass RLS)
// First run in Supabase SQL editor:
//   alter table clients
//     add column if not exists vapi_assistant_id text,
//     add column if not exists vapi_phone_number_id text,
//     add column if not exists twilio_number text;

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://mbrhkeddgmywqqgdfdgx.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'sb_publishable__YkhmAu61Nr8VetJS8pJqA_MHrmO69t';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const VAPI_PRIVATE_KEY = process.env.VAPI_PRIVATE_KEY;
const VAPI_BASE = 'https://api.vapi.ai';
// If set, the assistant's brain runs on Anthropic/Claude; otherwise falls back to GPT-4o.
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || '';

// Map your setup form's voice_style values to a real Vapi voice.
// 'openai' voices work out of the box; swap to '11labs' + a voiceId for more natural audio.
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
  const usingService = !!SUPABASE_SERVICE_ROLE_KEY;
  return Object.assign({
    apikey: usingService ? SUPABASE_SERVICE_ROLE_KEY : SUPABASE_ANON_KEY,
    Authorization: `Bearer ${usingService ? SUPABASE_SERVICE_ROLE_KEY : token}`,
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

function toE164(raw) {
  const d = ('' + raw).replace(/[^\d]/g, '');
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d[0] === '1') return '+' + d;
  return ('' + raw).trim();
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

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    if (!VAPI_PRIVATE_KEY) {
      res.status(500).json({ error: 'Server is missing the VAPI_PRIVATE_KEY environment variable' });
      return;
    }

    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) { res.status(401).json({ error: 'Missing authentication token' }); return; }

    const user = await getUser(token);
    if (!user || !user.id) { res.status(401).json({ error: 'Invalid or expired session' }); return; }
    const userId = user.id;

    const body = await readJsonBody(req);
    const clientSlug = body.client_slug;
    if (!clientSlug) { res.status(400).json({ error: 'Missing client_slug' }); return; }

    // Load the client row.
    const loadUrl = `${SUPABASE_URL}/rest/v1/clients`
      + `?client_slug=eq.${enc(clientSlug)}&owner_user_id=eq.${enc(userId)}&select=*`;
    const loadResp = await fetch(loadUrl, { headers: sbHeaders(token) });
    const loadRows = await loadResp.json().catch(() => []);
    if (!loadResp.ok) { res.status(500).json({ error: (loadRows && loadRows.message) || 'Failed to load client' }); return; }
    const client = Array.isArray(loadRows) ? loadRows[0] : null;
    if (!client) { res.status(403).json({ error: 'No matching client for this account' }); return; }

    // Idempotent: already provisioned → return existing.
    if (client.vapi_phone_number_id && client.twilio_number) {
      res.status(200).json({ ok: true, already: true, number: client.twilio_number });
      return;
    }

    // 1) Create or update the assistant.
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
    }

    // 2) Create a Vapi-managed US number; attach the assistant for inbound calls.
    const numberPayload = { provider: 'vapi', assistantId, name: `${client.client_slug} line` };
    if (body.area_code) numberPayload.numberDesiredAreaCode = ('' + body.area_code).replace(/\D/g, '').slice(0, 3);
    if (client.forwarding_number) {
      numberPayload.fallbackDestination = { type: 'number', number: toE164(client.forwarding_number) };
    }
    const phone = await vapi('/phone-number', 'POST', numberPayload);

    // 3) Persist results so the setup page card displays the number.
    const saveUrl = `${SUPABASE_URL}/rest/v1/clients`
      + `?client_slug=eq.${enc(clientSlug)}&owner_user_id=eq.${enc(userId)}`;
    const saveResp = await fetch(saveUrl, {
      method: 'PATCH',
      headers: sbHeaders(token, { Prefer: 'return=representation' }),
      body: JSON.stringify({
        vapi_assistant_id: assistantId,
        vapi_phone_number_id: phone.id,
        twilio_number: phone.number,
      }),
    });
    if (!saveResp.ok) {
      const e = await saveResp.json().catch(() => ({}));
      res.status(500).json({ error: 'Provisioned in Vapi but failed to save: ' + ((e && e.message) || saveResp.status), number: phone.number });
      return;
    }

    res.status(200).json({ ok: true, number: phone.number, assistantId, phoneNumberId: phone.id });
  } catch (err) {
    console.error('provision error', err);
    res.status(500).json({ error: err?.message || 'Provisioning failed' });
  }
}
