// scripts/verify-match-intake.mjs
//
//   node scripts/verify-match-intake.mjs
//   node scripts/verify-match-intake.mjs --mutate
//
// Needs no network, no database and no deploy. That is the point: the reject
// branches in api/match-intake.js are unreachable from this machine through a
// browser, and `vercel logs` on this project shows request lines only, so a
// guard that is only "read carefully" is a guard that has never run.
//
// The headline check is the one that would otherwise bite in production: the
// 25 service names are written out twice -- once in the API and once inline in
// public/match/index.html, because a static page cannot import from a
// serverless function. If they ever drift, a homeowner taps a tile and the
// server answers "Pick what you need help with" about a choice they just made.
// Two places judging the same data need a test that asserts they agree.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const PAGE = join(root, "public/match/index.html");

const { SERVICES, URGENCIES, validate, normalizePhone, summarize, scrub } =
  await import(join(root, "api/match-intake.js"));

let pass = 0;
const fails = [];
function ok(label, cond, extra = "") {
  if (cond) { pass++; return true; }
  fails.push(label + (extra ? ` — ${extra}` : ""));
  return false;
}

// Parse the page's own arrays out of the HTML rather than re-typing them here.
// Re-typing would make this file a third copy to drift.
function arrayFromPage(html, name) {
  const m = html.match(new RegExp(`const ${name}\\s*=\\s*(\\[[\\s\\S]*?\\]);`));
  if (!m) return null;
  return JSON.parse(m[1].replace(/,(\s*\])/g, "$1"));
}

function run(html) {
  pass = 0;
  fails.length = 0;

  // ── the drift check ──────────────────────────────────────────────────────
  const pageServices = arrayFromPage(html, "SERVICES");
  const pageUrgencies = arrayFromPage(html, "URGENCIES");

  if (ok("page declares a SERVICES array", Array.isArray(pageServices))) {
    ok(
      "page SERVICES is byte-identical to the API's",
      JSON.stringify(pageServices) === JSON.stringify(SERVICES),
      `page has ${pageServices.length}, api has ${SERVICES.length}; ` +
        `only in page: ${JSON.stringify(pageServices.filter((s) => !SERVICES.includes(s)))}; ` +
        `only in api: ${JSON.stringify(SERVICES.filter((s) => !pageServices.includes(s)))}`
    );
    // Every tile must survive validate(). The equality check above should
    // imply this, but asserting the real behaviour costs nothing and catches
    // a validator that rejects a name both lists happen to share.
    const rejected = pageServices.filter(
      (s) => !validate({ name: "Jo", phone: "3035550142", zip: "80205", service: s }).ok
    );
    ok("every tile on the page passes the server's validator", rejected.length === 0,
      `rejected: ${JSON.stringify(rejected)}`);
  }
  if (ok("page declares a URGENCIES array", Array.isArray(pageUrgencies))) {
    ok("page URGENCIES matches the API's",
      JSON.stringify(pageUrgencies) === JSON.stringify(URGENCIES));
  }

  // The page preselects a timeframe; if that literal drifts the select shows
  // blank and every lead arrives with no urgency.
  const preset = html.match(/\$\("urgency"\)\.value\s*=\s*"([^"]+)"/);
  ok("the preselected urgency is a real option",
    preset && URGENCIES.includes(preset[1]), preset ? preset[1] : "not found");

  // The honeypot only works if the field the server reads is the field the
  // page renders and hides.
  ok("honeypot field is named 'website' in the page", /name="website"/.test(html));
  ok("honeypot is actually hidden", /\.hp\{[^}]*left:-9999px/.test(html));
  ok("a filled honeypot is rejected",
    validate({ name: "Jo", phone: "3035550142", zip: "80205", service: "Roofing", website: "x" }).ok === false);
  ok("a honeypot rejection is silent (bot gets a 200, not a hint)",
    validate({ website: "x" }).silent === true);

  // ── phone normalisation ──────────────────────────────────────────────────
  ok("10 digits -> E.164", normalizePhone("(303) 555-0142") === "+13035550142");
  ok("leading 1 -> E.164", normalizePhone("1-303-555-0142") === "+13035550142");
  ok("9 digits is rejected, not padded", normalizePhone("303555014") === "");
  ok("empty is rejected", normalizePhone("") === "");
  ok("letters are rejected", normalizePhone("call me") === "");

  // ── reject branches, one per field ───────────────────────────────────────
  const good = { name: "Jo", phone: "3035550142", zip: "80205", service: "Roofing", urgency: "This week" };
  ok("a complete submission is accepted", validate(good).ok === true);

  const bad = [
    ["no name", { ...good, name: "" }, "name"],
    ["one-letter name", { ...good, name: "J" }, "name"],
    ["no phone", { ...good, phone: "" }, "phone"],
    ["short phone", { ...good, phone: "30355501" }, "phone"],
    ["no service", { ...good, service: "" }, "service"],
    ["a service we do not list", { ...good, service: "Crypto consulting" }, "service"],
    ["no zip", { ...good, zip: "" }, "zip"],
    ["4-digit zip", { ...good, zip: "8020" }, "zip"],
    ["zip with letters", { ...good, zip: "8020A" }, "zip"],
    ["an urgency we do not list", { ...good, urgency: "whenever" }, "urgency"],
    ["an over-long essay in details", { ...good, details: "x".repeat(601) }, "details"],
    ["an over-long name", { ...good, name: "x".repeat(81) }, "name"],
  ];
  for (const [label, body, field] of bad) {
    const v = validate(body);
    ok(`rejects ${label}`, v.ok === false && v.field === field,
      `got ok=${v.ok} field=${v.field}`);
  }

  // A rejection that doesn't say what to fix is how a form becomes unusable.
  ok("every rejection carries a human-readable message",
    bad.every(([, body]) => {
      const v = validate(body);
      return typeof v.error === "string" && v.error.length > 12 && /[a-z]/.test(v.error);
    }));

  // Never reflect submitted text into an error string -- that is the habit
  // that keeps a rendered error from becoming an injection point.
  const reflect = validate({ ...good, service: "<img src=x onerror=alert(1)>" });
  ok("a rejection never echoes the submitted value", !reflect.error.includes("<img"));

  // ── the alert text ───────────────────────────────────────────────────────
  const lead = validate({ ...good, details: "Rusted at the base", referred_by: "Stauss Inspections" }).lead;
  const text = summarize(lead);
  for (const must of ["Roofing", "80205", "Jo", "+13035550142", "This week", "Rusted at the base", "Stauss Inspections"]) {
    ok(`the alert text contains "${must}"`, text.includes(must));
  }
  // Test the sentence, not just the fields: the notification is the whole
  // product and it has to be readable on a lock screen.
  ok("the alert tells him what to actually do", /CALL THEM BACK/.test(text));
  ok("the alert fits a lock screen (under 320 chars)", text.length < 320, `${text.length} chars`);

  // ── the scrubber on the public failure reason ────────────────────────────
  // The reason a channel failed is returned to an anonymous caller, so it is
  // only safe if it carries the SHAPE of the error and none of the contents.
  ok("an address is removed", !scrub("550 no mailbox for andrew3333422@gmail.com").includes("@gmail"));
  ok("a phone number is removed", !scrub("to=+13035550142 unreachable").includes("3035550142"));
  ok("an API key is removed", !scrub("bad key re_8Xq2VbNm4PkZ").includes("re_8Xq2VbNm4PkZ"));
  ok("the useful part survives", /ENOTFOUND/.test(scrub("ENOTFOUND api.resend.com")));
  ok("the reason is capped", scrub("x".repeat(900)).length <= 180);
  ok("a missing reason does not become 'undefined'", scrub(undefined) === "unknown");

  // ── the page's own promises ──────────────────────────────────────────────
  // Copy expires when features change, and these two sentences are the offer.
  ok("the page says it is free to the homeowner", /free/i.test(html));
  ok("the page explains who pays instead", /paid by the contractor/i.test(html));
  ok("the page handles the 502 path instead of claiming success",
    /if \(!r\.ok\)/.test(html) && /Try again/.test(html));
  ok("the page posts to the endpoint that exists", html.includes('"/api/match-intake"'));

  // No invented proof. We have zero contractors and zero past customers today,
  // so any count or testimonial on this page would be a fabrication.
  const bragging = html.match(/\b(\d[\d,]{2,})\s*(homeowners|customers|contractors|pros|jobs|reviews)\b/i);
  ok("the page makes no numeric claim we cannot back", !bragging, bragging && bragging[0]);
  ok("the page does not claim contractors are vetted or screened",
    !/\b(vetted|pre-?screened|background-?checked)\b/i.test(html));

  return { pass, fails: [...fails] };
}

const html = readFileSync(PAGE, "utf8");
const first = run(html);

console.log(`${first.pass} assertions passed, ${first.fails.length} failed`);
for (const f of first.fails) console.log("  FAIL:", f);

if (!process.argv.includes("--mutate")) {
  process.exit(first.fails.length ? 1 : 0);
}

// ── mutations ──────────────────────────────────────────────────────────────
// Break one thing in the PAGE and prove the suite notices. A mutation whose
// anchor has gone missing is reported STALE, never counted as caught.
const MUTATIONS = [
  ["drop a service from the page's list", '"Locksmith",', ""],
  ["rename a service in the page only", '"Garage door"', '"Garage doors"'],
  ["add a service the server will reject", '"Something else"', '"Something else","Pool cleaning"'],
  ["preselect an urgency that does not exist", '$("urgency").value = "This week"', '$("urgency").value = "Soon"'],
  ["rename the honeypot field", 'name="website"', 'name="url"'],
  ["make the honeypot visible", "left:-9999px;", "left:0;"],
  ["invent social proof", "<h1>What needs fixing?</h1>", "<h1>Trusted by 4,200 homeowners</h1>"],
  ["claim the contractors are vetted", "local pros", "vetted local pros"],
  ["delete the who-pays sentence", "paid by the contractor only", "funded differently"],
  ["point the form at the wrong endpoint", '"/api/match-intake"', '"/api/lead-submit"'],
  ["treat a 502 as a success", "if (!r.ok) {", "if (false) {"],
];

console.log("\n--- mutation tests: break the page, prove the suite notices ---");
let caught = 0, stale = 0;
for (const [label, find, replace] of MUTATIONS) {
  if (!html.includes(find)) {
    console.log(`  STALE  ${label}: anchor ${JSON.stringify(find)} not in the page`);
    stale++;
    continue;
  }
  let r;
  try {
    r = run(html.replace(find, replace));
  } catch (e) {
    r = { fails: [`suite threw ${e.message}`] };
  }
  if (r.fails.length) {
    caught++;
    console.log(`  caught ${label}  ->  ${r.fails[0]}`);
  } else {
    console.log(`  MISSED ${label}  <-- blind spot`);
  }
}
console.log(`\n${caught} of ${MUTATIONS.length} mutations caught, ${stale} stale`);

// Re-run clean at the end: a mutation that leaked state would make the first
// result above a lie.
const again = run(readFileSync(PAGE, "utf8"));
const clean = again.pass === first.pass && again.fails.length === first.fails.length;
console.log(clean ? "re-ran clean: same result" : "WARNING: suite is not idempotent");

process.exit(first.fails.length === 0 && caught === MUTATIONS.length && stale === 0 && clean ? 0 : 1);
