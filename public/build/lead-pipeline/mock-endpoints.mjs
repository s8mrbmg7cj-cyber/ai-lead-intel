#!/usr/bin/env node
// Stand-ins for Twilio and GoHighLevel so the whole graph can execute before
// anyone pays for a phone number. They speak the same wire format as the real
// endpoints (form-encoded for Twilio, JSON for GHL) and print what they got, so
// the thing being verified is the actual request the real API would receive.
//
// Going live is a one-line change per node — see README.
//
//   node mock-endpoints.mjs            -> http://localhost:4000/sms and /crm

import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.MOCK_PORT || 4000);
// fileURLToPath, not .pathname — this project lives under a path with a space
// in it, and .pathname hands back "Prime%20Vault" which fs cannot open.
const LOG = fileURLToPath(new URL('./mock-received.log', import.meta.url));

const read = (req) =>
  new Promise((res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => res(b));
  });

createServer(async (req, res) => {
  const body = await read(req);
  const at = new Date().toISOString();

  if (req.url === '/sms') {
    const f = new URLSearchParams(body);
    const text = f.get('Body') ?? '';
    console.log(`\n=== SMS -> ${f.get('To')}  (${text.length} chars, ${Math.ceil(text.length / 160)} segment(s))`);
    console.log(text.split('\n').map((l) => '    ' + l).join('\n'));
    appendFileSync(LOG, JSON.stringify({ at, kind: 'sms', to: f.get('To'), body: text }) + '\n');
    res.writeHead(201, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ sid: 'SM' + Math.random().toString(36).slice(2, 14), status: 'queued' }));
  }

  if (req.url === '/whatsapp') {
    let p = {};
    try { p = JSON.parse(body); } catch {}
    const text = p.text?.body ?? '';
    console.log(`\n=== WhatsApp -> ${p.to}  (${text.length} chars, no segment billing)`);
    console.log(text.split('\n').map((l) => '    ' + l).join('\n'));
    appendFileSync(LOG, JSON.stringify({ at, kind: 'whatsapp', to: p.to, body: text }) + '\n');
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      messaging_product: 'whatsapp',
      contacts: [{ wa_id: p.to }],
      messages: [{ id: 'wamid.' + Math.random().toString(36).slice(2, 16) }],
    }));
  }

  if (req.url === '/crm') {
    let p = {};
    try { p = JSON.parse(body); } catch {}
    console.log(`\n=== CRM upsert: ${p.name || '(no name)'} | ${p.phone || '-'} | tags=${(p.tags || []).join(',')}`);
    for (const cf of p.customFields || []) console.log(`    ${cf.key} = ${cf.field_value}`);
    appendFileSync(LOG, JSON.stringify({ at, kind: 'crm', payload: p }) + '\n');
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ contact: { id: 'ct_' + Math.random().toString(36).slice(2, 10) } }));
  }

  res.writeHead(404).end('no such mock endpoint');
}).listen(PORT, () => {
  console.log(`mock Twilio   -> http://localhost:${PORT}/sms`);
  console.log(`mock WhatsApp -> http://localhost:${PORT}/whatsapp`);
  console.log(`mock GHL      -> http://localhost:${PORT}/crm`);
  console.log(`appending to ${LOG}`);
});
