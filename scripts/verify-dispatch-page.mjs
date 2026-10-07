// scripts/verify-dispatch-page.mjs
//
//   node scripts/verify-dispatch-page.mjs
//
// Runs public/dispatch/index.html in a REAL browser engine with a fake server,
// and reads back what actually rendered. Reading the file proves nothing about
// it: a page can parse perfectly and still throw on line one, leave a button
// unwired, or print the homeowner's phone number into a dialog.
//
// What this exists to catch, specifically:
//   * the confirm sheet showing something other than the exact text the server
//     said it would send (if those two ever diverge, Andrew approves one message
//     and contractors receive a different one);
//   * the homeowner's name or number appearing anywhere in the blast flow;
//   * a 400 from the dry run being presented as "it'll still send fine";
//   * the key being left in the address bar after load, where a screenshot or a
//     shared link would give away the ability to spend his Twilio balance.

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

let pass = 0;
let skippedKeyCheck = false;
const fails = [];
const ok = (c, label) => { if (c) pass++; else fails.push(label); };
const eq = (g, w, label) => ok(g === w, `${label}\n      got:  ${JSON.stringify(g)}\n      want: ${JSON.stringify(w)}`);

// The page the probe drives is the real file with a <script> prepended that
// replaces fetch(). Nothing in the page itself is modified.
const page = readFileSync(join(root, "public/dispatch/index.html"), "utf8");

const HOMEOWNER_NAME = "Dave Horton";
const HOMEOWNER_PHONE = "+13035550199";

// The fake server answers the two real endpoints. The blast preview it returns
// is a distinctive sentinel so the assertion below is about THIS response
// reaching the dialog, not about any string that merely looks plausible.
const SENTINEL = "SENTINEL-PREVIEW-FROM-SERVER-7741";

function harness({ dryRunStatus = 200, dryRunBody = null } = {}) {
  return `<script>
  window.__log = [];
  window.onerror = (m, f, l) => { window.__log.push("JS ERROR: " + m + " @" + l); };
  window.__posted = [];
  const LEADS = { ok: true, cache_window_hours: 12, count: 1, skipped: {},
    leads: [{ id: "L1", at: Date.now() - 4 * 60000, service: "Water heater", zip: "80205",
      name: ${JSON.stringify(HOMEOWNER_NAME)}, phone: ${JSON.stringify(HOMEOWNER_PHONE)},
      urgency: "Emergency - today", details: "rusted at the base", referred_by: "", emergency: true, usable: true }] };
  const DRY = ${dryRunBody ? JSON.stringify(dryRunBody) : JSON.stringify({
    ok: true, dryRun: true, mode: "blast", preview: SENTINEL,
    would_send_to: [{ name: "Mile High Plumbing", phone: "+13035550111" }, { name: "Rapid Rooter", phone: "+13035550222" }],
    rejected: [], sent: 0, failed: 0, results: [],
  })};
  const DRY_STATUS = ${dryRunStatus};
  window.fetch = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : null;
    if (body) window.__posted.push({ url, body });
    const j = (status, o) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });
    if (String(url).includes("dispatch-leads")) return j(200, LEADS);
    if (body && body.dryRun === true) return j(DRY_STATUS, DRY);
    return j(200, { ok: true, mode: body && body.mode, sent: 2, failed: 0, rejected: [],
      results: [{ name: "Mile High Plumbing", ok: true, sid: "SM1" }, { name: "Rapid Rooter", ok: true, sid: "SM2" }] });
  };
  // A deliberately fake key. The real one must never appear in a test file:
  // this script is committed, and the key's whole security model is that it
  // lives in one bookmark and one localStorage and nowhere in git.
  localStorage.setItem("dispatch-key", "PROBE-KEY-not-the-real-one-0000000");
  localStorage.setItem("dispatch-bench", JSON.stringify({ "Water heater": [
    { name: "Mile High Plumbing", phone: "3035550111" }, { name: "Rapid Rooter", phone: "3035550222" }] }));
  localStorage.setItem("dispatch-me", "3035550134");
  </script>`;
}

function run(extraHarness, probeBody) {
  const dir = mkdtempSync(join(tmpdir(), "dispatch-probe-"));
  const file = join(dir, "index.html");
  const probe = `<div id="PROBE" style="display:none"></div><script type="module">
    const out = [];
    const P = (k, v) => out.push(k + "=" + String(v));
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await sleep(350);
    try { ${probeBody} } catch (e) { P("PROBE_THREW", e && e.message); }
    P("jserr", (window.__log || []).join(" | ") || "none");
    document.getElementById("PROBE").textContent = out.join("\\u0001");
  </script>`;
  writeFileSync(file, extraHarness + page + probe);
  const dom = execFileSync(CHROME, [
    "--headless", "--disable-gpu", "--no-sandbox", "--virtual-time-budget=8000",
    "--dump-dom", "file://" + file,
  ], { encoding: "utf8", maxBuffer: 40 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  rmSync(dir, { recursive: true, force: true });
  const m = dom.match(/id="PROBE"[^>]*>([\s\S]*?)<\/div>/);
  if (!m) throw new Error("probe never rendered — the page's own script almost certainly threw before it ran");
  const o = {};
  for (const kv of m[1].split("\u0001")) {
    const i = kv.indexOf("=");
    if (i > 0) o[kv.slice(0, i)] = kv.slice(i + 1);
  }
  // A probe that threw halfway through leaves every later key UNDEFINED, and an
  // assertion on an undefined key is not a failure — it is a crash that reads
  // like a bug in the test. Stop here and say which key is missing instead.
  if (o.PROBE_THREW !== undefined) {
    throw new Error(`the probe threw inside the page: ${o.PROBE_THREW}\n  keys read: ${Object.keys(o).join(", ")}`);
  }
  return { probe: o, dom };
}

// ---------------------------------------------------- 1. the happy blast ----
// Tap "Text my guys", then read the confirm sheet that actually appeared.
{
  const { probe, dom } = run(harness(), `
    document.querySelector("[data-blast]").click();
    await sleep(400);
    const dlg = document.getElementById("dlg");
    P("dlgOpen", dlg.open);
    P("dlgPreview", document.getElementById("dlgP").textContent);
    P("dlgWho", document.getElementById("dlgWho").textContent);
    P("dryRunAsked", (window.__posted.filter((p) => p.body.dryRun === true)).length);
    P("realSendsBeforeConfirm", (window.__posted.filter((p) => p.body.dryRun !== true && p.body.mode)).length);
    document.getElementById("dlgG").click();
    await sleep(500);
    P("realSendsAfterConfirm", (window.__posted.filter((p) => p.body.dryRun !== true && p.body.mode)).length);
    P("res", document.getElementById("res0").textContent);
    const sent = window.__posted.filter((p) => p.body.dryRun !== true && p.body.mode === "blast");
    P("sentPayload", JSON.stringify(sent.map((s) => s.body.contractors)));
  `);

  eq(probe.jserr, "none", "the page runs with no JS error");
  eq(probe.dlgOpen, "true", "tapping the blast button opens the confirm sheet");
  eq(probe.dlgPreview, SENTINEL,
    "the sheet shows the SERVER's exact text, not a copy built in the browser");
  eq(probe.dryRunAsked, "1", "exactly one preview was requested");
  eq(probe.realSendsBeforeConfirm, "0",
    "NOTHING was sent before he pressed confirm — the preview must not be a send");
  eq(probe.realSendsAfterConfirm, "1", "confirming sent exactly once, not twice");
  ok(/sent to Mile High Plumbing/.test(probe.res), "the result line names each contractor");

  // The whole economics of the product is that the losers cannot call the
  // homeowner. Check the rendered dialog AND the outgoing payload.
  ok(!probe.dlgPreview.includes(HOMEOWNER_NAME) && !probe.dlgWho.includes(HOMEOWNER_NAME),
    "the confirm sheet does not show the homeowner's name");
  ok(!probe.dlgPreview.includes("0199") && !probe.dlgWho.includes("0199"),
    "the confirm sheet does not show the homeowner's number");
  ok(!probe.sentPayload.includes("0199"),
    "the homeowner's number is not smuggled into the contractors array");
  ok(probe.dlgWho.includes("Mile High Plumbing") && probe.dlgWho.includes("Rapid Rooter"),
    "the sheet lists who it is going to, by name");

  // The key must not survive in the URL, and must not be printed into the page.
  // The real key is read from the environment, never written here — this file
  // is committed, and the key's only protection is that it is not in git.
  // Without the env var there is nothing to search for, so this reports as a
  // skip rather than quietly counting as a pass.
  if (process.env.DISPATCH_TEST_KEY) {
    ok(!dom.includes(process.env.DISPATCH_TEST_KEY), "the live key is not hard-coded in the shipped page");
  } else {
    skippedKeyCheck = true;
  }
}

// ------------------------------------------- 2. the dry run comes back 400 --
// The commonest real failure: every number on the bench is a typo. The page
// used to say "the message will still send correctly" here, which was a lie.
{
  const { probe } = run(harness({
    dryRunStatus: 400,
    dryRunBody: { error: "No contractor on that list has a usable mobile number.",
      rejected: [{ name: "Typo Plumbing", reason: "not a dialable US mobile" }] },
  }), `
    document.querySelector("[data-blast]").click();
    await sleep(450);
    P("dlgOpen", document.getElementById("dlg").open);
    P("res", document.getElementById("res0").textContent);
    P("realSends", (window.__posted.filter((p) => p.body.dryRun !== true && p.body.mode)).length);
  `);

  eq(probe.jserr, "none", "a failed preview does not throw");
  eq(probe.dlgOpen, "false", "a failed preview does NOT open a confirm sheet");
  eq(probe.realSends, "0", "and sends nothing");
  ok(/Didn't send/.test(probe.res), "it says plainly that nothing was sent");
  ok(/usable mobile number/.test(probe.res), "AND passes the server's real reason through");
  ok(/Typo Plumbing/.test(probe.res), "naming which contractor was the problem");
  ok(!/still send correctly/.test(probe.res), "it does NOT promise the send will work anyway");
}

// ----------------------------------------------------------- 3. no key -----
{
  const { probe } = run(`<script>
    window.__log = [];
    window.onerror = (m, f, l) => { window.__log.push("JS ERROR: " + m + " @" + l); };
    window.__posted = [];
    window.fetch = async (u, o) => { window.__posted.push(String(u)); return new Response("{}", { status: 200 }); };
  </script>`, `
    P("msg", document.getElementById("msg").textContent);
    P("stat", document.getElementById("stat").textContent);
    P("fetches", (window.__posted || []).length);
  `);
  eq(probe.jserr, "none", "with no key stored the page still runs");
  eq(probe.stat, "locked", "and says it is locked");
  eq(probe.fetches, "0", "and does not call the server at all without a key");
  ok(/bookmark/i.test(probe.msg), "and tells him to open the bookmark");
}

// -------------------------------------------- 4. the key leaves the URL ----
// It cannot be tested through file:// with a query string, so assert the
// mechanism is present and shaped right, and that nothing logs it.
{
  ok(/history\.replaceState/.test(page) && /searchParams\.delete\("k"\)/.test(page),
    "the key is deleted from the address bar on load");
  ok(!/console\.(log|error|warn)\s*\([^)]*KEY/.test(page), "the key is never logged");
}

// ------------------------------------------------------- 5. the self test --
{
  const { probe } = run(harness(), `
    document.getElementById("benchBtn").click();
    await sleep(100);
    const b = document.getElementById("selftest");
    P("exists", !!b);
    b.click();
    await sleep(400);
    P("dlgOpen", document.getElementById("dlg").open);
    P("who", document.getElementById("dlgWho").textContent);
    document.getElementById("dlgG").click();
    await sleep(450);
    const sends = window.__posted.filter((p) => p.body.dryRun !== true && p.body.mode);
    P("sends", sends.length);
    P("to", JSON.stringify(sends.map((s) => s.body.contractors)));
    P("res", document.getElementById("selfres").textContent);
  `);
  eq(probe.jserr, "none", "the self test does not throw");
  eq(probe.exists, "true", "the self-test button is on the bench pane");
  eq(probe.dlgOpen, "true", "it confirms before spending a text");
  eq(probe.sends, "1", "it sends exactly one text");
  ok(probe.to.includes("3035550134"), "to HIS number, the one in the box");
  ok(!probe.to.includes("3035550111"), "and not to anyone on the bench");
  ok(/Check your phone/.test(probe.res),
    "a 200 is reported as 'Twilio accepted it, check your phone' — never as proof it arrived");
}

console.log(`\n${pass} assertions passed`);
if (skippedKeyCheck) {
  console.log("1 check SKIPPED — set DISPATCH_TEST_KEY to assert the live key is absent from the page.");
}
if (fails.length) {
  console.log(`\n${fails.length} FAILED:`);
  for (const f of fails) console.log("  ✗ " + f);
  process.exit(1);
}
console.log("PASS");
