#!/usr/bin/env node
// Verify the three Code nodes against fixtures, then mutation-test the guards.
//
// Why this file exists: the n8n Code nodes are not reachable by any test
// runner, and the AI step needs a paid key. So the logic lives in src/*.js as
// pure functions, build.mjs injects those exact strings into the workflow, and
// this harness exercises them. A passing run here is a statement about the code
// that actually ships in the workflow, not about a copy of it.
//
// Run:  node verify.mjs
//       node verify.mjs --mutate   (also prove the guards are load-bearing)

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { normalizeLead } from './src/normalize.js';
import { qualify, ruleScore } from './src/qualify.js';
import { compose, composeWhatsapp, segments, MAX_SEGMENTS, SMS_SEGMENT, WA_MAX } from './src/compose.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = JSON.parse(readFileSync(join(HERE, 'fixtures.json'), 'utf8'));

let pass = 0;
const fails = [];

function check(label, cond, detail = '') {
  if (cond) { pass++; return true; }
  fails.push(`${label}${detail ? ' — ' + detail : ''}`);
  return false;
}

// ---------------------------------------------------------------- normalize
console.log('\n== normalize (%d leads)', FIX.leads.length);
const normalized = {};
for (const f of FIX.leads) {
  const r = normalizeLead(f.payload);
  normalized[f.id] = r;
  const e = f.expect;

  check(`[${f.id}] valid=${e.valid}`, r.valid === e.valid, `got ${r.valid} errors=${JSON.stringify(r.errors)}`);
  if (e.phone) check(`[${f.id}] phone E.164`, r.lead.phone === e.phone, `got "${r.lead.phone}" want "${e.phone}"`);
  if (e.source) check(`[${f.id}] source`, r.lead.source === e.source, `got "${r.lead.source}"`);
  if (e.errors_include) {
    check(`[${f.id}] error mentions "${e.errors_include}"`,
      r.errors.some((x) => x.includes(e.errors_include)), JSON.stringify(r.errors));
  }
  if (e.warnings_include) {
    check(`[${f.id}] warning "${e.warnings_include}"`,
      r.warnings.includes(e.warnings_include), JSON.stringify(r.warnings));
  }
  const rs = ruleScore(r.lead).score;
  if (e.min_rule_score !== undefined) check(`[${f.id}] rule score >= ${e.min_rule_score}`, rs >= e.min_rule_score, `got ${rs}`);
  if (e.max_rule_score !== undefined) check(`[${f.id}] rule score <= ${e.max_rule_score}`, rs <= e.max_rule_score, `got ${rs}`);

  console.log(`   ${f.id.padEnd(18)} valid=${String(r.valid).padEnd(5)} rules=${String(rs).padStart(3)} ` +
    `tier=${ruleScore(r.lead).tier} phone=${r.lead.phone || '-'}`);
}

// A lead must never be dropped for anything except being unreachable.
for (const f of FIX.leads) {
  const r = normalized[f.id];
  if (!r.valid) {
    check(`[${f.id}] only fatal reason is unreachability`,
      r.errors.length === 1 && r.errors[0].startsWith('unreachable'), JSON.stringify(r.errors));
  }
}

// ------------------------------------------------------------------ qualify
console.log('\n== qualify (%d model responses, against the emergency lead)', FIX.ai_responses.length);
const baseLead = normalized['meta-emergency'].lead;
for (const r of FIX.ai_responses) {
  const q = qualify(baseLead, r.text, r.api_error);
  const e = r.expect;

  if (e.source) check(`[${r.id}] source=${e.source}`, q.source === e.source, `got "${q.source}" problems=${JSON.stringify(q.problems)}`);
  if (e.score !== undefined) check(`[${r.id}] score=${e.score}`, q.score === e.score, `got ${q.score}`);
  if (e.score_max !== undefined) check(`[${r.id}] score <= ${e.score_max}`, q.score <= e.score_max, `got ${q.score}`);
  if (e.tier) check(`[${r.id}] tier=${e.tier}`, q.tier === e.tier, `got ${q.tier}`);
  if (e.tier_not) check(`[${r.id}] tier is NOT ${e.tier_not}`, q.tier !== e.tier_not, `got ${q.tier}`);
  if (e.problems === 0) check(`[${r.id}] clean run, no problems`, q.problems.length === 0, JSON.stringify(q.problems));
  if (e.problems_min) check(`[${r.id}] >=${e.problems_min} problem(s) recorded`, q.problems.length >= e.problems_min, JSON.stringify(q.problems));
  if (e.summary_nonempty) check(`[${r.id}] summary still non-empty`, q.summary.trim().length > 0);

  // Invariants that must hold for EVERY response, good or garbage.
  check(`[${r.id}] score in 0..100`, q.score >= 0 && q.score <= 100, `got ${q.score}`);
  check(`[${r.id}] tier in A/B/C`, ['A', 'B', 'C'].includes(q.tier), `got ${q.tier}`);
  check(`[${r.id}] summary <= 200 chars`, q.summary.length <= 200, `got ${q.summary.length}`);
  check(`[${r.id}] always returns a summary`, q.summary.trim().length > 0);

  console.log(`   ${r.id.padEnd(20)} score=${String(q.score).padStart(3)} tier=${q.tier} by=${q.source.padEnd(20)} problems=${q.problems.length}`);
}

// A 5,000-character summary from the model must not reach the SMS.
{
  const flood = JSON.stringify({
    score: 75, intent: 'x', urgency: 'emergency',
    summary_for_owner: 'word '.repeat(1000),
    first_question: 'q '.repeat(500), red_flags: ['f '.repeat(200)],
  });
  const q = qualify(baseLead, flood);
  check('[flood] summary clipped to 200', q.summary.length <= 200, `got ${q.summary.length}`);
  check('[flood] question clipped to 120', q.next_question.length <= 120, `got ${q.next_question.length}`);
  check('[flood] red flags capped at 4', q.red_flags.length <= 4, `got ${q.red_flags.length}`);
}

// ------------------------------------------------------------- email accepted
// Every address below is one a real person could type into a contact form. A
// rejected email is not a cosmetic warning: if it is the only contact field,
// the lead is marked unreachable and nobody ever calls them. The first four
// cases are the ones the original pattern got wrong — it forbade dots inside
// the domain, so every UK business and every subdomain address was dropped.
console.log('\n== email validation');
{
  const accept = [
    'dana@company.co.uk',
    'dana@mail.company.com',
    'bartholomew.fitzgerald.montgomery@averylongcompanyname.example.com',
    'first.last@sub.domain.org.au',
    'dana@company.com',
    'dana+hvac@gmail.com',
    "o'brien@plumbing-co.net",
  ];
  const reject = [
    'not-an-email',
    'dana@',
    '@company.com',
    'dana@.com',
    'dana@company',
    'dana company.com',
    'dana@comp any.com',
  ];
  for (const e of accept) {
    const r = normalizeLead({ email: e });
    check(`accepts ${e}`, r.lead.email === e.toLowerCase(), r.warnings.join('; '));
  }
  for (const e of reject) {
    const r = normalizeLead({ email: e });
    check(`rejects ${e}`, r.lead.email === '', `kept it as "${r.lead.email}"`);
  }
  // The consequence, stated as an assertion rather than a comment.
  check('a .co.uk address alone is reachable',
    normalizeLead({ email: 'dana@company.co.uk' }).valid === true);
}

// ------------------------------------------------------------------ compose
console.log('\n== compose');
for (const f of FIX.leads) {
  const r = normalized[f.id];
  if (!r.valid) continue;
  const q = qualify(r.lead, FIX.ai_responses[0].text);
  const c = compose(r.lead, q, { now: r.lead.t0 + 8240, locationId: 'loc_DEMO' });

  check(`[${f.id}] alert <= ${MAX_SEGMENTS} SMS segments`, c.alert_segments <= MAX_SEGMENTS,
    `${c.alert_text.length} chars = ${c.alert_segments} segments`);
  check(`[${f.id}] alert opens with tier and score`, /^[ABC]-LEAD \d{1,3}/.test(c.alert_text), c.alert_text.split('\n')[0]);
  if (r.lead.phone) {
    check(`[${f.id}] phone is on its own line (tap to dial)`,
      c.alert_text.split('\n').includes(r.lead.phone), c.alert_text);
  }
  check(`[${f.id}] only tier A pages the owner`, c.notify_now === (c.tier === 'A'));
  check(`[${f.id}] latency recorded`, c.audit.latency_ms === 8240 && c.audit.latency_human === '8.2s', c.audit.latency_human);
  check(`[${f.id}] crm tags include tier`, c.crm.tags.includes(`tier-${c.tier.toLowerCase()}`), JSON.stringify(c.crm.tags));
  check(`[${f.id}] no phone/email invented`,
    (c.crm.phone ?? '') === r.lead.phone && (c.crm.email ?? '') === r.lead.email);
}

// The worst case for the SMS budget: everything present and maximal.
{
  const monster = normalizeLead({
    full_name: 'Bartholomew Fitzgerald-Montgomery III',
    phone: '+1 810 555 0147',
    email: 'bartholomew.fitzgerald.montgomery@averylongcompanyname.example.com',
    city: 'Grand Blanc Township',
    service: 'Complete furnace and air conditioning system replacement',
    message: 'x'.repeat(2000),
  });
  const q = qualify(monster.lead, JSON.stringify({
    score: 95, intent: 'full system replacement', urgency: 'this week',
    summary_for_owner: 'S'.repeat(199),
    first_question: 'Q'.repeat(119),
    red_flags: ['flag one', 'flag two', 'flag three', 'flag four'],
  }));
  const c = compose(monster.lead, q, { now: monster.lead.t0 + 500 });
  check('[monster] alert still <= 320 chars', c.alert_text.length <= SMS_SEGMENT * MAX_SEGMENTS,
    `${c.alert_text.length} chars`);
  // Assert the SHAPE of the head line, not the score — the score here is the
  // product of a disagreement between the model and the rule engine, and
  // pinning it would make this test fail every time a weight is tuned.
  check('[monster] head survived trimming', /^A-LEAD \d{1,3} Bartholomew/.test(c.alert_text), c.alert_text.split('\n')[0]);
  check('[monster] phone survived trimming', c.alert_text.includes('+18105550147'));
  console.log(`   monster alert: ${c.alert_text.length} chars / ${c.alert_segments} segment(s)`);

  // Same monster lead, WhatsApp channel. The point of the separate function is
  // that the detail the SMS had to drop is still here, so test exactly that —
  // otherwise the second channel is just the first one with extra steps.
  const w = composeWhatsapp(monster.lead, q);
  check('[monster/wa] fits the Cloud API limit', w.length <= WA_MAX, `${w.length} chars`);
  check('[monster/wa] keeps the question the SMS dropped',
    w.includes('Ask first:') && !c.alert_text.includes('Ask:'), 'SMS kept it, so this proves nothing');
  check('[monster/wa] keeps the email the SMS never had room for',
    w.includes(monster.lead.email) && !c.alert_text.includes(monster.lead.email));
  check('[monster/wa] keeps intent and urgency', w.includes('Intent:') && w.includes('Urgency:'));
  console.log(`   whatsapp alert: ${w.length} chars (vs ${c.alert_text.length} for SMS)`);
}

// The Cloud API rejects a leading "+" on the recipient, and silently enough that
// it is worth a test rather than a comment.
{
  const r = normalized['meta-emergency'];
  const q = qualify(r.lead, FIX.ai_responses[0].text);
  const c = compose(r.lead, q, { now: r.lead.t0 + 100, ownerPhone: '+19995551234' });
  check('[wa] recipient has no leading +', c.whatsapp.to === '19995551234', c.whatsapp.to);
  check('[wa] payload shape is Cloud API text',
    c.whatsapp.messaging_product === 'whatsapp' && c.whatsapp.type === 'text'
      && typeof c.whatsapp.text.body === 'string' && c.whatsapp.text.body.length > 0);
  check('[wa] link preview off', c.whatsapp.text.preview_url === false);
  check('[wa] fallback is announced on this channel too',
    composeWhatsapp(r.lead, { ...q, source: 'fallback' }).includes('[scored by fallback]'));
}

// ------------------------------------------------------------- mutation test
// A guard that no test can break is a guard no test is checking. Each mutation
// below breaks one protection on purpose; the suite above MUST notice.
async function mutate() {
  console.log('\n== mutation tests (each one SHOULD be caught)');
  const dir = mkdtempSync(join(tmpdir(), 'leadpipe-'));
  const source = {};
  const readSrc = (f) => (source[f] ??= readFileSync(join(HERE, 'src', f), 'utf8'));

  const mutations = [
    {
      // The bug this guards against actually shipped: the domain half of the
      // pattern forbade dots, so "@company.co.uk" was rejected and an
      // email-only UK lead came out the far end marked unreachable.
      file: 'normalize.js',
      name: 'forbid dots inside the email domain (the original bug)',
      find: 'const emailOk = /^[^@\\s]+@([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+[a-z]{2,}$/i.test(emailRaw);',
      repl: 'const emailOk = /^[^@\\s]+@[^@\\s.]+\\.[a-z]{2,}$/i.test(emailRaw);',
      probe: async (m) => {
        const r = m.normalizeLead({ email: 'dana@company.co.uk' });
        return r.lead.email === '' && r.valid === false;   // caught: lead lost
      },
    },
    {
      name: 'trust the model tier instead of recomputing it',
      find: "tier: tierFor(score),            // never trust a model-supplied tier",
      repl: "tier: (parsed && parsed.tier) || tierFor(score),",
      probe: async (m) => {
        const q = m.qualify(baseLead, FIX.ai_responses.find((r) => r.id === 'lying-tier').text);
        return q.tier === 'A';                 // caught if the fake tier gets through
      },
    },
    {
      name: 'drop the 0..100 clamp on the model score',
      find: 'const clamped = Math.max(0, Math.min(100, Math.round(n)));',
      repl: 'const clamped = Math.round(n);',
      probe: async (m) => {
        const q = m.qualify(baseLead, FIX.ai_responses.find((r) => r.id === 'out-of-range-score').text);
        return q.score > 100;
      },
    },
    {
      name: 'accept any model score, however far from the rule engine',
      find: 'if (Math.abs(clamped - fb.score) <= 25) {',
      repl: 'if (true) {',
      probe: async (m) => {
        const q = m.qualify(baseLead, FIX.ai_responses.find((r) => r.id === 'wild-disagreement').text);
        return q.source === 'ai' && q.score <= 10;
      },
    },
    {
      name: 'stop clipping the summary',
      find: 'summary = clip(parsed.summary_for_owner ?? parsed.summary, 200);',
      repl: 'summary = String(parsed.summary_for_owner ?? parsed.summary ?? "");',
      probe: async (m) => {
        const q = m.qualify(baseLead, JSON.stringify({
          score: 75, intent: 'x', urgency: 'emergency',
          summary_for_owner: 'word '.repeat(1000), first_question: 'q', red_flags: [],
        }));
        return q.summary.length > 200;
      },
    },
  ];

  let caught = 0;
  for (const [i, mut] of mutations.entries()) {
    const from = mut.file ?? 'qualify.js';
    const src = readSrc(from);
    if (!src.includes(mut.find)) {
      fails.push(`mutation ${i + 1} could not be applied — source changed, test is stale: "${mut.find.slice(0, 50)}"`);
      console.log(`   ${i + 1}. ${mut.name}\n      STALE: anchor not found in src/${from}`);
      continue;
    }
    const file = join(dir, `mut-${i}-${from.replace('.js', '')}.mjs`);
    writeFileSync(file, src.replace(mut.find, mut.repl));
    const m = await import(pathToFileURL(file).href);
    const broken = await mut.probe(m);
    if (broken) {
      caught++;
      console.log(`   ${i + 1}. ${mut.name}\n      caught: behaviour changed when the guard was removed`);
    } else {
      fails.push(`mutation NOT caught: ${mut.name} — the guard is not actually doing anything`);
      console.log(`   ${i + 1}. ${mut.name}\n      NOT CAUGHT`);
    }
  }
  console.log(`   ${caught}/${mutations.length} guards proven load-bearing`);
}

const args = process.argv.slice(2);
if (args.includes('--mutate') || args.includes('--all')) await mutate();

// ---------------------------------------------------------------------- done
console.log('\n' + '-'.repeat(60));
if (fails.length === 0) {
  console.log(`PASS  ${pass} assertions, 0 failures`);
  process.exit(0);
}
console.log(`FAIL  ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log('  x ' + f);
process.exit(1);
