// Node 2 of 3 — Qualify.
//
// Takes whatever the model returned (or whatever the API error was) and always
// produces a usable qualification. The AI is allowed to fail; the lead is not
// allowed to disappear. If the model is down, rate-limited, or returns garbage,
// `ruleScore` answers instead and `source` says so out loud.
//
// Two deliberate choices:
//   1. The tier is ALWAYS recomputed from the score here. The model's own tier
//      field is ignored even when present — a score and a tier that agree today
//      are not a guarantee they agree tomorrow.
//   2. The model never computes a number we depend on for routing. It writes
//      the sentence a human reads; the score it proposes is clamped and bounded
//      by the rule engine.

const TIER_A_MIN = 70;
const TIER_B_MIN = 40;

function tierFor(score) {
  if (score >= TIER_A_MIN) return 'A';
  if (score >= TIER_B_MIN) return 'B';
  return 'C';
}

// Deterministic scorer. Runs on every lead, used alone when the AI is unusable,
// and used as a sanity bound when the AI is usable.
function ruleScore(lead) {
  const reasons = [];
  let s = 20;

  if (lead.phone) { s += 25; reasons.push('reachable by phone'); }
  if (lead.email) { s += 10; reasons.push('email present'); }
  if (lead.service) { s += 10; reasons.push('named a service'); }

  const msg = String(lead.message || '');
  const words = msg.split(/\s+/).filter(Boolean).length;
  if (words >= 15) { s += 15; reasons.push('detailed message'); }
  else if (words >= 5) { s += 8; reasons.push('some detail'); }

  const urgent = /\b(asap|today|tonight|tomorrow|urgent|emergency|right away|no heat|no hot water|no a\/?c|not working|stopped working|broken|leak|leaking|flood)/i;
  if (urgent.test(msg)) { s += 20; reasons.push('urgency language'); }

  const shopping = /\b(just looking|just curious|just browsing|how much (is|does|would)|ballpark|price range|price list|quote only|not ready|window shopping)\b/i;
  if (shopping.test(msg)) { s -= 15; reasons.push('price-shopping language'); }

  const spam = /\b(seo services|rank your (site|website)|increase your traffic|guest post|backlink|crypto|loan offer|bitcoin|investment opportunity)\b/i;
  const junkName = /^(test|asdf|qwerty|aaa+|xxx+|n\/?a)$/i;
  if (spam.test(msg) || junkName.test(String(lead.name || '').trim())) {
    s = Math.min(s, 10);
    reasons.push('matches spam/test pattern');
  }

  // Capped at 95, not 100. The weights above happen to sum to exactly 100 on a
  // good lead, and a rules-only score of "100" reads like certainty the rule
  // engine does not have — it has seen a phone number and some keywords. 95
  // leaves the top of the range for a qualification that actually read the text.
  s = Math.max(0, Math.min(95, Math.round(s)));
  return { score: s, tier: tierFor(s), reasons };
}

// Pull the first JSON object out of model output that may be fenced, prefixed,
// or (because we prefill the assistant turn with "{") missing its opening brace.
function extractJson(text) {
  if (typeof text !== 'string' || text.trim() === '') return null;
  let t = text.trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  if (!t.startsWith('{')) {
    const i = t.indexOf('{');
    if (i === -1) t = '{' + t;        // assistant prefill case
    else t = t.slice(i);
  }
  const end = t.lastIndexOf('}');
  if (end !== -1) t = t.slice(0, end + 1);
  try { return JSON.parse(t); } catch { return null; }
}

function clip(text, max) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).trim() + '\u2026';
}

// `aiText` is the model's text, or '' / null when the API call failed.
function qualify(lead, aiText, apiError) {
  const fb = ruleScore(lead);
  const parsed = extractJson(aiText);

  const problems = [];
  if (apiError) problems.push(`api: ${String(apiError).slice(0, 120)}`);
  if (!parsed) problems.push(aiText ? 'model output was not valid JSON' : 'no model output');

  let score = fb.score;
  let summary = '';
  let intent = '';
  let urgency = '';
  let next_question = '';
  let red_flags = [];
  let source = 'fallback';

  if (parsed) {
    const n = Number(parsed.score);
    const hasScore = Number.isFinite(n);
    if (!hasScore) problems.push('model score missing or not a number');

    summary = clip(parsed.summary_for_owner ?? parsed.summary, 200);
    intent = clip(parsed.intent, 60);
    urgency = clip(parsed.urgency, 24);
    next_question = clip(parsed.first_question ?? parsed.suggested_first_question, 120);
    red_flags = Array.isArray(parsed.red_flags)
      ? parsed.red_flags.map((r) => clip(r, 60)).filter(Boolean).slice(0, 4)
      : [];

    if (!summary) problems.push('model summary was empty');

    // Accept the model's score only if it is a real number AND within 25 points
    // of the rule engine. A wild disagreement means one of them misread the
    // lead, and we are not betting the owner's phone on which.
    if (hasScore && summary) {
      const clamped = Math.max(0, Math.min(100, Math.round(n)));
      if (Math.abs(clamped - fb.score) <= 25) {
        score = clamped;
        source = 'ai';
      } else {
        score = Math.round((clamped + fb.score) / 2);
        source = 'ai+rules(disagreed)';
        problems.push(`model score ${clamped} vs rules ${fb.score} — averaged`);
      }
    }
  }

  if (!summary) {
    const bits = [
      lead.service || 'enquiry',
      lead.message ? clip(lead.message, 90) : null,
      lead.city || null,
    ].filter(Boolean);
    summary = clip(bits.join(' \u2014 '), 200);
  }

  return {
    score,
    tier: tierFor(score),            // never trust a model-supplied tier
    summary,
    intent,
    urgency,
    next_question,
    red_flags,
    source,                          // 'ai' | 'ai+rules(disagreed)' | 'fallback'
    rule_score: fb.score,
    rule_reasons: fb.reasons,
    problems,                        // empty means the AI path ran clean
  };
}

export { qualify, ruleScore, tierFor, extractJson, clip, TIER_A_MIN, TIER_B_MIN };
