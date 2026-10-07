// scripts/verify-dispatch-api.mjs
//
//   node scripts/verify-dispatch-api.mjs
//
// Calls the two dispatch handlers directly with fake req/res objects and a
// STUBBED Twilio, so every branch that would otherwise cost money or need a
// deploy actually executes here.
//
// The headline check is dryRun. The page asks the server for the exact text
// before showing the confirm sheet; if the handler ignored that flag, every
// blast would send twice and bill twice, and the only symptom would be
// contractors getting duplicate texts. That is precisely the class of bug that
// cannot be caught by reading the file.

import { registerHooks } from "node:module";

const KEY = process.env.DISPATCH_TEST_KEY;
if (!KEY) {
  console.error("Set DISPATCH_TEST_KEY to the real key to run this suite.");
  process.exit(2);
}

// ---- stub Twilio before the handler imports it -----------------------------
// The real `twilio` package is not installed on this machine (no node_modules;
// Vercel installs it at build time). So instead of faking the package on disk,
// intercept the module specifier itself with a loader hook. The handler's
// `await import("twilio")` is unchanged and still really runs — only the thing
// it resolves to is ours. Nothing is written to the repo, and a later
// `npm install` cannot leave a stale stub behind.
const SENT = [];
let twilioShouldFail = null;
globalThis.__twilioStub = () => ({
  messages: {
    create: async ({ body, from, to }) => {
      if (twilioShouldFail && twilioShouldFail(to)) {
        const e = new Error("The message cannot be sent to this number");
        e.code = 21610;
        throw e;
      }
      SENT.push({ body, from, to });
      return { sid: "SM" + SENT.length.toString().padStart(30, "0") };
    },
  },
});
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === "twilio") return { url: "stub:twilio", shortCircuit: true };
    return next(spec, ctx);
  },
  load(url, ctx, next) {
    if (url === "stub:twilio") {
      return {
        format: "module",
        source: "export default (...a) => globalThis.__twilioStub(...a);",
        shortCircuit: true,
      };
    }
    return next(url, ctx);
  },
});

process.env.TWILIO_ACCOUNT_SID = "ACtest";
process.env.TWILIO_AUTH_TOKEN = "tok";
process.env.TWILIO_PHONE_NUMBER = "+13035550100";

const { default: send } = await import("../api/dispatch-send.js");
const { default: leads } = await import("../api/dispatch-leads.js");

// ---- tiny req/res harness ---------------------------------------------------
function mkRes() {
  const r = { _status: 0, _json: null, _headers: {} };
  r.setHeader = (k, v) => { r._headers[k] = v; };
  r.status = (s) => { r._status = s; return r; };
  r.json = (j) => { r._json = j; return r; };
  r.end = () => r;
  return r;
}
const call = async (h, req) => { const res = mkRes(); await h(req, res); return res; };

let pass = 0;
const fails = [];
function ok(c, label) { if (c) pass++; else fails.push(label); }
function eq(g, w, label) {
  ok(g === w, `${label}\n      got:  ${JSON.stringify(g)}\n      want: ${JSON.stringify(w)}`);
}

const LEAD = {
  id: "x1", service: "Water heater", zip: "80205", name: "Dave Horton",
  phone: "+13035550199", urgency: "Emergency - today", details: "rusted at the base",
};
const BENCH = [
  { name: "Mile High Plumbing", phone: "3035550111", firstTime: true },
  { name: "Rapid Rooter", phone: "3035550222" },
  { name: "Rapid Rooter dup", phone: "(303) 555-0222" },
];

// ---------------------------------------------------------------- auth ------
for (const [label, headers, body] of [
  ["no key", {}, {}],
  ["empty key", { "x-dispatch-key": "" }, {}],
  ["wrong key", { "x-dispatch-key": "x".repeat(40) }, {}],
]) {
  const r = await call(send, { method: "POST", headers, body: { ...body, mode: "blast", lead: LEAD, contractors: BENCH } });
  eq(r._status, 401, `send rejects ${label}`);
}
eq(SENT.length, 0, "no text was sent by any unauthenticated attempt");

const r405 = await call(send, { method: "GET", headers: { "x-dispatch-key": KEY }, body: {} });
eq(r405._status, 405, "send refuses GET");

// -------------------------------------------------------------- dry run ----
SENT.length = 0;
const dry = await call(send, {
  method: "POST", headers: { "x-dispatch-key": KEY },
  body: { mode: "blast", lead: LEAD, contractors: BENCH, callbackPhone: "3035550134", dryRun: true },
});
eq(dry._status, 200, "dry run answers 200");
eq(dry._json.dryRun, true, "dry run says so");
eq(SENT.length, 0, "DRY RUN SENT NOTHING — this is the one that costs money if wrong");
ok(dry._json.preview.includes("Water heater"), "dry run returns the real message text");
ok(dry._json.preview.includes("80205"), "preview carries the ZIP");
ok(!dry._json.preview.includes("Dave Horton"), "preview withholds the homeowner's name");
ok(!dry._json.preview.includes("0199"), "preview withholds the homeowner's number");
eq(dry._json.would_send_to.length, 2, "dry run reports the deduped recipient count");

// ----------------------------------------------------------- real blast ----
SENT.length = 0;
const blast = await call(send, {
  method: "POST", headers: { "x-dispatch-key": KEY },
  body: { mode: "blast", lead: LEAD, contractors: BENCH, callbackPhone: "3035550134" },
});
eq(blast._status, 200, "real blast answers 200");
eq(SENT.length, 2, "real blast sent exactly 2 texts (the duplicate number was dropped)");
eq(blast._json.sent, 2, "reports 2 sent");
eq(new Set(SENT.map((s) => s.to)).size, 2, "two distinct numbers");
ok(SENT.every((s) => !s.body.includes("0199")), "NO sent text contains the homeowner's number");
ok(SENT.every((s) => !s.body.includes("Dave Horton")), "NO sent text contains the homeowner's name");
ok(SENT[0].body.includes("Reply STOP"), "first-time contractor got the opt-out line");
ok(!SENT[1].body.includes("Reply STOP"), "repeat contractor did not");
ok(blast._json.rejected.some((r) => /already on this blast/.test(r.reason)), "reports the dropped duplicate");

// ------------------------------------------------- partial + total failure --
SENT.length = 0;
twilioShouldFail = (to) => to === "+13035550222";
const partial = await call(send, {
  method: "POST", headers: { "x-dispatch-key": KEY },
  body: { mode: "blast", lead: LEAD, contractors: BENCH, callbackPhone: "3035550134" },
});
eq(partial._status, 200, "a partial failure is still a 200 (one contractor did get it)");
eq(partial._json.sent, 1, "counts the one that landed");
eq(partial._json.failed, 1, "AND counts the one that did not — partial delivery is not delivery");
ok(partial._json.results.some((r) => !r.ok && r.code === 21610), "passes Twilio's real reason code through");

SENT.length = 0;
twilioShouldFail = () => true;
const dead = await call(send, {
  method: "POST", headers: { "x-dispatch-key": KEY },
  body: { mode: "blast", lead: LEAD, contractors: BENCH, callbackPhone: "3035550134" },
});
eq(dead._status, 502, "ALL sends failing returns 502, never a cheerful 200");
eq(dead._json.ok, false, "and says ok:false");
twilioShouldFail = null;

// -------------------------------------------------------------- handoff ----
SENT.length = 0;
const hand = await call(send, {
  method: "POST", headers: { "x-dispatch-key": KEY },
  body: { mode: "handoff", lead: LEAD, winner: { name: "Mile High Plumbing", phone: "3035550111" }, callbackPhone: "3035550134" },
});
eq(hand._status, 200, "handoff sends");
eq(SENT.length, 1, "handoff goes to exactly one contractor");
ok(SENT[0].body.includes("(303) 555-0199"), "handoff DOES include the homeowner's number");
ok(SENT[0].body.includes("Dave Horton"), "handoff DOES include the homeowner's name");

SENT.length = 0;
const noPhone = await call(send, {
  method: "POST", headers: { "x-dispatch-key": KEY },
  body: { mode: "handoff", lead: { ...LEAD, phone: "" }, winner: { name: "A", phone: "3035550111" } },
});
eq(noPhone._status, 400, "handoff refuses a lead with no homeowner number");
eq(SENT.length, 0, "and sends nothing");

// ---------------------------------------------------- homeowner + guards ---
SENT.length = 0;
const ho = await call(send, {
  method: "POST", headers: { "x-dispatch-key": KEY },
  body: { mode: "notify-homeowner", lead: LEAD, company: "Mile High Plumbing", callbackPhone: "3035550134" },
});
eq(ho._status, 200, "homeowner notice sends");
eq(SENT[0].to, "+13035550199", "and goes to the HOMEOWNER, not a contractor");
ok(SENT[0].body.includes("Mile High Plumbing"), "names the company that will call");

SENT.length = 0;
const noCo = await call(send, {
  method: "POST", headers: { "x-dispatch-key": KEY },
  body: { mode: "notify-homeowner", lead: LEAD, company: "" },
});
eq(noCo._status, 400, "refuses to tell a homeowner that nobody is calling");
eq(SENT.length, 0, "and sends nothing");

SENT.length = 0;
const empty = await call(send, {
  method: "POST", headers: { "x-dispatch-key": KEY },
  body: { mode: "blast", lead: LEAD, contractors: [{ name: "Typo", phone: "555" }] },
});
eq(empty._status, 400, "a bench of unusable numbers is a 400, not a silent success");
eq(SENT.length, 0, "and sends nothing");

const bad = await call(send, {
  method: "POST", headers: { "x-dispatch-key": KEY },
  body: { mode: "teleport", lead: LEAD },
});
eq(bad._status, 400, "an unknown mode is refused");

// ---------------------------------------------------------- leads endpoint -
const l401 = await call(leads, { method: "GET", headers: {}, query: {} });
eq(l401._status, 401, "lead list is key-gated too (it carries homeowners' numbers)");

console.log(`\n${pass} assertions passed`);
if (fails.length) {
  console.log(`\n${fails.length} FAILED:`);
  for (const f of fails) console.log("  ✗ " + f);
  process.exit(1);
}
console.log("PASS");
