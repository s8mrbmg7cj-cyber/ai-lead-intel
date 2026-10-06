// Node 3 of 3 — Compose the owner alert, the CRM record, and the audit row.
//
// The alert is written for a lock screen, not an inbox. The first line has to
// survive being truncated to ~55 characters by the notification, so the tier,
// the score and the name go first and nothing else competes for that space.
// The phone number is left bare on its own line so the OS linkifies it and the
// owner can dial by tapping once.

const SMS_SEGMENT = 160;
const MAX_SEGMENTS = 2;           // 320 chars. Past this, carriers split and bill extra.

function humanMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'n/a';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function segments(text) {
  return Math.max(1, Math.ceil(String(text).length / SMS_SEGMENT));
}

function composeAlert(lead, q) {
  const head = `${q.tier}-LEAD ${q.score} ${lead.name || 'No name given'}`;

  const lines = [head];
  if (q.summary) lines.push(q.summary);
  if (lead.phone) lines.push(lead.phone);

  const meta = [lead.service, lead.city, lead.source].filter(Boolean).join(' | ');
  if (meta) lines.push(meta);

  if (q.next_question) lines.push(`Ask: ${q.next_question}`);
  if (q.red_flags?.length) lines.push(`Flag: ${q.red_flags.join('; ')}`);
  if (q.source !== 'ai') lines.push(`[scored by ${q.source}]`);

  let text = lines.join('\n');

  // Trim from the least important line up until it fits two segments. Never
  // truncate the head or the phone number — those are the whole point.
  const protectedCount = lead.phone ? 3 : 2;
  while (segments(text) > MAX_SEGMENTS && lines.length > protectedCount) {
    lines.splice(protectedCount, 1);
    text = lines.join('\n');
  }
  if (segments(text) > MAX_SEGMENTS) {
    text = text.slice(0, SMS_SEGMENT * MAX_SEGMENTS - 1) + '\u2026';
  }

  return text;
}

// WhatsApp is not SMS wearing a different logo. A Cloud API text message holds
// 4096 characters, so the context that composeAlert is forced to throw away to
// fit two segments can stay. That is the entire reason this is a separate
// function rather than a flag on the one above: the SMS alert is shaped by a
// billing limit, and repeating that limit where it does not apply would be
// cargo cult.
const WA_MAX = 4096;

function composeWhatsapp(lead, q) {
  const lines = [`*${q.tier}-LEAD ${q.score}* — ${lead.name || 'No name given'}`];
  if (q.summary) lines.push('', q.summary);

  const facts = [
    lead.phone && `Phone: ${lead.phone}`,
    lead.email && `Email: ${lead.email}`,
    lead.service && `Service: ${lead.service}`,
    lead.city && `Area: ${lead.city}`,
    `Source: ${lead.source}`,
  ].filter(Boolean);
  lines.push('', ...facts);

  // These three are the first casualties in the SMS. Here they survive, which
  // is the whole point of having the channel.
  if (q.intent) lines.push('', `Intent: ${q.intent}`);
  if (q.urgency) lines.push(`Urgency: ${q.urgency}`);
  if (q.next_question) lines.push('', `*Ask first:* ${q.next_question}`);
  if (q.red_flags?.length) lines.push('', `*Flags:* ${q.red_flags.join('; ')}`);
  if (q.source !== 'ai') lines.push('', `_[scored by ${q.source}]_`);

  const text = lines.join('\n');
  return text.length <= WA_MAX ? text : text.slice(0, WA_MAX - 1) + '\u2026';
}

// Meta Cloud API free-form text. Note this only delivers inside the 24-hour
// customer service window; outside it Meta requires an approved template, which
// is a provisioning decision and not something code can paper over.
function composeWhatsappPayload(lead, q, to) {
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: String(to || '').replace(/^\+/, ''),   // Cloud API wants digits, no plus
    type: 'text',
    text: { preview_url: false, body: composeWhatsapp(lead, q) },
  };
}

function composeCrm(lead, q, locationId) {
  const parts = (lead.name || '').split(/\s+/).filter(Boolean);
  return {
    locationId: locationId || '',
    firstName: parts[0] || '',
    lastName: parts.slice(1).join(' '),
    name: lead.name || '',
    email: lead.email || undefined,
    phone: lead.phone || undefined,
    source: lead.source,
    tags: [
      'ai-qualified',
      `tier-${q.tier.toLowerCase()}`,
      lead.source,
      q.source === 'ai' ? 'scored-ai' : 'scored-rules',
    ].filter(Boolean),
    customFields: [
      { key: 'lead_score', field_value: String(q.score) },
      { key: 'lead_summary', field_value: q.summary },
      { key: 'lead_intent', field_value: q.intent || '' },
      { key: 'lead_urgency', field_value: q.urgency || '' },
    ],
  };
}

function compose(lead, q, opts = {}) {
  const now = opts.now ?? Date.now();
  const latency_ms = Number.isFinite(lead.t0) ? now - lead.t0 : null;
  const alert = composeAlert(lead, q);

  return {
    tier: q.tier,
    score: q.score,
    // Only an A pages the owner immediately. B and C land in the CRM and the
    // daily digest, which is the difference between a useful alert and one the
    // owner learns to ignore.
    notify_now: q.tier === 'A',
    alert_text: alert,
    alert_segments: segments(alert),
    whatsapp: composeWhatsappPayload(lead, q, opts.ownerPhone),
    crm: composeCrm(lead, q, opts.locationId),
    audit: {
      received_at: lead.received_at,
      name: lead.name,
      phone: lead.phone,
      email: lead.email,
      source: lead.source,
      service: lead.service,
      score: q.score,
      tier: q.tier,
      scored_by: q.source,
      rule_score: q.rule_score,
      problems: (q.problems || []).join('; '),
      latency_ms,
      latency_human: humanMs(latency_ms),
      dedupe_key: lead.dedupe_key,
    },
  };
}

export { compose, composeAlert, composeWhatsapp, composeWhatsappPayload, composeCrm,
         segments, humanMs, SMS_SEGMENT, MAX_SEGMENTS, WA_MAX };
