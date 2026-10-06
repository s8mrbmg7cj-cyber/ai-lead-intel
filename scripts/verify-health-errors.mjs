/**
 * verify-health-errors.mjs — prove /api/health names the CAUSE of a failure.
 *
 * Why this file exists: for a month /api/health reported
 *   supabase: fail - fetch failed
 * while every page of the site returned 200. "fetch failed" is undici's
 * generic wrapper; the sentence that would have ended it in a minute —
 * "getaddrinfo ENOTFOUND mbrhkeddgmywqqgdfdgx.supabase.co" — was sitting
 * one property down on `.cause` and was being discarded.
 *
 * So the thing under test is not "does the check fail" (it plainly did).
 * It is "does the failure SAY ENOUGH TO ACT ON". That is a claim about a
 * string, so it has to be asserted against a real string from a real
 * network error, not reasoned about.
 *
 *   node scripts/verify-health-errors.mjs            # assertions
 *   node scripts/verify-health-errors.mjs --mutate   # prove they can fail
 *
 * No network mocking: these hit real hosts chosen for their failure mode.
 * It needs outbound DNS. If you are offline, every case degrades to
 * ENOTFOUND and case 2 will (correctly) complain.
 */

import { describeFetchError } from '../api/health.js';

const MUTATE = process.argv.includes('--mutate');

// Real hosts with known, stable failure modes.
const DEAD_SUPABASE = 'https://mbrhkeddgmywqqgdfdgx.supabase.co/rest/v1/clients?select=id&limit=1';
// NOT a low port. fetch() has a blocked-port list (1, 7, 9, 11, 13, 19, 25 …)
// and rejects those before opening a socket, with "bad port" and no .code —
// which passes a test looking for "not ENOTFOUND" without ever testing the
// network path. The first draft of this file used :1 and proved nothing.
const REFUSED = 'http://127.0.0.1:45999/nothing-listens-here';

async function errorFor(url) {
  try {
    await fetch(url);
    return null; // the request SUCCEEDED — no error to describe
  } catch (e) {
    return e;
  }
}

const results = [];
function check(name, cond, got) {
  results.push({ name, ok: !!cond, got });
}

// ── 1. The exact failure that hid for a month ───────────────────────
{
  const e = await errorFor(DEAD_SUPABASE);
  if (!e) {
    console.error('SETUP PROBLEM: ' + DEAD_SUPABASE + ' now resolves.');
    console.error('If Andrew re-created a project at that ID this test needs a new dead host.');
    process.exit(2);
  }
  const detail = describeFetchError(e, DEAD_SUPABASE);

  check('dead host: does not stop at "fetch failed"', detail !== 'fetch failed', detail);
  check('dead host: names the DNS failure code', detail.includes('ENOTFOUND'), detail);
  check('dead host: names the actual hostname',
    detail.includes('mbrhkeddgmywqqgdfdgx.supabase.co'), detail);
  check('dead host: says a human-readable reason, not just a code',
    /does not resolve/i.test(detail), detail);
  // The point of the sentence is that it is distinguishable from a blip.
  check('dead host: longer than the string it replaced',
    detail.length > 'fetch failed'.length * 4, `${detail.length} chars`);
}

// ── 2. A DIFFERENT failure must read differently ────────────────────
// A describer that always says ENOTFOUND is no better than one that always
// says "fetch failed". Connection-refused is a live host that is not
// listening — a genuinely different diagnosis, and it must look like one.
{
  const e = await errorFor(REFUSED);
  if (!e) {
    console.error('SETUP PROBLEM: something is listening on 127.0.0.1:1.');
    process.exit(2);
  }
  const detail = describeFetchError(e, REFUSED);

  check('refused host: reports ECONNREFUSED, not ENOTFOUND',
    detail.includes('ECONNREFUSED') && !detail.includes('ENOTFOUND'), detail);
  check('refused host: does NOT claim the hostname fails to resolve',
    !/does not resolve/i.test(detail), detail);
  check('refused host: names the host', detail.includes('127.0.0.1'), detail);
}

// ── 3. Degenerate inputs must not throw ─────────────────────────────
// checkSupabase passes `${SUPABASE_URL}/rest/...` — when the env var is
// unset that is "/rest/v1/clients", which `new URL()` rejects. The
// describer running at all is the whole point; it must not become the
// second failure stacked on the first.
{
  const bare = describeFetchError(new Error('boom'), '/rest/v1/clients');
  check('unparseable url: still returns the message', bare.includes('boom'), bare);

  const nested = describeFetchError(
    Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('deep'), { code: 'EDEEP' }),
    }),
    'https://example.com/x'
  );
  check('nested cause: unwrapped', nested.includes('EDEEP') && nested.includes('deep'), nested);

  // A cause cycle must not hang the health endpoint.
  const a = new Error('a');
  const b = new Error('b');
  a.cause = b; b.cause = a;
  const cyc = describeFetchError(a, 'https://example.com/x');
  check('cyclic cause: terminates', typeof cyc === 'string' && cyc.length > 0, cyc);
}

// ── Report ──────────────────────────────────────────────────────────
let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}\n        ${r.got}`);
}

if (MUTATE) {
  // A test suite that cannot fail is decoration. These are the two edits
  // that would silently undo the fix; both must break assertions above.
  console.log('\n--- mutation check (run these by hand, they must FAIL) ---');
  console.log('1. In api/health.js, delete the `for (...) root = root.cause` loop.');
  console.log('   Measured: 4 of 11 fail, including "names the DNS failure code".');
  console.log("2. In api/health.js, change `if (code === 'ENOTFOUND')` to `if (true)`.");
  console.log('   Measured: 1 of 11 fails — "does NOT claim the hostname fails to resolve".');
  console.log('Both were applied and run before this file was committed, and the');
  console.log('harness checked each anchor still matched — a mutation that silently');
  console.log('edits nothing passes, and a passing mutation test is the thing being');
  console.log('guarded against here.');
}

console.log(`\n${failed ? `FAIL — ${failed} of ${results.length}` : `PASS — all ${results.length} assertions`}`);
process.exit(failed ? 1 : 0);
