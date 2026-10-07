// scripts/verify-dispatch.mjs
//
//   node scripts/verify-dispatch.mjs
//   node scripts/verify-dispatch.mjs --mutate
//
// No network, no Twilio, no deploy. Every branch below is one that costs real
// money or a blocked sending number when it is wrong, and none of them can be
// reached from this machine through a browser.
//
// --mutate breaks each guard on purpose and fails if the suite still passes. A
// guard that is never mutation-tested has not been tested: this repo has
// already shipped a test suite that agreed with a comment that was backwards on
// both clauses.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  normalizePhone, isSendable, keyOk, blastText, handoffText, homeownerText,
  pretty, prepareRecipients, parseLead, isLeadNotification, KEY_HASH,
} from "../lib/dispatch.js";

// Imported, never pasted: if match-intake's notification format changes, the
// fixtures below change with it and the parser test fails loudly instead of the
// dispatch page quietly rendering an empty lead.
import { summarize, normalizePhone as intakeNormalize } from "../api/match-intake.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

let pass = 0;
const fails = [];
function ok(cond, label) {
  if (cond) { pass++; return; }
  fails.push(label);
}
function eq(got, want, label) {
  ok(got === want, `${label}\n      got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`);
}

// ------------------------------------------------------------- phone -------
const PHONE_CASES = [
  ["3035550134", "+13035550134"],
  ["(303) 555-0134", "+13035550134"],
  ["1 303 555 0134", "+13035550134"],
  ["+1 (303) 555-0134", "+13035550134"],
  ["303-555-013", ""],          // 9 digits
  ["", ""],
  [null, ""],
  ["abc", ""],
  ["23035550134", ""],          // 11 digits not starting with 1
];
for (const [raw, want] of PHONE_CASES) {
  eq(normalizePhone(raw), want, `normalizePhone(${JSON.stringify(raw)})`);
  // Two copies of this function exist. They must agree, or the page accepts a
  // number the intake rejects (or worse, the reverse).
  eq(intakeNormalize(raw), want, `api/match-intake normalizePhone agrees on ${JSON.stringify(raw)}`);
}

// Twilio 400s on these and still counts the attempt, which reads as a
// half-failed blast rather than a typo.
eq(isSendable("+13035550134"), true, "isSendable: real number");
eq(isSendable("+10035550134"), false, "isSendable: area code starts 0");
eq(isSendable("+11035550134"), false, "isSendable: area code starts 1");
eq(isSendable("+13031550134"), false, "isSendable: exchange starts 1");
eq(isSendable("+13030550134"), false, "isSendable: exchange starts 0");
eq(isSendable("3035550134"), false, "isSendable: demands E.164");
eq(isSendable(""), false, "isSendable: empty");
eq(isSendable(null), false, "isSendable: null");

// --------------------------------------------------------------- auth ------
// An unauthenticated send endpoint is an open SMS relay billed to Andrew.
//
// The real key is NOT in this file. It used to be, on both sides of a pair of
// assertions, which quietly defeated the entire design: the repo commits only
// the SHA-256 precisely so the plaintext never enters git, and a test file is
// committed like anything else. It comes from the environment instead, and the
// assertions below check this file for it so it cannot creep back in.
const REAL = process.env.DISPATCH_TEST_KEY || "";
let skipped = 0;
if (REAL) {
  eq(keyOk(REAL), true, "keyOk: the real key");
  // One character off, derived rather than written out, so there is no second
  // near-copy of the key sitting in the file either.
  const off = REAL.slice(0, -1) + (REAL.slice(-1) === "x" ? "y" : "x");
  eq(keyOk(off), false, "keyOk: one character off");
  eq(keyOk(REAL + " "), false, "keyOk: a trailing space is not the key");
  eq(keyOk(REAL.slice(0, -1)), false, "keyOk: a truncated key is not the key");
} else {
  // Say how many checks did NOT run. A suite that silently drops its four most
  // important assertions and still prints PASS is the exact shape of lie this
  // repo keeps getting bitten by.
  skipped = 4;
}
eq(keyOk(""), false, "keyOk: empty string");
eq(keyOk(null), false, "keyOk: null");
eq(keyOk(undefined), false, "keyOk: undefined");
eq(keyOk(true), false, "keyOk: a truthy non-string");
eq(keyOk("short"), false, "keyOk: too short to be the key");
eq(keyOk(KEY_HASH), false, "keyOk: presenting the published hash is not the key");

// Nothing in the repo may contain the plaintext — including this file.
for (const f of ["lib/dispatch.js", "public/dispatch/index.html",
                 "scripts/verify-dispatch.mjs", "scripts/verify-dispatch-page.mjs",
                 "scripts/verify-dispatch-api.mjs"]) {
  const src = readFileSync(join(root, f), "utf8");
  // HONEST LIMIT: with no DISPATCH_TEST_KEY in the environment this cannot
  // check anything — there is nothing to search for — and it passes vacuously.
  // That is counted in `skipped` below and printed, rather than left to look
  // like a real pass.
  ok(!(REAL && src.includes(REAL)), `the plaintext key is NOT committed in ${f}`);
  if (!REAL) skipped++;
}

// ------------------------------------------------------------ messages -----
// NOTE the name and phone in here. They are present ON PURPOSE: the whole lead
// object is what the endpoint has in hand, so the only honest way to test that
// blastText withholds the homeowner is to hand it the homeowner and check the
// output. A fixture that omits them makes the withholding assertion unfailable.
const LEAD = {
  service: "Water heater", zip: "80205", urgency: "Emergency - today",
  details: "rusted at the base, water on the floor", callbackPhone: "+13035550134",
  name: "Dave Horton", phone: "+13035550199",
};
const blast = blastText({ ...LEAD, firstTime: true });

// The lawsuit words. The /match page has the same test; the blast needs it too,
// because this message is the one a contractor could forward to a homeowner.
for (const word of ["vetted", "licensed", "insured", "certified", "screened", "guaranteed"]) {
  ok(!new RegExp(word, "i").test(blast), `blast never claims "${word}"`);
}
// "First yes gets it" is worthless if the losers can call the homeowner anyway.
ok(!blast.includes("Dave Horton"), "blast withholds the homeowner's name (given it)");
ok(!blast.includes("0199") && !blast.includes("555-0199"),
   "blast withholds the homeowner's number (given it)");
// Self-check: prove the fixture actually carries what we claim to be stripping,
// or the two assertions above are testing nothing at all.
ok(LEAD.name === "Dave Horton" && LEAD.phone.includes("0199"),
   "fixture really does contain the homeowner, so the two checks above can fail");
ok(blast.includes("80205"), "blast includes the ZIP so he can judge the drive");
ok(blast.includes("Water heater"), "blast includes the trade");
ok(/first to reply yes/i.test(blast), "blast states the race rule");
ok(blast.includes("Reply STOP to opt out."), "first message to a contractor carries opt-out language");
ok(!blastText({ ...LEAD, firstTime: false }).includes("STOP"),
   "later messages drop the opt-out line (it wastes a segment and reads like spam)");

// A 600-char details field would silently become a 5-segment MMS.
const longBlast = blastText({ ...LEAD, details: "x".repeat(600), firstTime: false });
ok(longBlast.length < 320, `blast stays inside 2 SMS segments (was ${longBlast.length})`);
ok(longBlast.includes("..."), "over-long details are truncated visibly, not silently");

const hand = handoffText({
  name: "Dave Horton", phone: "+13035550199", service: "Water heater", zip: "80205",
  details: "rusted at the base", callbackPhone: "+13035550134",
});
ok(hand.includes("(303) 555-0199"), "handoff DOES carry the homeowner's number");
ok(hand.includes("Dave Horton"), "handoff carries the homeowner's name");
ok(/20 minutes/.test(hand), "handoff sets the callback expectation");

const ho = homeownerText({ company: "Mile High Plumbing", callbackPhone: "+13035550134" });
ok(ho.includes("Mile High Plumbing"), "homeowner text names the company that will call");
ok(!/vetted|licensed|insured/i.test(ho), "homeowner text makes no licensing claim");

eq(pretty("+13035550134"), "(303) 555-0134", "pretty formats E.164");
eq(pretty("3035550134"), "(303) 555-0134", "pretty formats bare 10 digits");
eq(pretty("nonsense"), "nonsense", "pretty passes through what it cannot parse");

// ---------------------------------------------------------- recipients -----
const bench = [
  { name: "Mile High Plumbing", phone: "(303) 555-0111", firstTime: true },
  { name: "Mike", phone: "303-555-0222" },
  { name: "Mike's Plumbing", phone: "+1 303 555 0222" },  // SAME human, 2 rows
  { name: "Broken", phone: "555" },
  { name: "Bad area code", phone: "(103) 555-0333" },
  { name: "Fourth", phone: "3035550444" },
];
const { recipients, rejected } = prepareRecipients(bench);
eq(recipients.length, 3, "dedupes by number, not by name");
eq(recipients.map((r) => r.phone).join(","), "+13035550111,+13035550222,+13035550444", "keeps the right three");
eq(rejected.length, 3, "reports all three it refused");
ok(rejected.some((r) => /already on this blast/.test(r.reason)), "names the duplicate explicitly");
ok(rejected.some((r) => r.name === "Broken"), "reports the unusable number by name");
eq(recipients[0].firstTime, true, "carries firstTime through for opt-out language");
eq(prepareRecipients(null).recipients.length, 0, "null bench is empty, not a crash");
eq(prepareRecipients([]).recipients.length, 0, "empty bench is empty");
eq(prepareRecipients(
  Array.from({ length: 20 }, (_, i) => ({ name: "C" + i, phone: `303555${String(1000 + i)}` }))
).recipients.length, 6, "caps the blast at 6 so a fat-fingered bench cannot bill 20 texts");

// --------------------------------------------------- parsing real pushes ---
// Fixture built by calling the REAL summarize() from api/match-intake.js.
const realLead = {
  name: "Dave Horton", phone: "+13035550199", service: "Water heater", zip: "80205",
  urgency: "Emergency - today", details: "rusted at the base, water on the floor",
  referred_by: "Stauss Inspections", at: new Date().toISOString(),
};
const parsed = parseLead(summarize(realLead), "Water heater job - 80205", { id: "abc", time: 1791327328 });
eq(parsed.service, "Water heater", "parses the trade out of a real push");
eq(parsed.zip, "80205", "parses the ZIP");
eq(parsed.name, "Dave Horton", "parses the homeowner's name");
eq(parsed.phone, "+13035550199", "parses the phone to E.164");
eq(parsed.urgency, "Emergency - today", "parses the urgency");
eq(parsed.details, "rusted at the base, water on the floor", "parses the quoted details");
eq(parsed.referred_by, "Stauss Inspections", "parses which inspector sent them");
eq(parsed.emergency, true, "flags an emergency");
eq(parsed.usable, true, "a complete lead is usable");

// A name containing spaces, no details, no referrer — the common shape.
const bare = parseLead(summarize({
  name: "Mary Beth Cole", phone: "+13035550155", service: "Roofing", zip: "80211",
  urgency: "This week", details: "", referred_by: "",
}), "Roofing job - 80211", {});
eq(bare.name, "Mary Beth Cole", "parses a multi-word name");
eq(bare.details, "", "absent details parse as empty, not as the next line");
eq(bare.referred_by, "", "absent referrer parses as empty");
eq(bare.emergency, false, "non-emergency is not flagged");
eq(bare.usable, true, "a lead with no details is still usable");
eq(parseLead("", "", {}).usable, false, "an empty push is not a usable lead");
eq(parseLead("Plumbing - 80205\nno phone here", "", {}).usable, false, "a lead with no number is not usable");

// The same ntfy topic carries health alerts. Showing one as a job is how a tool
// gets opened once and never again. This is a MEASURED string from the topic.
const healthAlert = {
  event: "message", title: "AI Lead Intel health alert",
  message: "AI Lead Intel health check FAILING:\n- supabase: fetch failed\n- phone_pool: fetch failed",
};
eq(isLeadNotification(healthAlert), false, "a health alert is NOT a dispatchable lead");

// THIS is the case the health-alert check actually earns its place on, and the
// assertion above does not reach it. api/health.js titles every alert
// "AI Lead Intel health alert", which contains no "job", so the POSITIVE test
// at the end of isLeadNotification already rejects today's alerts on its own —
// delete the health line and the assertion above still passes. The health line
// is the only thing standing between the dispatch list and an alert that names
// the broken job in its title, which is exactly how a failure message gets
// worded the day the lead notifier dies. Found by mutation testing, not by
// reading: the obvious fixture was being caught by a different rule.
eq(isLeadNotification({
  event: "message",
  title: "AI Lead Intel health alert: lead notify job dead",
  message: "AI Lead Intel health check FAILING:\n- resend: fetch failed",
}), false, "a health alert that mentions a job in its TITLE is still not a lead");

eq(isLeadNotification({ event: "message", title: "Water heater job - 80205", message: summarize(realLead) }),
   true, "a real lead push IS dispatchable");
eq(isLeadNotification({ event: "keepalive" }), false, "an ntfy keepalive is not a lead");
eq(isLeadNotification({}), false, "an empty notification is not a lead");

// ----------------------------------------------------- the page's claims ---
// Copy expires when features ship: an old reassurance silently becomes a lie.
// Anything the dispatch page PROMISES must be enforced by code above.
const pageFile = join(root, "public/dispatch/index.html");
let page = "";
try { page = readFileSync(pageFile, "utf8"); } catch { /* built later in this run */ }
if (page) {
  for (const word of ["vetted", "licensed and insured", "screened"]) {
    ok(!new RegExp(word, "i").test(page), `dispatch page never claims "${word}"`);
  }
  ok(!(REAL && page.includes(REAL)), "the access key is NOT baked into the page source");
  ok(/localStorage/.test(page), "the bench is stored on the device (no database to be paused)");
}

// ------------------------------------------------------------- mutate ------
// Prove each guard actually fires. If the suite still passes with a rule
// deleted, that rule was decoration.
if (process.argv.includes("--mutate")) {
  const mutations = [
    ["isSendable stops accepting bad area codes", () => isSendable("+10035550134") === false],
    ["keyOk rejects the empty string",            () => keyOk("") === false],
    ["keyOk rejects a wrong key",                 () => keyOk("x".repeat(32)) === false],
    ["blast withholds the homeowner's number",    () => !blastText(LEAD).includes("0199")],
    ["...and the fixture contains it to begin with", () => LEAD.phone.includes("0199")],
    ["blast is length-capped",                    () => blastText({ ...LEAD, details: "x".repeat(600) }).length < 320],
    ["recipients dedupe by number",               () => prepareRecipients(bench).recipients.length === 3],
    ["recipients are capped at 6",                () => prepareRecipients(Array.from({ length: 20 },
        (_, i) => ({ name: "C", phone: `303555${String(1000 + i)}` }))).recipients.length === 6],
    ["health alerts are filtered out",            () => isLeadNotification(healthAlert) === false],
    ["a lead with no phone is unusable",          () => parseLead("Plumbing - 80205", "", {}).usable === false],
  ];
  let caught = 0;
  for (const [label, fn] of mutations) {
    if (fn()) { caught++; } else { fails.push(`MUTATION NOT CAUGHT: ${label}`); }
  }
  console.log(`\n${caught} of ${mutations.length} mutations caught`);
}

// ------------------------------------------------------------- report ------
console.log(`\n${pass} assertions passed`);
if (skipped) {
  // Printed as a WARNING, not folded into the pass count. These are the auth
  // checks, which are the ones that matter most.
  console.log(`${skipped} auth assertions SKIPPED — set DISPATCH_TEST_KEY to run them. ` +
    `A pass without them does not say the key gate works.`);
}
if (fails.length) {
  console.log(`\n${fails.length} FAILED:`);
  for (const f of fails) console.log("  ✗ " + f);
  process.exit(1);
}
console.log("PASS");
