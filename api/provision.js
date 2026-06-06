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

// Where Vapi should POST each finished call (the api/vapi/call-ended webhook).
// Override with PUBLIC_BASE_URL if your production domain ever changes.
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://aileadintel.com';
const CALL_WEBHOOK_URL = `${PUBLIC_BASE_URL}/api/vapi/call-ended`;
const VAPI_WEBHOOK_SECRET = process.env.VAPI_WEBHOOK_SECRET || '';

// Spoken to every caller at the very start of the call, and stated in the prompt.
// This is the recording + "you're talking to an AI" disclosure. Edit the wording
// freely. Recording-consent law varies by state (some require all parties consent),
// so confirm the wording for the states you operate in before relying on it.
const CALL_DISCLOSURE = "Just so you know, you're speaking with our AI virtual assistant, and this call may be transcribed for quality and follow-up.";

// Starter voices (OpenAI — solid, low-cost). Used for the $97 plan.
const VOICE_MAP = {
  warm_female:         { provider: 'openai', voiceId: 'shimmer' },
  professional_female: { provider: 'openai', voiceId: 'nova' },
  calm_male:           { provider: 'openai', voiceId: 'echo' },
  deep_male:           { provider: 'openai', voiceId: 'onyx' },
};
// Pro voices (ElevenLabs — more natural). Used for the $297 plan.
// NOTE: requires ElevenLabs to be connected in your Vapi account (provider key).
// These are ElevenLabs stock voice IDs; same style/gender mapping as Starter.
const PRO_VOICE_MAP = {
  warm_female:         { provider: '11labs', voiceId: 'EXAVITQu4vr4xnSDxMaL' }, // Sarah — warm female
  professional_female: { provider: '11labs', voiceId: '21m00Tcm4TlvDq8ikWAM' }, // Rachel — professional female
  calm_male:           { provider: '11labs', voiceId: 'TxGEqnHWrfWFTfGW9XjX' }, // Josh — calm male
  deep_male:           { provider: '11labs', voiceId: 'pNInz6obpgDQGcFmaJgB' }, // Adam — deep male
};
function pickVoice(client) {
  const style = client.voice_style || 'professional_female';
  const isPro = (client.plan || '').toLowerCase() === 'pro';
  if (isPro) return PRO_VOICE_MAP[style] || PRO_VOICE_MAP.professional_female;
  return VOICE_MAP[style] || VOICE_MAP.professional_female;
}

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

// The system prompt sent to Vapi. Prefer the detailed prompt that onboarding
// already built and stored in `ai_prompt` (it has the pricing ranges, the
// what-to-collect list, emergency handling, and the hard rules). Only fall back
// to a basic prompt if `ai_prompt` is somehow empty. Either way, the call
// disclosure is appended so the AI handles it consistently.
function buildSystemPrompt(c) {
  let prompt = (c.ai_prompt && c.ai_prompt.trim())
    ? c.ai_prompt.trim()
    : buildBasicPrompt(c);
  // Make every assistant fast and natural on a phone call.
  prompt += '\n\n# HOW TO SOUND\n'
    + '- Talk like a real receptionist, not a chatbot. Be warm, confident, and natural.\n'
    + '- Keep every reply short — one or two sentences. Answer first, then ask the next question.\n'
    + '- No filler, no long intros, no over-explaining. Get to the point.\n'
    + '- Use contractions and a relaxed, human rhythm. Never read long lists out loud.\n'
    + '- If you need a detail, ask one quick question at a time.';
  // How the assistant handles "can I talk to a person?" — capture their info
  // and promise a callback. Only if they specifically ask for a number to call
  // does it read out the business number. Never attempt a live transfer.
  const callback = String(c.forwarding_number || c.transfer_primary || c.business_phone || '').trim();
  prompt += '\n\n# IF THEY WANT A PERSON\n'
    + 'Do NOT say you are transferring them and do NOT attempt a live transfer. '
    + 'Instead, collect their name, phone number, and what they need, then say something like '
    + '"Got it — I\'ll pass this along and someone will get back to you shortly."';
  if (callback) {
    prompt += ' If the caller specifically asks for a number they can call to reach a person, '
      + 'give them this number: ' + callback + ' — just say it, do not try to connect them.';
  }
  prompt += '\n\n# DISCLOSURE\n'
    + 'If the caller directly asks whether you are a person, tell them you are an AI assistant. '
    + 'Never claim or imply that you are a human.';
  return prompt;
}

// Fallback only — used when a client row has no stored ai_prompt.
function buildBasicPrompt(c) {
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

// Digits-only E.164-ish normaliser for the owner's transfer cell.
function toE164(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d[0] === '1') return `+${d}`;
  if (String(raw).trim().startsWith('+')) return `+${d}`;
  return `+${d}`;
}

// The complete Vapi assistant config for a client. Building this in one place
// means create and update always produce an identical, fully-wired assistant:
// model, voice, greeting, the call-report webhook, and (if a cell is set) the
// ability to actually transfer urgent calls to the owner.
function buildAssistantPayload(client) {
  const voice = pickVoice(client);
  const sysPrompt = { role: 'system', content: buildSystemPrompt(client) };
  const model = CLAUDE_MODEL
    ? { provider: 'anthropic', model: CLAUDE_MODEL, messages: [sysPrompt] }
    : { provider: 'openai', model: 'gpt-4o', messages: [sysPrompt] };
  // The first message is whatever the client set as their greeting. The setup
  // page pre-fills it with a recording-disclosure version by default, but the
  // client can edit or remove that, so we use their greeting exactly as saved.
  const businessName = client.business_name || 'us';
  const firstMessage = client.caller_greeting
    || client.ai_greeting
    || `Thanks for calling ${businessName}. How can I help you today?`;

  const payload = {
    name: `${client.business_name || client.client_slug} receptionist`,
    firstMessage: firstMessage,
    model,
    voice,
    // No audio recordings — the product runs on transcripts + summaries only.
    // (Transcription is unaffected; this just stops Vapi storing call audio,
    // which we never use and which raises recording-consent questions in
    // all-party-consent states.)
    artifactPlan: { recordingEnabled: false, videoRecordingEnabled: false },
    // Report the finished call to our webhook so it lands on the dashboard.
    server: VAPI_WEBHOOK_SECRET
      ? { url: CALL_WEBHOOK_URL, secret: VAPI_WEBHOOK_SECRET }
      : { url: CALL_WEBHOOK_URL },
    serverMessages: ['end-of-call-report'],
    // ── Latency: make the AI respond faster ──
    // The default endpointing waits up to 1.5s after the caller stops talking
    // before the AI even begins. These settings cut that down so replies feel
    // snappy. Applies to every assistant built here.
    startSpeakingPlan: {
      // How long to wait after the caller stops before the AI speaks (default 0.4).
      waitSeconds: 0.3,
      // LiveKit = best natural end-of-turn detection for English calls.
      smartEndpointingPlan: { provider: 'livekit' },
      // Text-based fallback timings. onNoPunctuationSeconds (default 1.5) is the
      // big one — it's the long pause you hear when a caller trails off.
      transcriptionEndpointingPlan: {
        onPunctuationSeconds: 0.1,
        onNoPunctuationSeconds: 0.5,
        onNumberSeconds: 0.4,
      },
    },
    // No head-start delays — the AI starts forming its reply immediately.
    responseDelaySeconds: 0,
    llmRequestDelaySeconds: 0,
    // Be polite if a call runs long, and end cleanly.
    endCallMessage: 'Thanks for calling. Have a great day!',
    endCallFunctionEnabled: true,
  };

  // No live transfer. The AI captures the caller's info and tells them someone
  // will get back to them; if they specifically ask for a number, it reads out
  // the business's number (see buildSystemPrompt). Live transfer was removed
  // because it doesn't connect reliably.

  return payload;
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
  console.log('[provision] ===== VERSION 2026-06-03-faster-endpointing ===== method:', req.method);
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  let claimedNumber = null;
  let token = null;

  try {
    if (!VAPI_PRIVATE_KEY) { res.status(500).json({ error: 'Server is missing VAPI_PRIVATE_KEY' }); return; }

    // Two ways in:
    //  1) A logged-in user's Bearer token (the Pro /setup flow) — scoped to
    //     clients that user owns.
    //  2) An internal server-to-server call carrying x-internal-secret (the
    //     Starter auto-provision flow from onboarding-return / paypal-webhook).
    //     Looks the client up by slug alone and needs the service key.
    const internalSecret = process.env.SUPABASE_WEBHOOK_SECRET || '';
    const isInternal = !!internalSecret && req.headers['x-internal-secret'] === internalSecret;

    const authHeader = req.headers.authorization || '';
    token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    let userId = null;
    if (!isInternal) {
      if (!token) { res.status(401).json({ error: 'Missing authentication token' }); return; }
      const user = await getUser(token);
      if (!user || !user.id) { res.status(401).json({ error: 'Invalid or expired session' }); return; }
      userId = user.id;
    } else if (!SUPABASE_SERVICE_ROLE_KEY) {
      res.status(500).json({ error: 'Internal provisioning requires SUPABASE_SERVICE_KEY' });
      return;
    }
    const ownerFilter = isInternal ? '' : `&owner_user_id=eq.${enc(userId)}`;

    const body = await readJsonBody(req);
    const clientSlug = body.client_slug;
    if (!clientSlug) { res.status(400).json({ error: 'Missing client_slug' }); return; }

    // Load the client row.
    const loadResp = await fetch(
      `${SUPABASE_URL}/rest/v1/clients?client_slug=eq.${enc(clientSlug)}${ownerFilter}&select=*`,
      { headers: sbHeaders(token) }
    );
    const loadRows = await loadResp.json().catch(() => []);
    if (!loadResp.ok) { res.status(500).json({ error: (loadRows && loadRows.message) || 'Failed to load client' }); return; }
    const client = Array.isArray(loadRows) ? loadRows[0] : null;
    if (!client) { res.status(403).json({ error: 'No matching client for this account' }); return; }

    // 1) Build the full assistant config and create OR update it.
    //    IMPORTANT: we do this for EVERY provision call, even when the client
    //    already has a number — that's how existing assistants get the webhook
    //    URL, prompt, voice, and transfer settings refreshed. (The old code
    //    returned early here, which is why existing clients never got the
    //    server URL attached.)
    const assistantPayload = buildAssistantPayload(client);

    let assistantId = client.vapi_assistant_id;
    if (assistantId) {
      console.log('[provision] refreshing existing assistant', assistantId);
      await vapi(`/assistant/${assistantId}`, 'PATCH', assistantPayload);
    } else {
      console.log('[provision] creating new assistant for', clientSlug);
      const assistant = await vapi('/assistant', 'POST', assistantPayload);
      assistantId = assistant.id;
      await fetch(`${SUPABASE_URL}/rest/v1/clients?client_slug=eq.${enc(clientSlug)}${ownerFilter}`, {
        method: 'PATCH', headers: sbHeaders(token), body: JSON.stringify({ vapi_assistant_id: assistantId }),
      });
    }

    // Idempotent on the NUMBER only — but VERIFY against the pool first. A
    // client row can carry a leftover number from old tests; the pool is the
    // source of truth. If the pool doesn't credit them with this number, drop
    // it and claim properly below.
    if (client.vapi_phone_number_id && client.twilio_number) {
      const vr = await fetch(`${SUPABASE_URL}/rest/v1/phone_pool?phone_number=eq.${enc(client.twilio_number)}&select=client_id&limit=1`, { headers: sbHeaders(token) });
      const vrows = await vr.json().catch(() => []);
      const poolOwner = Array.isArray(vrows) && vrows[0] ? vrows[0].client_id : null;
      if (poolOwner === client.id) {
        console.log('[provision] client already has a number; assistant refreshed, skipping claim.');
        res.status(200).json({ ok: true, already: true, number: client.twilio_number, assistantId, refreshed: true });
        return;
      }
      console.warn('[provision] client row claims', client.twilio_number, 'but pool owner is', poolOwner, '— reclaiming properly.');
      client.twilio_number = null;
      client.vapi_phone_number_id = null;
    }

    // 2) Get this client a number. REUSE the one already on their row if any
    //    (covers a half-finished earlier provision), otherwise atomically
    //    claim a free one from the pool. This guarantees one client can never
    //    end up holding two pool numbers.
    let claimed = null;
    if (client.twilio_number) {
      const reuseResp = await fetch(`${SUPABASE_URL}/rest/v1/phone_pool?phone_number=eq.${enc(client.twilio_number)}&select=*&limit=1`, { headers: sbHeaders(token) });
      const reuseRows = await reuseResp.json().catch(() => []);
      const row = (reuseResp.ok && Array.isArray(reuseRows)) ? reuseRows[0] : null;
      // Reuse ONLY if the pool says this number is free or already theirs —
      // never take a number that belongs to another client.
      if (row && (!row.client_id || row.client_id === client.id)) {
        const lockResp = await fetch(
          `${SUPABASE_URL}/rest/v1/phone_pool?id=eq.${enc(row.id)}&or=(client_id.is.null,client_id.eq.${enc(client.id)})`,
          {
            method: 'PATCH', headers: sbHeaders(token, { Prefer: 'return=representation' }),
            body: JSON.stringify({ client_id: client.id, assigned_at: new Date().toISOString() }),
          }
        );
        const lockRows = await lockResp.json().catch(() => []);
        if (lockResp.ok && Array.isArray(lockRows) && lockRows[0]) {
          claimed = lockRows[0];
          console.log('[provision] reusing existing number', claimed.phone_number);
        }
      }
    }
    if (!claimed) {
      const claimResp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/claim_phone_number`, {
        method: 'POST', headers: sbHeaders(token), body: JSON.stringify({ p_client_id: client.id }),
      });
      const claimRows = await claimResp.json().catch(() => []);
      if (!claimResp.ok) { res.status(500).json({ error: (claimRows && claimRows.message) || 'Claim failed' }); return; }
      claimed = Array.isArray(claimRows) ? claimRows[0] : claimRows;
      if (!claimed || !claimed.phone_number) {
        await notify('AI Lead Intel: phone number pool is EMPTY — a client could not be provisioned. Buy more numbers.');
        res.status(409).json({ error: 'No phone numbers available in the pool. Add more numbers.' });
        return;
      }
    }
    claimedNumber = claimed.phone_number;

    // 3) Attach the assistant to that number (import from Twilio first if needed).
    let vapiPhoneId = claimed.vapi_phone_number_id;
    if (vapiPhoneId) {
      try {
        await vapi(`/phone-number/${vapiPhoneId}`, 'PATCH', { assistantId });
      } catch (e) {
        // Stale ID — the Vapi import was deleted by a past cancel. Re-import fresh.
        console.warn('[provision] stale vapi phone id, re-importing:', e.message);
        vapiPhoneId = null;
      }
    }
    if (!vapiPhoneId) {
      if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
        throw new Error(`Number ${claimedNumber} is not in Vapi and Twilio credentials are missing to import it.`);
      }
      let imported;
      try {
        imported = await vapi('/phone-number', 'POST', {
          provider: 'twilio',
          number: claimedNumber,
          twilioAccountSid: TWILIO_ACCOUNT_SID,
          twilioAuthToken: TWILIO_AUTH_TOKEN,
          assistantId,
        });
      } catch (e) {
        // The number may already be imported in Vapi without us knowing its id
        // (e.g. the pool record was wiped). Look it up by number and reuse it.
        console.warn('[provision] import failed, looking up existing Vapi import:', e.message);
        const all = await vapi('/phone-number', 'GET');
        const found = Array.isArray(all) ? all.find(p => p && p.number === claimedNumber) : null;
        if (!found) throw e;
        imported = found;
        await vapi(`/phone-number/${found.id}`, 'PATCH', { assistantId });
      }
      vapiPhoneId = imported.id;
      await fetch(`${SUPABASE_URL}/rest/v1/phone_pool?phone_number=eq.${enc(claimedNumber)}`, {
        method: 'PATCH', headers: sbHeaders(token), body: JSON.stringify({ vapi_phone_number_id: vapiPhoneId }),
      });
    }

    // 4) Save to the client + mark ready (fires your webhook → email + dashboard live).
    const saveResp = await fetch(`${SUPABASE_URL}/rest/v1/clients?client_slug=eq.${enc(clientSlug)}${ownerFilter}`, {
      method: 'PATCH', headers: sbHeaders(token, { Prefer: 'return=representation' }),
      body: JSON.stringify({
        vapi_assistant_id: assistantId,
        vapi_phone_number_id: vapiPhoneId,
        twilio_number: claimedNumber,
        ai_setup_status: 'ready',
        // The AI is live as of this moment — reflect that on the account so
        // dashboards open straight into the active state, no manual flipping.
        status: 'active',
        active: true,
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
