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
//      numbers), NTFY_TOPIC (optional, for low-stock alerts), CLAUDE_MODEL (optional),
//      ANTHROPIC_API_KEY (optional — enables reading the client's website).

import { scanBusinessSite } from '../lib/site-scan.js';

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

// Starter voices (OpenAI — solid, low-cost). Used for the $49 Starter plan.
const VOICE_MAP = {
  warm_female:         { provider: 'openai', voiceId: 'shimmer' },
  professional_female: { provider: 'openai', voiceId: 'nova' },
  calm_male:           { provider: 'openai', voiceId: 'echo' },
  deep_male:           { provider: 'openai', voiceId: 'onyx' },
};
// Pro voices (ElevenLabs — more natural). Used for the $149 Pro plan.
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
  if (isPro) {
    const v = PRO_VOICE_MAP[style] || PRO_VOICE_MAP.professional_female;
    // Pro (ElevenLabs): tuned for a clear, natural, low-latency phone voice.
    // turbo_v2_5 = fast + crisp; stability/similarity keep it consistent and
    // human; speakerBoost sharpens clarity; streaming latency 3 keeps replies snappy.
    return {
      provider: '11labs',
      voiceId: v.voiceId,
      model: 'eleven_turbo_v2_5',
      stability: 0.55,
      similarityBoost: 0.8,
      style: 0.0,
      useSpeakerBoost: true,
      optimizeStreamingLatency: 3,
    };
  }
  // Starter (OpenAI): tts-1-hd is the higher-clarity model — noticeably cleaner
  // on a phone line than the standard tts-1.
  const v = VOICE_MAP[style] || VOICE_MAP.professional_female;
  return {
    provider: 'openai',
    voiceId: v.voiceId,
    model: 'tts-1-hd',
  };
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
  // Keep the call tight — aim to capture everything the owner needs in under 2 minutes.
  prompt += '\n\n# PACE — KEEP IT UNDER 2 MINUTES\n'
    + '- Move efficiently. Your goal is to get the caller\'s name, phone number, and reason for calling — plus the key intake details — in under 2 minutes.\n'
    + '- Do NOT repeat the caller\'s answers back word-for-word. A quick "got it" or "perfect" is enough before the next question.\n'
    + '- Ask only what you actually need. No small talk, no padding, no restating what they already told you.\n'
    + '- Confirm the callback number ONCE (read it back a single time to make sure it\'s right), then wrap up.\n'
    + '- As soon as you have their name, number, and what they need, thank them and end the call politely. Don\'t keep them on the line.';
  // Niche-specific intake playbook — makes the receptionist ask the questions a
  // real dispatcher in THIS trade would ask, and flag the true emergencies.
  const niche = buildNichePlaybook(c);
  if (niche) prompt += niche;
  // Facts pulled from the client's own website (see lib/site-scan.js). This is
  // usually far more complete than the few words they typed into onboarding.
  // It is explicitly ranked BELOW what they typed: if the site is stale and the
  // form is current, the form wins.
  if (c.site_facts) {
    prompt += '\n\n# FROM THEIR WEBSITE\n'
      + 'These facts were read from the business\'s own website. Use them to answer questions '
      + 'accurately. If anything here contradicts the details above, the details above win — '
      + 'a website can be out of date. Never invent anything that is not listed here.\n'
      + c.site_facts;
  }
  // How the assistant handles "can I talk to a person?".
  //
  // Two modes, decided per client at onboarding:
  //   transfer ON  — the client answered "yes" to live transfer AND gave us a
  //                  number. The AI gets a real transferCall tool (wired in
  //                  buildAssistantPayload) and may use it for TRUE emergencies
  //                  only. Everything else still becomes a captured lead.
  //   transfer OFF — the default. Capture the lead and promise a callback.
  //
  // NOTE: the callback number is deliberately NOT the client's main line. Their
  // main line is the one forwarded INTO this AI, so reading it back to a caller
  // would loop them straight back to the receptionist they're trying to escape.
  const callback = transferNumber(c);
  const canTransfer = wantsLiveTransfer(c);

  if (canTransfer) {
    prompt += '\n\n# IF THEY WANT A PERSON\n'
      + 'For a TRUE emergency, use the transferCall tool to connect them to a real person. '
      + 'Before you transfer, you MUST already have the caller\'s name, callback number, and '
      + 'what is wrong — if the transfer fails or nobody picks up, that information is the only '
      + 'thing we keep, so get it first. Say "Let me get someone on the line for you now — one moment." '
      + 'then transfer.\n'
      + 'A TRUE emergency is an immediate safety or property risk: gas smell, sparking or burning '
      + 'smell, flooding, no heat or no AC in dangerous weather, or someone locked out in the cold. '
      + 'Everything else — quotes, scheduling, billing, general questions, "I just want to talk to '
      + 'someone" — is NOT an emergency. For those, do NOT transfer: collect their name, number, and '
      + 'what they need, then say "Got it — I\'ll pass this along and someone will get back to you shortly."\n'
      + 'If a transfer does not connect, do not try again. Apologize once, confirm you have their '
      + 'details, and promise an urgent callback.';
  } else {
    prompt += '\n\n# IF THEY WANT A PERSON\n'
      + 'Do NOT say you are transferring them and do NOT attempt a live transfer. '
      + 'Instead, collect their name, phone number, and what they need, then say something like '
      + '"Got it — I\'ll pass this along and someone will get back to you shortly."';
    if (callback) {
      prompt += ' If the caller specifically asks for a number they can call to reach a person, '
        + 'give them this number: ' + callback + ' — just say it, do not try to connect them.';
    }
  }
  prompt += '\n\n# DISCLOSURE\n'
    + 'If the caller directly asks whether you are a person, tell them you are an AI assistant. '
    + 'Never claim or imply that you are a human.';
  return prompt;
}

// Niche intake playbook. Detects the trade from the client's business_type /
// services text and appends the specific triage questions and emergency flags a
// real dispatcher in that trade uses. This is what makes each receptionist feel
// purpose-built for the customer's industry instead of generic. Returns '' for
// trades we don't have a playbook for, so the base prompt still stands alone.
function buildNichePlaybook(c) {
  const hay = `${c.business_type || ''} ${c.services_offered || ''} ${c.business_name || ''}`.toLowerCase();
  const has = (...words) => words.some(w => hay.includes(w));

  if (has('hvac', 'heating', 'cooling', 'air condition', ' ac ', 'furnace')) {
    return '\n\n# HVAC INTAKE PLAYBOOK\n'
      + 'For every service caller, work these in naturally (one question at a time):\n'
      + '1. Is this about heating or cooling (or something else, like a new install or a quote)?\n'
      + '2. What is the system doing — no heat, no cool air, strange noise, leak, no power, or just a tune-up?\n'
      + '3. Is it their home or a business, and what is the property address?\n'
      + '4. How long has it been going on?\n'
      + '- Treat as an URGENT emergency to escalate right away: no heat when it is very cold, no cooling in extreme heat (especially with elderly, infants, or medical needs), a gas smell, or any burning smell. If they mention a GAS SMELL, tell them to leave the home and call their gas company or 911 first, then take their details.\n'
      + '- Always ask if they already have a system they want serviced or are looking to replace/install a new one — those go to different follow-ups.';
  }

  if (has('roof', 'shingle', 'gutter')) {
    return '\n\n# ROOFING INTAKE PLAYBOOK\n'
      + 'For every caller, work these in naturally (one question at a time):\n'
      + '1. Is this a repair, a full roof replacement, or a free quote/inspection?\n'
      + '2. Is there an ACTIVE LEAK or water coming into the home right now?\n'
      + '3. What type of roof is it (asphalt shingle, metal, tile, flat) if they know?\n'
      + '4. What is the property address, and is it a home or a business?\n'
      + '5. Was there recent storm, wind, or hail damage? (These are often insurance jobs — note it.)\n'
      + '- Treat as URGENT to escalate right away: an active leak, water entering the home, or storm damage that left the roof open. Reassure them help is being arranged and capture the address fast.';
  }

  if (has('plumb', 'drain', 'sewer', 'water heater')) {
    return '\n\n# PLUMBING INTAKE PLAYBOOK\n'
      + 'For every caller, work these in naturally (one question at a time):\n'
      + '1. What is happening — leak, clog/backup, no hot water, running/overflowing toilet, burst pipe, or a quote?\n'
      + '2. Is water actively leaking or flooding right now? If YES, ask if they can shut off the water at the main valve.\n'
      + '3. Is it their home or a business, and what is the property address?\n'
      + '4. Which fixture or area (kitchen, bathroom, water heater, main line)?\n'
      + '- Treat as URGENT to escalate right away: a burst pipe, active flooding, sewage backup, or no water to the whole property. Walk them to the shutoff valve first, then take their details.';
  }

  if (has('storage', 'self storage', 'self-storage')) {
    return '\n\n# SELF-STORAGE INTAKE PLAYBOOK\n'
      + 'Most callers want a unit or have a question about their existing one. Work these in naturally:\n'
      + '1. Are they looking to rent a new unit, or is this about a unit they already have?\n'
      + '2. If renting: what are they storing / roughly how much (a few boxes, a room, a house, a car/RV)? Use that to suggest a size.\n'
      + '3. When do they need it, and how long do they expect to need it?\n'
      + '4. If it is about an existing unit: get their name and unit number, and what they need (gate code, billing, access hours, move-out).\n'
      + '- Capture name and phone every time so the team can follow up with availability and pricing.';
  }

  return '';
}

// Fallback only — used when a client row has no stored ai_prompt.
function buildBasicPrompt(c) {
  const L = [];
  L.push(`You are the AI receptionist for ${c.business_name || 'this business'}, a ${c.business_type || 'local service'} company.`);
  if (c.ai_personality) L.push(`Your tone is ${c.ai_personality}.`);
  if (c.service_area) L.push(`Service area (where the business primarily works): ${c.service_area}. Never turn a caller away based on location — always take their details even if they seem outside this area, say the team will confirm they can help, and note the location. The owner decides which jobs to take.`);
  if (c.business_hours) L.push(`Business hours: ${c.business_hours}.`);
  if (c.services_offered) L.push(`Services and any pricing you may quote: ${c.services_offered}.`);
  // Only promise a transfer if the assistant actually has the tool to do it.
  if (c.transfer_destination && wantsLiveTransfer(c)) L.push(`Offer to transfer the caller to a human when: ${c.transfer_destination}.`);
  else if (c.transfer_destination) L.push(`Treat this as high priority and tell the caller you'll have someone call them right back when: ${c.transfer_destination}.`);
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

// The human's number we can actually ring. Deliberately excludes the client's
// main business line (clients.phone_number) — that line is forwarded INTO this
// assistant, so transferring to it would bounce the caller back to the AI.
function transferNumber(c) {
  return toE164(c.forwarding_number || '');
}

// Live transfer is opt-in AND needs a real number to dial. Both must be true,
// otherwise the assistant is never told it can transfer — which keeps the
// prompt honest instead of promising a connection that cannot happen.
function wantsLiveTransfer(c) {
  const v = c.offer_urgent_transfer;
  const optedIn = v === true || v === 'true' || v === 'yes' || v === 1;
  return optedIn && !!transferNumber(c);
}

// The complete Vapi assistant config for a client. Building this in one place
// means create and update always produce an identical, fully-wired assistant:
// model, voice, greeting, the call-report webhook, and — when the client opted
// in and gave us a number — a real transferCall tool for urgent calls.
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
    // Phone-tuned speech recognition. nova-2-phonecall is Deepgram's model built
    // for phone audio — it hears callers clearly the first time, which means
    // fewer "sorry, can you repeat that" moments and shorter calls.
    transcriber: { provider: 'deepgram', model: 'nova-2-phonecall', language: 'en-US' },
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
    // Ask Vapi to extract the key lead details from the conversation so the
    // summary email shows what the caller SAID (their name, the callback
    // number they gave) — not just raw caller-ID metadata.
    analysisPlan: {
      structuredDataPlan: {
        enabled: true,
        schema: {
          type: 'object',
          properties: {
            caller_name: { type: 'string', description: "The caller's full name exactly as they said it. Empty string if they never gave a name." },
            callback_number: { type: 'string', description: 'The best callback phone number the caller stated during the call (digits only, US 10-digit). Empty string if they did not give one.' },
            email: { type: 'string', description: 'Email address the caller provided, or empty string.' },
            service_requested: { type: 'string', description: 'The specific service or reason for the call in a few words, e.g. "Toilet installation".' },
            address: { type: 'string', description: 'The service address or location the caller gave, or empty string.' },
            urgency: { type: 'string', description: 'How urgent the request is: one of emergency, soon, flexible, or unknown.' },
          },
        },
      },
    },
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

  // ── Live transfer (opt-in, emergencies only) ──
  // Only wired when the client said yes AND we have a number to ring. The
  // matching prompt rules are in buildSystemPrompt — the two are gated on the
  // same wantsLiveTransfer() check so the AI is never told it can transfer
  // while lacking the tool, or handed the tool without rules for using it.
  //
  // The lead is still captured either way: end-of-call-report fires on
  // transferred calls too, and the prompt forces the AI to collect name +
  // number BEFORE dialling. So a transfer that rings out is a missed
  // connection, never a lost lead.
  const dial = transferNumber(client);
  if (wantsLiveTransfer(client)) {
    payload.model.tools = [
      {
        type: 'transferCall',
        destinations: [
          {
            type: 'number',
            number: dial,
            // Spoken to the CALLER as the transfer starts.
            message: "Let me get someone on the line for you now — one moment.",
            description: 'The business owner\'s direct line. Use ONLY for a true emergency '
              + '(gas smell, burning smell, flooding, no heat or AC in dangerous weather, '
              + 'someone locked out in the cold). Never for quotes, scheduling, or billing.',
          },
        ],
      },
    ];
  }

  return payload;
}

// Where the client's website URL lives. The onboarding form collects it, but it
// is stored on the client_onboarding row as info_link, not on the client itself
// — so fall back to looking it up by onboarding_id. Returns '' if there is none.
async function resolveClientWebsite(client, token) {
  const direct = String(client.website || client.info_link || '').trim();
  if (direct) return direct;
  if (!client.onboarding_id) return '';
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/client_onboarding?id=eq.${enc(client.onboarding_id)}&select=info_link&limit=1`,
      { headers: sbHeaders(token) }
    );
    if (!r.ok) return '';
    const rows = await r.json().catch(() => []);
    return String(rows?.[0]?.info_link || '').trim();
  } catch {
    return '';
  }
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

    // Payment gate: a signed-in user can only provision a number for an account
    // that has actually paid. (The internal post-payment path is already trusted,
    // so it skips this.) This stops anyone from pulling a number by visiting
    // /phone-setup without completing checkout.
    if (!isInternal) {
      const status = (client.status || '').toLowerCase();
      const payStatus = (client.payment_status || '').toLowerCase();
      const paid =
        client.active === true ||
        ['active', 'live', 'ready', 'paid', 'enabled', 'trialing'].includes(status) ||
        ['paid', 'active', 'trialing', 'completed'].includes(payStatus);
      if (!paid) {
        res.status(402).json({ error: 'This account does not have an active subscription yet.' });
        return;
      }
    }

    // 1) Build the full assistant config and create OR update it.
    //    IMPORTANT: we do this for EVERY provision call, even when the client
    //    already has a number — that's how existing assistants get the webhook
    //    URL, prompt, voice, and transfer settings refreshed. (The old code
    //    returned early here, which is why existing clients never got the
    //    server URL attached.)
    // 0) Read the client's website, if they gave one, and fold what it says into
    //    the prompt. Best-effort only: a dead site, a missing API key, or a slow
    //    page must never stop a customer going live, so failures are swallowed
    //    inside scanBusinessSite and simply produce no extra prompt text.
    try {
      const siteUrl = await resolveClientWebsite(client, token);
      if (siteUrl) {
        const facts = await scanBusinessSite(siteUrl, { businessName: client.business_name });
        if (facts) {
          client.site_facts = facts;
          console.log('[provision] website scanned for', clientSlug, '—', facts.length, 'chars of facts');
        } else {
          console.log('[provision] website scan produced nothing useful for', clientSlug);
        }
      }
    } catch (e) {
      console.log('[provision] website scan skipped:', e.message);
    }

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
      // SAFETY (prevents double-allocation): if this client already owns a pool
      // number — e.g. a previous attempt claimed one but failed before writing it
      // to the client row — REUSE that one instead of claiming a second number.
      const ownedResp = await fetch(`${SUPABASE_URL}/rest/v1/phone_pool?client_id=eq.${enc(client.id)}&select=*&limit=1`, { headers: sbHeaders(token) });
      const ownedRows = await ownedResp.json().catch(() => []);
      if (ownedResp.ok && Array.isArray(ownedRows) && ownedRows[0] && ownedRows[0].phone_number) {
        claimed = ownedRows[0];
        console.log('[provision] client already owns pool number', claimed.phone_number, '— reusing, not claiming another.');
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

    // INVARIANT: one client holds at most ONE pool number. If this client somehow
    // has extra pool rows assigned (from a duplicate/interrupted attempt), release
    // them back to the pool now — keep only the number we're actually using.
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/phone_pool?client_id=eq.${enc(client.id)}&phone_number=neq.${enc(claimedNumber)}`, {
        method: 'PATCH', headers: sbHeaders(token),
        body: JSON.stringify({ client_id: null, assigned_at: null, vapi_phone_number_id: null }),
      });
    } catch (e) { console.error('[provision] extra-number sweep failed:', e.message); }

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
    // Give the number back. Do NOT gate this on `token` — the internal
    // Starter auto-provision path has no token, and releaseNumber() uses the
    // service key anyway, so the old `&& token` guard silently leaked a pool
    // number out of inventory every time a Starter provision failed.
    if (claimedNumber) await releaseNumber(token, claimedNumber);
    res.status(500).json({ error: err?.message || 'Provisioning failed' });
  }
}
