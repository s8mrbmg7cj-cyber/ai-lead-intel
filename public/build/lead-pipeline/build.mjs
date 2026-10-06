#!/usr/bin/env node
// Generates lead-to-callback.json from src/*.js.
//
// The Code nodes are not hand-written inside the workflow JSON. They are built
// from the same files verify.mjs tests, so there is exactly one copy of the
// logic. Editing the JSON by hand is the one thing not to do — run this instead.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(join(HERE, 'src', f), 'utf8');

// Strip the ESM export line — n8n Code nodes are a function body, not a module.
const pure = (f) =>
  read(f).replace(/^export\s*\{[^}]*\};?\s*$/m, '').trimEnd();

const { SYSTEM_PROMPT } = await import('./src/prompt.js');

const code = {
  normalize: `${pure('normalize.js')}

// ---- n8n glue ----
const out = [];
for (const item of $input.all()) {
  // Webhook v2 puts the posted body under .body; accept a bare object too.
  out.push({ json: normalizeLead(item.json.body ?? item.json) });
}
return out;`,

  qualify: `${pure('qualify.js')}

// ---- n8n glue ----
// Reach back to node 1 for the lead, because the HTTP node replaced the item.
const norm = $('1. Normalize + validate').all();
const items = $input.all();
const out = [];

for (let i = 0; i < items.length; i++) {
  const lead = norm[Math.min(i, norm.length - 1)].json.lead;
  const resp = items[i].json ?? {};

  let text = '';
  let apiError = null;

  if (Array.isArray(resp.content)) {
    // Anthropic success. The assistant turn was prefilled with "{", so the
    // text that comes back is missing its opening brace — extractJson knows.
    text = resp.content.map((c) => c.text ?? '').join('');
  } else if (resp.error) {
    apiError = resp.error.message ?? JSON.stringify(resp.error);
  } else if (resp.message) {
    apiError = String(resp.message);
  } else {
    apiError = 'no response body from the model endpoint';
  }

  out.push({ json: { lead, q: qualify(lead, text, apiError) } });
}
return out;`,

  compose: `${pure('compose.js')}

// ---- n8n glue ----
const out = [];
for (const item of $input.all()) {
  const lead = item.json.lead;
  const q = item.json.q;
  out.push({ json: { lead, q, ...compose(lead, q, { locationId: $env.GHL_LOCATION_ID, ownerPhone: $env.OWNER_PHONE }) } });
}
return out;`,

  unreachable: `// Nothing is thrown away silently. An unreachable submission still gets a
// row, so "we never heard from them" can be told apart from "we dropped it".
const out = [];
for (const item of $input.all()) {
  out.push({ json: {
    outcome: 'not_contactable',
    reason: (item.json.errors || []).join('; '),
    warnings: (item.json.warnings || []).join('; '),
    lead: item.json.lead,
  } });
}
return out;`,
};

const N = (name, type, typeVersion, position, parameters, extra = {}) => ({
  parameters, type, typeVersion, position, id: name, name, ...extra,
});

const nodes = [
  N('Lead arrives (webhook)', 'n8n-nodes-base.webhook', 2, [-220, 300], {
    httpMethod: 'POST',
    path: 'new-lead',
    responseMode: 'onReceived',
    options: {},
  }, { webhookId: 'lead-pipeline-new-lead' }),

  N('1. Normalize + validate', 'n8n-nodes-base.code', 2, [0, 300], {
    mode: 'runOnceForAllItems',
    jsCode: code.normalize,
  }),

  N('Reachable?', 'n8n-nodes-base.if', 2.2, [220, 300], {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      conditions: [{
        id: 'reachable',
        leftValue: '={{ $json.valid }}',
        rightValue: '',
        operator: { type: 'boolean', operation: 'true', singleValue: true },
      }],
      combinator: 'and',
    },
    options: {},
  }),

  N('2. Claude qualifies the lead', 'n8n-nodes-base.httpRequest', 4.2, [460, 200], {
    method: 'POST',
    url: 'https://api.anthropic.com/v1/messages',
    sendHeaders: true,
    headerParameters: {
      parameters: [
        { name: 'x-api-key', value: '={{ $env.ANTHROPIC_API_KEY }}' },
        { name: 'anthropic-version', value: '2023-06-01' },
        { name: 'content-type', value: 'application/json' },
      ],
    },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: `={{ JSON.stringify({
  model: 'claude-sonnet-4-6',
  max_tokens: 700,
  temperature: 0,
  system: ${JSON.stringify(SYSTEM_PROMPT)},
  messages: [
    { role: 'user', content: 'Qualify this lead.\\n\\n<lead>\\n' + JSON.stringify($json.lead, null, 2) + '\\n</lead>' },
    { role: 'assistant', content: '{' }
  ]
}) }}`,
    options: { timeout: 20000 },
  }, {
    // The model is allowed to fail. Node 3 scores by rule instead and says so.
    onError: 'continueRegularOutput',
    retryOnFail: true,
    maxTries: 2,
    waitBetweenTries: 1500,
  }),

  N('3. Qualify (AI, bounded by rules)', 'n8n-nodes-base.code', 2, [700, 200], {
    mode: 'runOnceForAllItems',
    jsCode: code.qualify,
  }),

  N('4. Compose alert + CRM record', 'n8n-nodes-base.code', 2, [920, 200], {
    mode: 'runOnceForAllItems',
    jsCode: code.compose,
  }),

  N('Tier A?', 'n8n-nodes-base.if', 2.2, [1140, 200], {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      conditions: [{
        id: 'notify',
        leftValue: '={{ $json.notify_now }}',
        rightValue: '',
        operator: { type: 'boolean', operation: 'true', singleValue: true },
      }],
      combinator: 'and',
    },
    options: {},
  }),

  N('Text the owner now', 'n8n-nodes-base.httpRequest', 4.2, [1380, 100], {
    method: 'POST',
    url: '={{ $env.SMS_ENDPOINT }}',
    sendBody: true,
    contentType: 'form-urlencoded',
    bodyParameters: {
      parameters: [
        { name: 'To', value: '={{ $env.OWNER_PHONE }}' },
        { name: 'From', value: '={{ $env.TWILIO_FROM }}' },
        { name: 'Body', value: '={{ $json.alert_text }}' },
      ],
    },
    options: { timeout: 15000 },
  }, { onError: 'continueRegularOutput', retryOnFail: true, maxTries: 3, waitBetweenTries: 2000 }),

  // Second notification channel, same tier-A gate. WhatsApp has no 160-char
  // segment billing, so this one carries the intent, urgency and suggested
  // opening question that the SMS has to drop. Delete whichever node the client
  // does not want — they are siblings, not a fallback chain.
  N('WhatsApp the owner now', 'n8n-nodes-base.httpRequest', 4.2, [1380, 0], {
    method: 'POST',
    url: '={{ $env.WHATSAPP_ENDPOINT }}',
    sendHeaders: true,
    headerParameters: {
      parameters: [
        { name: 'Authorization', value: '=Bearer {{ $env.WHATSAPP_TOKEN }}' },
        { name: 'content-type', value: 'application/json' },
      ],
    },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ JSON.stringify($json.whatsapp) }}',
    options: { timeout: 15000 },
  }, { onError: 'continueRegularOutput', retryOnFail: true, maxTries: 3, waitBetweenTries: 2000 }),

  N('Hold for daily digest', 'n8n-nodes-base.noOp', 1, [1380, 300], {}),

  N('Upsert into GoHighLevel', 'n8n-nodes-base.httpRequest', 4.2, [1380, 460], {
    method: 'POST',
    url: '={{ $env.CRM_ENDPOINT }}',
    sendHeaders: true,
    headerParameters: {
      parameters: [
        { name: 'Authorization', value: '=Bearer {{ $env.GHL_API_KEY }}' },
        { name: 'Version', value: '2021-07-28' },
        { name: 'content-type', value: 'application/json' },
      ],
    },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ JSON.stringify($json.crm) }}',
    options: { timeout: 15000 },
  }, { onError: 'continueRegularOutput', retryOnFail: true, maxTries: 3, waitBetweenTries: 2000 }),

  N('Audit row', 'n8n-nodes-base.code', 2, [1380, 620], {
    mode: 'runOnceForAllItems',
    jsCode: `// One row per lead, including how long the whole thing took and whether the
// AI or the rule engine produced the score. Swap this for a Google Sheets
// "Append Row" node and map these keys straight across.
return $input.all().map((i) => ({ json: i.json.audit }));`,
  }),

  N('Log unreachable', 'n8n-nodes-base.code', 2, [460, 460], {
    mode: 'runOnceForAllItems',
    jsCode: code.unreachable,
  }),
];

const link = (from, to, outputIndex = 0) => ({ from, to, outputIndex });
const edges = [
  link('Lead arrives (webhook)', '1. Normalize + validate'),
  link('1. Normalize + validate', 'Reachable?'),
  link('Reachable?', '2. Claude qualifies the lead', 0),
  link('Reachable?', 'Log unreachable', 1),
  link('2. Claude qualifies the lead', '3. Qualify (AI, bounded by rules)'),
  link('3. Qualify (AI, bounded by rules)', '4. Compose alert + CRM record'),
  link('4. Compose alert + CRM record', 'Tier A?'),
  link('4. Compose alert + CRM record', 'Upsert into GoHighLevel'),
  link('4. Compose alert + CRM record', 'Audit row'),
  link('Tier A?', 'Text the owner now', 0),
  link('Tier A?', 'WhatsApp the owner now', 0),
  link('Tier A?', 'Hold for daily digest', 1),
];

const connections = {};
for (const { from, to, outputIndex } of edges) {
  connections[from] ??= { main: [] };
  while (connections[from].main.length <= outputIndex) connections[from].main.push([]);
  connections[from].main[outputIndex].push({ node: to, type: 'main', index: 0 });
}

const workflow = {
  // A stable id so re-importing updates this workflow instead of adding a
  // duplicate. The n8n CLI requires it and rejects the import without one.
  id: 'leadpipe00000001',
  name: 'Lead -> AI qualify -> CRM + 60s callback',
  active: true,
  nodes,
  connections,
  settings: { executionOrder: 'v1' },
  pinData: {},
  meta: { instanceId: 'lead-pipeline-portfolio' },
};

const outFile = join(HERE, 'lead-to-callback.json');
writeFileSync(outFile, JSON.stringify(workflow, null, 2) + '\n');

const names = new Set(nodes.map((n) => n.name));
const dangling = edges.filter((e) => !names.has(e.from) || !names.has(e.to));

console.log(`wrote ${outFile}`);
console.log(`  ${nodes.length} nodes, ${edges.length} connections, ${dangling.length} dangling`);
if (dangling.length) {
  console.error('  DANGLING:', dangling);
  process.exit(1);
}
for (const n of nodes.filter((n) => n.type === 'n8n-nodes-base.code')) {
  console.log(`  code node "${n.name}": ${n.parameters.jsCode.split('\n').length} lines`);
}
