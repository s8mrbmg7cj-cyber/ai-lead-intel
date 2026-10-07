// scripts/mutate-dispatch-page.mjs
//
//   node scripts/mutate-dispatch-page.mjs
//
// Breaks the dispatch page ON PURPOSE and checks verify-dispatch-page.mjs goes
// red. Every mutation here is a bug invisible to anyone reading the file: the
// confirm sheet quietly showing a different sentence than the one the server
// will actually send, the preview losing its dryRun flag and double-billing
// every blast, a Twilio 200 being reported to him as "delivered".
//
// Run after ANY edit to public/dispatch/index.html. A probe suite that stays
// green while the page lies is worse than no suite, because it gets cited.

import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

process.chdir(join(dirname(fileURLToPath(import.meta.url)), ".."));

const F = "public/dispatch/index.html";
const src = readFileSync(F, "utf8");
const muts = [
  ["      previewText,\n", "      `${l.service} job — ${l.zip}. First to reply YES gets the homeowner's number.`,\n",
   "dialog shows a browser-built copy instead of the server's text"],
  ['if (pstat !== 200 || !previewText) {', 'if (false) {',
   "a 400 preview falls through to a confirm sheet and a send"],
  ['(prev.would_send_to || []).map((c) => c.name).join(", ")',
   '(prev.would_send_to || []).map((c) => c.name).join(", ") + " re: " + l.name + " " + l.phone',
   "homeowner name+number printed into the confirm sheet"],
  ['callbackPhone: myPhone(), dryRun: true }),\n    });', 'callbackPhone: myPhone() }),\n    });',
   "preview call loses its dryRun flag — every blast sends twice"],
  ['body: JSON.stringify({ mode: "blast", lead: testLead, contractors, callbackPhone: me }) });',
   'body: JSON.stringify({ mode: "blast", lead: testLead, contractors: [{name:"Mile High Plumbing",phone:"3035550111"}], callbackPhone: me }) });',
   "self test texts the bench instead of himself"],
  ['? resultHtml(body) + `<div class="note" style="margin-top:6px">Twilio accepted it. Check your phone — if nothing arrives in a minute, it did not work, whatever this says.</div>`',
   '? resultHtml(body) + `<div class="y">Sent and delivered.</div>`',
   "self test claims delivery from a 200"],
];
let caught = 0; const missed = [];
for (const [from, to, label] of muts) {
  if (!src.includes(from)) { missed.push(label + "  [PATTERN NOT FOUND]"); continue; }
  writeFileSync(F, src.replace(from, to));
  let red = false;
  try { execSync("node scripts/verify-dispatch-page.mjs", { stdio: "pipe" }); } catch { red = true; }
  writeFileSync(F, src);
  if (red) { caught++; console.log("  caught: " + label); } else missed.push(label);
}
writeFileSync(F, src);
execSync("node scripts/verify-dispatch-page.mjs", { stdio: "pipe" });
console.log(`\n${caught} of ${muts.length} caught (green again after restore)`);
if (missed.length) { console.log("NOT CAUGHT:"); for (const m of missed) console.log("  ✗ " + m); process.exit(1); }
console.log("MUTATION PASS");
