// scripts/mutate-dispatch-api.mjs
//
//   DISPATCH_TEST_KEY=... node scripts/mutate-dispatch-api.mjs
//
// Breaks each guard in the dispatch endpoints ON PURPOSE and checks that
// verify-dispatch-api.mjs goes RED. A suite that stays green with a guard
// deleted is not testing that guard, and this repo has already shipped exactly
// that: an assertion that "the blast withholds the homeowner's number" which
// could not fail, because the test fixture never contained the number.
//
// Each mutation is the real bug it stands for, not a syntax scramble.

import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

process.chdir(join(dirname(fileURLToPath(import.meta.url)), ".."));

if (!process.env.DISPATCH_TEST_KEY) {
  console.error("Set DISPATCH_TEST_KEY to the real key.");
  process.exit(2);
}

const API = "api/dispatch-send.js";
const LIB = "lib/dispatch.js";
const ENDPOINTS = "scripts/verify-dispatch-api.mjs"; // real req/res, stubbed Twilio
const PURE = "scripts/verify-dispatch.mjs";          // pure functions, no network

const original = { [API]: readFileSync(API, "utf8"), [LIB]: readFileSync(LIB, "utf8") };

// [file, find, replace, what the real bug would be, which suite must catch it]
//
// The suite column is not decoration. Lead PARSING is a pure-function concern
// and the endpoint suite has no business asserting it; running every mutation
// against one suite would have reported a false gap here.
const MUTATIONS = [
  [API, "if (body.dryRun === true) {", "if (false) {",
    "dryRun ignored — EVERY blast sends twice and bills twice", ENDPOINTS],
  [API, "const status = sent.length === 0 ? 502 : 200;", "const status = 200;",
    "a blast where every text failed reports a cheerful 200", ENDPOINTS],
  [API, "if (!keyOk(key)) return res.status(401)", "if (false) return res.status(401)",
    "auth gate gone — an open SMS relay on his Twilio account", ENDPOINTS],
  [API,
    "service: lead.service, zip: lead.zip, urgency: lead.urgency,\n      details: lead.details, callbackPhone, firstTime: r.firstTime,",
    "service: lead.service, zip: lead.zip, urgency: lead.urgency,\n      details: (lead.details || \"\") + \" call \" + lead.phone, callbackPhone, firstTime: r.firstTime,",
    "homeowner's number leaks to every contractor — the lead stops being worth anything", ENDPOINTS],
  [API, "if (!isSendable(normalizePhone(lead.phone))) {", "if (false) {",
    "handoff texts a winner a lead with no callable homeowner", ENDPOINTS],
  [API, "if (!company) return res.status(400)", "if (false) return res.status(400)",
    "homeowner is told a blank company is calling them", ENDPOINTS],
  [LIB, "if (seen.has(e164)) {", "if (false) {",
    "dedupe gone — one contractor gets the same job twice and replies STOP", ENDPOINTS],
  [LIB, 'if (firstTime) bits.push("Reply STOP to opt out.");', 'bits.push("Reply STOP to opt out.");',
    "opt-out line on every message — wastes a segment and reads like spam", ENDPOINTS],
  [LIB, "const usable = !!(service && phone);", "const usable = true;",
    "a lead with no phone renders as a tappable card that cannot be dispatched", PURE],
  // Mutate the WHOLE line. Disabling only the title half stayed green, because
  // the message half caught the same fixture — a passing mutation test hiding
  // behind an overlapping rule.
  [LIB, 'if (/health (alert|check)/i.test(title) || /health check/i.test(msg)) return false;', "",
    "a health alert shows up as a dispatchable job", PURE],
];

// KNOWN EQUIVALENT MUTATION, recorded rather than quietly left out of the list:
// deleting `if (s.length < 16) return false;` from keyOk() does NOT turn this
// suite red, and that is correct — the SHA-256 comparison on the next line
// already rejects every short string. The line is a cheap early-out, not a
// security boundary, and lib/dispatch.js says so. Listing it here so nobody
// later "discovers" an untested guard and assumes the suite is weak.

let caught = 0;
const missed = [];

for (const [file, find, replace, bug, suite] of MUTATIONS) {
  const src = original[file];
  if (!src.includes(find)) {
    // A mutation that never applied is worse than a failing one: it looks like
    // a pass. This happens the moment someone reformats the line.
    missed.push(`${bug}\n      [PATTERN NO LONGER IN ${file} — mutation never applied, fix this script]`);
    continue;
  }
  writeFileSync(file, src.replace(find, replace));
  let red = false;
  try {
    execSync(`node ${suite}`, { stdio: "pipe" });
  } catch {
    red = true;
  }
  writeFileSync(file, src);
  if (red) {
    caught++;
    console.log(`  caught by ${suite.replace("scripts/", "")}: ${bug}`);
  } else {
    missed.push(`${bug}\n      [stayed GREEN in ${suite}]`);
  }
}

// Restore unconditionally, then prove the restore worked — a mutation script
// that leaves a broken file behind is a very expensive kind of helpful.
writeFileSync(API, original[API]);
writeFileSync(LIB, original[LIB]);
execSync(`node ${ENDPOINTS}`, { stdio: "pipe" });
execSync(`node ${PURE}`, { stdio: "pipe" });

console.log(`\n${caught} of ${MUTATIONS.length} mutations caught (suite green again after restore)`);
if (missed.length) {
  console.log("\nNOT CAUGHT:");
  for (const m of missed) console.log("  ✗ " + m);
  process.exit(1);
}
console.log("MUTATION PASS");
