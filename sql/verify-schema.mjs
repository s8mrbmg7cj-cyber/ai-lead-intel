#!/usr/bin/env node
/**
 * verify-schema.mjs — prove sql/schema.sql can actually serve this codebase.
 *
 * Parsing the SQL only proves it is grammatical. The failure that would
 * actually take the site down is a MISSING COLUMN: PostgREST answers
 * `?select=ntfy_topic` on a table without that column with a 400, and most
 * of these call sites swallow the error and carry on with empty data.
 *
 * So this script does two things:
 *   1. Parses schema.sql with Postgres's own grammar (pg-query-emscripten,
 *      the real parser compiled to WASM) and reads the column list for each
 *      table out of the parse tree — not out of a regex over the file.
 *   2. Scrapes every column name that api/ and lib/ reference per table,
 *      from PostgREST query strings (select=, filters, order=, on_conflict=)
 *      and from the JSON bodies of POST/PATCH calls, then asserts each one
 *      exists in the parsed schema.
 *
 * Run:  node sql/verify-schema.mjs
 * Exit: 0 = every referenced column exists. 1 = at least one does not.
 *
 * Requires pg-query-emscripten. This repo deliberately has no node_modules
 * (it is deployed from the Drive folder and has no .gitignore), so install
 * it anywhere and point at it:
 *
 *   mkdir -p /tmp/pgparse && cd /tmp/pgparse && npm i pg-query-emscripten
 *   PGQUERY=/tmp/pgparse/node_modules/pg-query-emscripten/index.js \
 *     node sql/verify-schema.mjs
 *
 * If it cannot be loaded the script exits 2 and says so. A skipped check
 * must never read as a passing one.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

// Tables whose columns are defined in the add-on migration, not schema.sql.
const EXTRA_SQL = ['2026-08-23-review-requests.sql'];

// PostgREST reserved words that appear where a column would, and embedded
// resources we do not model. Anything listed here is NOT checked.
const NOT_COLUMNS = new Set(['count', 'limit', 'offset', 'select', 'order', 'and', 'or', 'not']);

// Files whose database code can never run. Each needs a reason, and the
// reason gets printed — an unexplained exclusion is how a real missing
// column hides.
const SKIP = new Map([
  ['api/vapi/call-ended-backup.js',
   'handler returns 410 on line 1 of the body; the code below it is unreachable. ' +
   'It writes calls.client_id, the single-tenant column the live handler replaced ' +
   'with client_uuid — adding it back would resurrect the all-zero-reports bug.'],
]);

// ── 1. Parse the SQL with Postgres's real grammar ────────────────────

async function parsedColumns(mutate = null) {
  let init;
  const spec = process.env.PGQUERY
    ? pathToFileURL(process.env.PGQUERY).href
    : 'pg-query-emscripten';
  try {
    ({ default: init } = await import(spec));
  } catch (e) {
    console.error('SKIPPED THE PARSE STEP — pg-query-emscripten could not be loaded.');
    console.error('  ' + e.message);
    console.error('  This run proves NOTHING. See the header for the install line.');
    process.exit(2);
  }
  const pg = await init();
  const tables = new Map();

  for (const file of ['schema.sql', ...EXTRA_SQL]) {
    let sql = readFileSync(join(HERE, file), 'utf8');
    if (mutate) sql = mutate(sql, file);
    const res = pg.parse(sql);
    if (res.error) {
      console.error(`PARSE FAILED in ${file}: ${JSON.stringify(res.error)}`);
      process.exit(1);
    }
    for (const { stmt } of res.parse_tree.stmts) {
      // CREATE TABLE
      if (stmt.CreateStmt) {
        const name = stmt.CreateStmt.relation.relname;
        const cols = tables.get(name) || new Set();
        for (const el of stmt.CreateStmt.tableElts || []) {
          if (el.ColumnDef?.colname) cols.add(el.ColumnDef.colname);
        }
        tables.set(name, cols);
      }
      // ALTER TABLE ... ADD COLUMN
      if (stmt.AlterTableStmt) {
        const name = stmt.AlterTableStmt.relation.relname;
        const cols = tables.get(name) || new Set();
        for (const c of stmt.AlterTableStmt.cmds || []) {
          if (c.AlterTableCmd?.def?.ColumnDef?.colname) {
            cols.add(c.AlterTableCmd.def.ColumnDef.colname);
          }
        }
        tables.set(name, cols);
      }
    }
  }
  return tables;
}

// ── 2. Scrape what the code actually asks for ────────────────────────

function sourceFiles() {
  const out = [];
  (function walk(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js') || e.name.endsWith('.mjs')) out.push(p);
    }
  })(join(ROOT, 'api'));
  (function walk(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js') || e.name.endsWith('.mjs')) out.push(p);
    }
  })(join(ROOT, 'lib'));
  return out;
}

/**
 * Walk forward from `open` (an index pointing at a bracket) to its match,
 * skipping over string and template literals so a `)` inside a URL cannot
 * end the call early. Returns the index of the closing bracket, or -1.
 */
function matchBracket(src, open) {
  const pairs = { '(': ')', '{': '}', '[': ']' };
  const close = pairs[src[open]];
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') i++;
        i++;
      }
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (ch === src[open]) depth++;
    else if (ch === close) { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** The full text of the fetch(...) call containing index `at`, or null. */
function enclosingCall(src, at) {
  const start = src.lastIndexOf('fetch(', at);
  if (start < 0) return null;
  const open = start + 'fetch'.length;
  const end = matchBracket(src, open);
  if (end < 0 || end < at) return null;
  return src.slice(start, end + 1);
}

/**
 * The source text of the object literal a variable is declared as, with
 * `...spread` members replaced by the spread variable's own literal.
 *
 * onboarding-submit.js builds the biggest insert in the product as
 *   const insertPayload = { ...baseFields, ntfy_topic, phone_number, ... };
 * so without following the spread, 20-odd clients columns go unchecked.
 */
function objectLiteralOf(name, src, seen = new Set()) {
  if (seen.has(name)) return null;        // guard against a cycle
  seen.add(name);
  const decl = new RegExp('\\b(?:const|let|var)\\s+' + name + '\\s*=\\s*\\{').exec(src);
  if (!decl) return null;
  const brace = src.indexOf('{', decl.index);
  const end = matchBracket(src, brace);
  if (end < 0) return null;
  let obj = src.slice(brace, end + 1);
  for (const sm of [...obj.matchAll(/\.\.\.([A-Za-z_$][\w$]*)/g)]) {
    const inner = objectLiteralOf(sm[1], src, seen);
    if (inner) obj = obj.replace(sm[0], inner.slice(1, -1));
  }
  return obj;
}

/**
 * The object literal inside `body: JSON.stringify(...)`, or null.
 *
 * Handles both forms used in this codebase:
 *   JSON.stringify({ a: 1 })        — inline
 *   JSON.stringify(callData)        — a variable declared earlier in the
 *                                     same file, which is how the biggest
 *                                     payload (calls) is built. Reading
 *                                     only inline literals checked 3 of
 *                                     the calls table's 19 columns.
 */
function stringifyArg(call, src) {
  const i = call.indexOf('JSON.stringify(');
  if (i < 0) return null;
  const open = call.indexOf('(', i);
  const close = matchBracket(call, open);
  if (close < 0) return null;
  const arg = call.slice(open + 1, close).trim();

  if (arg.startsWith('{')) {
    const end = matchBracket(call, call.indexOf('{', open));
    return end < 0 ? null : call.slice(call.indexOf('{', open), end + 1);
  }
  // A bare identifier: find `const <name> = {` in the file.
  const name = /^([A-Za-z_$][\w$]*)$/.exec(arg)?.[1];
  if (!name || !src) return null;
  let obj = objectLiteralOf(name, src);

  // Not a variable? It may be the PARAMETER of a small helper, which is how
  // onboarding-submit.js writes the clients row:
  //   const insert = (payload) => fetch(..., JSON.stringify(payload));
  //   insert(insertPayload);
  // Resolve through the helper to the object actually passed in.
  if (!obj) {
    const helper = new RegExp('\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*\\(?\\s*' + name + '\\s*\\)?\\s*=>').exec(src);
    if (helper) {
      for (const cm of src.matchAll(new RegExp('\\b' + helper[1] + '\\(\\s*([A-Za-z_$][\\w$]*)\\s*\\)', 'g'))) {
        const o = objectLiteralOf(cm[1], src);
        if (o) obj = obj ? obj.slice(0, -1) + ',' + o.slice(1) : o;
      }
    }
  }
  if (!obj) return null;
  // Later `name.col = ...` assignments are columns too (call-ended.js adds
  // its lead-analysis fields that way).
  for (const am of src.matchAll(new RegExp('\\b' + name + '\\.([a-z][a-z0-9_]*)\\s*=[^=]', 'g'))) {
    obj = obj.slice(0, -1) + ',' + am[1] + ':0}';
  }
  return obj;
}

/** Keys at depth 1 of an object literal — not keys of nested objects. */
function topLevelKeys(obj) {
  const keys = [];
  let depth = 0;
  for (let i = 0; i < obj.length; i++) {
    const ch = obj[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const q = ch; i++;
      while (i < obj.length && obj[i] !== q) { if (obj[i] === '\\') i++; i++; }
      continue;
    }
    if (ch === '{' || ch === '[' || ch === '(') { depth++; continue; }
    if (ch === '}' || ch === ']' || ch === ')') { depth--; continue; }
    if (depth !== 1) continue;
    const m = /^([a-z][a-z0-9_]*)\s*:/.exec(obj.slice(i));
    if (m && !/[A-Za-z0-9_$.]/.test(obj[i - 1] || '')) { keys.push(m[1]); i += m[0].length - 1; }
  }
  return keys;
}

function referencedColumns() {
  const refs = new Map();           // table -> Map(column -> Set(file))
  const uncovered = [];             // call sites this script cannot read
  const add = (t, c, f) => {
    if (!c || NOT_COLUMNS.has(c) || !/^[a-z][a-z0-9_]*$/.test(c)) return;
    if (!refs.has(t)) refs.set(t, new Map());
    const m = refs.get(t);
    if (!m.has(c)) m.set(c, new Set());
    m.get(c).add(f);
  };

  for (const file of sourceFiles()) {
    const short = relative(ROOT, file);
    if (SKIP.has(short)) continue;
    const src = readFileSync(file, 'utf8');
    const urlVars = new Map();      // local variable name -> table
    // Dynamic table names (`rest/v1/${path}`) cannot be resolved here. Say
    // so out loud — a check that quietly skips a file reads as a pass.
    for (const dm of src.matchAll(/rest\/v1\/\$\{/g)) {
      void dm;
      uncovered.push(`${short} — table name is a variable, not checked`);
    }

    const re = /rest\/v1\/([a-z_]+)([^`"'\s]*)/g;
    let m;
    while ((m = re.exec(src))) {
      const table = m[1];
      if (table === 'rpc') continue;
      const q = m[2];

      const sel = /select=([^&`"']*)/.exec(q);
      if (sel) for (const c of sel[1].split(',')) add(table, c.replace(/\$\{[\s\S]*/, '').trim(), short);

      for (const fm of q.matchAll(/(?:\?|&)([a-z_]+)=(?:eq|neq|is|in|gt|gte|lt|lte|not|like|ilike|cs)\b/g)) add(table, fm[1], short);
      for (const om of q.matchAll(/order=([a-z_]+)/g)) add(table, om[1], short);
      for (const cm of q.matchAll(/on_conflict=([a-z_,]+)/g)) for (const c of cm[1].split(',')) add(table, c, short);

      // Write bodies: the top-level keys of the object literal passed to
      // JSON.stringify in the SAME fetch() call.
      //
      // An earlier version of this read a fixed 2,000-character window and
      // reported 13 missing columns, 11 of which were invented: it had run
      // past the end of the fetch and into the next statement, so the keys
      // of `res.json({ success, error })` were being checked as columns of
      // `clients`. The window is now the fetch call's own parentheses.
      // Half the writes build their URL into a variable first:
      //   const url = `${SUPABASE_URL}/rest/v1/calls`;
      //   await fetch(url, { method: 'POST', body: JSON.stringify(callData) })
      // so the rest/v1 literal is not inside the fetch at all. Record the
      // variable and handle those in the second pass below; reading only
      // inline URLs checked 3 of the calls table's 19 columns and still
      // printed PASS.
      const lineStart = src.lastIndexOf('\n', m.index) + 1;
      const prefix = src.slice(lineStart, m.index);
      // `const url = ...rest/v1/calls` is a URL variable.
      // `const res = await fetch(...rest/v1/x` is NOT — the open paren
      // gives it away. Without that test this swallowed the inline fetches
      // too and client_onboarding's coverage fell from 20 columns to 3.
      const decl = /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/.exec(prefix);
      if (decl && !prefix.includes('(')) { urlVars.set(decl[1], table); continue; }

      const call = enclosingCall(src, m.index);
      if (!call) continue;
      if (!/\bmethod:\s*['"](POST|PATCH|PUT)['"]/.test(call)) continue;
      const obj = stringifyArg(call, src);
      if (!obj) { uncovered.push(`${short} — ${table} write, payload not readable statically`); continue; }
      for (const key of topLevelKeys(obj)) add(table, key, short);
    }

    // Second pass: fetch(<urlVar>, { method: POST|PATCH, body: ... })
    for (const fm of src.matchAll(/fetch\(\s*([A-Za-z_$][\w$]*)\s*,/g)) {
      const table = urlVars.get(fm[1]);
      if (!table) continue;
      const end = matchBracket(src, fm.index + 'fetch'.length);
      if (end < 0) continue;
      const call = src.slice(fm.index, end + 1);
      if (!/\bmethod:\s*['"](POST|PATCH|PUT)['"]/.test(call)) continue;
      const obj = stringifyArg(call, src);
      if (!obj) { uncovered.push(`${short} — ${table} write, payload not readable statically`); continue; }
      for (const key of topLevelKeys(obj)) add(table, key, short);
    }
  }
  return { refs, uncovered: [...new Set(uncovered)] };
}

// ── 3. Compare ───────────────────────────────────────────────────────

function compare(schema, refs) {
  let checked = 0;
  const missing = [];
  const unknownTables = [];
  for (const [table, cols] of [...refs].sort()) {
    if (!schema.has(table)) { unknownTables.push(table); continue; }
    const have = schema.get(table);
    for (const [col, files] of cols) {
      checked++;
      if (!have.has(col)) missing.push({ table, col, files: [...files] });
    }
  }
  return { checked, missing, unknownTables };
}

const { refs, uncovered } = referencedColumns();

// ── Mutation tests ───────────────────────────────────────────────────
// A check that cannot fail is not a check. Each case deletes one column
// definition from schema.sql and asserts this script notices. They also
// guard the ANCHORS: if a column is renamed, the deletion silently stops
// deleting anything and the case fails loudly rather than passing empty.
const MUTATIONS = [
  ['clients', 'provision_requested_at', /^\s*provision_requested_at\s+timestamptz,\s*$/m],
  ['calls', 'client_uuid', /^\s*client_uuid\s+uuid references[^\n]*\n/m],
  ['calls', 'lead_score', /^\s*lead_score\s+integer,\s*$/m],
  ['clients', 'payment_external_id', /^\s*payment_external_id\s+text,[^\n]*$/m],
  ['phone_pool', 'vapi_phone_number_id', /^\s*vapi_phone_number_id text,\s*$/m],
  ['client_onboarding', 'offer_urgent_transfer', /^\s*offer_urgent_transfer boolean not null default false,\s*$/m],
];

if (process.argv.includes('--mutate')) {
  let failed = 0;
  for (const [table, col, anchor] of MUTATIONS) {
    const mutated = await parsedColumns((sql, file) => {
      if (file !== 'schema.sql') return sql;
      if (!anchor.test(sql)) {
        console.log(`  ANCHOR GONE  ${table}.${col} — this mutation deletes nothing. Fix the pattern.`);
        failed++;
        return sql;
      }
      return sql.replace(anchor, '');
    });
    const r = compare(mutated, refs);
    const caught = r.missing.some((x) => x.table === table && x.col === col);
    console.log(`  ${caught ? 'caught ' : 'MISSED '} drop ${table}.${col}`);
    if (!caught) failed++;
  }
  console.log('');
  console.log(failed ? `MUTATION TESTS FAILED (${failed})` : `all ${MUTATIONS.length} mutation tests caught`);
  process.exit(failed ? 1 : 0);
}

const schema = await parsedColumns();
const { checked, missing, unknownTables } = compare(schema, refs);

for (const [table, cols] of [...schema].sort()) {
  const used = refs.get(table);
  const n = used ? [...used.keys()].filter((c) => cols.has(c)).length : 0;
  console.log(`  ${table.padEnd(20)} ${String(cols.size).padStart(2)} columns defined, ${n} referenced by code`);
}

console.log('');
for (const [f, why] of SKIP) console.log(`SKIPPED ${f}\n  ${why}\n`);
if (uncovered.length) {
  console.log(`NOT CHECKED — ${uncovered.length} call site(s) this script cannot read statically:`);
  for (const u of uncovered) console.log(`  ${u}`);
  console.log('');
}
if (unknownTables.length) {
  console.log(`NOTE: code touches ${unknownTables.length} table(s) not in the schema: ${unknownTables.join(', ')}`);
}
if (missing.length) {
  console.log(`FAIL — ${missing.length} of ${checked} referenced columns do not exist:\n`);
  for (const r of missing) console.log(`  ${r.table}.${r.col}   (${r.files.join(', ')})`);
  process.exit(1);
}
console.log(`PASS — all ${checked} column references across ${refs.size} tables exist in the schema.`);
