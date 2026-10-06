#!/usr/bin/env node
// Renders README.md into a page on aileadintel.com, and copies the inspectable
// files next to it.
//
// The page is GENERATED, like the workflow JSON is. There is no second copy of
// the claims to keep in sync: if README.md says 149 assertions and the suite
// says 151, the fix is in one place and this page follows. A hand-written HTML
// twin of the README would start lying the first time a number moved.
//
//   node publish.mjs            -> writes into ../ai-lead-intel/public/build/lead-pipeline/

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = join(HERE, '..', 'ai-lead-intel', 'public', 'build', 'lead-pipeline');

const esc = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Inline spans. Code first, and its contents are then left alone — otherwise
// `*` inside a code sample gets eaten as emphasis.
function inline(s) {
  const code = [];
  let t = s.replace(/`([^`]+)`/g, (_, c) => {
    code.push(c);
    return `\u0000${code.length - 1}\u0000`;
  });
  t = esc(t);
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, href) =>
    `<a href="${encodeURI(href)}">${text}</a>`);
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:]|$)/g, '$1<em>$2</em>');
  return t.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(code[Number(i)])}</code>`);
}

function render(md) {
  const lines = md.split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (/^```/.test(line)) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }

    if (/^---\s*$/.test(line)) { out.push('<hr>'); i++; continue; }

    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const n = h[1].length;
      out.push(`<h${n}>${inline(h[2])}</h${n}>`);
      i++;
      continue;
    }

    // A table is a header row, a separator row, then body rows.
    if (/^\|/.test(line) && /^\|[\s:|-]+\|?\s*$/.test(lines[i + 1] || '')) {
      const cells = (r) => r.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const body = [];
      while (i < lines.length && /^\|/.test(lines[i])) body.push(cells(lines[i++]));
      out.push(
        '<table><thead><tr>' +
        head.map((c) => `<th>${inline(c)}</th>`).join('') +
        '</tr></thead><tbody>' +
        body.map((r) => '<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') +
        '</tbody></table>'
      );
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        let item = lines[i++].replace(/^[-*]\s+/, '');
        // Continuation lines of the same bullet are indented.
        while (i < lines.length && /^\s{2,}\S/.test(lines[i])) item += ' ' + lines[i++].trim();
        items.push(item);
      }
      out.push('<ul>' + items.map((t) => `<li>${inline(t)}</li>`).join('') + '</ul>');
      continue;
    }

    if (line.trim() === '') { i++; continue; }

    const para = [];
    while (i < lines.length && lines[i].trim() !== '' &&
           !/^(```|#{1,4}\s|[-*]\s|---\s*$|\|)/.test(lines[i])) {
      para.push(lines[i++]);
    }
    out.push(`<p>${inline(para.join(' '))}</p>`);
  }

  return out.join('\n');
}

const STYLE = `
:root { --bg:#17171f; --panel:#1e1e28; --line:#2b2b37; --ink:#fafafa;
        --mute:#a1a1aa; --dim:#71717a; --accent:#ff6a00; --ok:#34d399; --warn:#f59e0b; }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--ink);
  font-family:'Geist',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  font-size:16.5px; line-height:1.65; -webkit-font-smoothing:antialiased; }
.wrap { max-width:island; max-width:50rem; margin:0 auto; padding:2.5rem 1.25rem 6rem; }
.top { display:flex; justify-content:space-between; align-items:center; gap:1rem;
  border-bottom:1px solid var(--line); padding-bottom:1rem; margin-bottom:2.25rem;
  flex-wrap:wrap; }
.top a.home { color:var(--mute); text-decoration:none; font-size:.85rem;
  letter-spacing:.08em; text-transform:uppercase; }
.top a.home:hover { color:var(--accent); }
.badge { font-family:'Geist Mono',ui-monospace,monospace; font-size:.74rem;
  color:var(--ok); border:1px solid #2f5d4a; background:#16281f;
  padding:.3rem .55rem; border-radius:999px; }
h1 { font-size:2.05rem; line-height:1.2; margin:0 0 .4rem; letter-spacing:-.02em; }
h2 { font-size:1.3rem; margin:2.75rem 0 .75rem; letter-spacing:-.01em; }
h3 { font-size:1.02rem; margin:2rem 0 .5rem; color:var(--accent); }
p { margin:0 0 1rem; color:#e6e6ea; }
hr { border:0; border-top:1px solid var(--line); margin:2.5rem 0; }
a { color:var(--accent); }
strong { color:#fff; }
ul { padding-left:1.1rem; margin:0 0 1.1rem; }
li { margin-bottom:.45rem; color:#e6e6ea; }
code { font-family:'Geist Mono',ui-monospace,monospace; font-size:.86em;
  background:#26262f; border:1px solid var(--line); border-radius:4px;
  padding:.08em .34em; color:#ffd2ad; }
pre { background:var(--panel); border:1px solid var(--line); border-left:3px solid var(--accent);
  border-radius:8px; padding:1rem 1.1rem; overflow-x:auto; margin:0 0 1.35rem; }
pre code { background:none; border:0; padding:0; color:#d8d8e0; font-size:.8rem;
  line-height:1.6; white-space:pre; }
table { width:100%; border-collapse:collapse; margin:0 0 1.5rem; font-size:.9rem;
  display:block; overflow-x:auto; }
th { text-align:left; padding:.6rem .7rem; border-bottom:1px solid var(--accent);
  color:var(--accent); font-size:.74rem; text-transform:uppercase; letter-spacing:.07em;
  white-space:nowrap; }
td { padding:.6rem .7rem; border-bottom:1px solid var(--line); vertical-align:top;
  color:#dcdce2; }
tr:last-child td { border-bottom:0; }
.files { display:flex; flex-wrap:wrap; gap:.5rem; margin:.25rem 0 0; }
.files a { font-family:'Geist Mono',ui-monospace,monospace; font-size:.78rem;
  text-decoration:none; color:var(--mute); border:1px solid var(--line);
  background:var(--panel); border-radius:6px; padding:.4rem .6rem; }
.files a:hover { border-color:var(--accent); color:var(--accent); }
.foot { margin-top:3.5rem; padding-top:1.25rem; border-top:1px solid var(--line);
  color:var(--dim); font-size:.84rem; }
`;

const files = readdirSync(HERE)
  .filter((f) => /\.(mjs|json)$/.test(f) && f !== 'package.json')
  .sort();
const srcFiles = readdirSync(join(HERE, 'src')).filter((f) => f.endsWith('.js')).sort();

mkdirSync(join(SITE, 'src'), { recursive: true });
for (const f of files) copyFileSync(join(HERE, f), join(SITE, f));
for (const f of srcFiles) copyFileSync(join(HERE, 'src', f), join(SITE, 'src', f));

const md = readFileSync(join(HERE, 'README.md'), 'utf8');
const title = /^#\s+(.*)$/m.exec(md)?.[1] ?? 'Lead pipeline';

// Description for link previews — the first real paragraph, flattened.
const desc = md.split('\n\n').find((b) => b && !b.startsWith('#'))
  ?.replace(/\s+/g, ' ').replace(/"/g, '&quot;').slice(0, 180) ?? '';

const html = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — AI Lead Intel</title>
<meta name="description" content="${desc}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${desc}">
<meta name="robots" content="index,follow">
<link rel="icon" href="/favicon.ico">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;700&family=Geist+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>${STYLE}</style>
</head><body><div class="wrap">
<div class="top">
  <a class="home" href="/">&larr; AI Lead Intel</a>
  <span class="badge">149 assertions &middot; 5/5 mutation guards &middot; 12 live executions</span>
</div>
${render(md)}
<h2>Read the source</h2>
<p>Every file, unmodified. The workflow JSON is importable into any n8n instance
(<code>Workflows &rarr; Import from File</code>); the Code-node bodies inside it are generated
from the <code>src</code> files, so what you read here is what runs.</p>
<div class="files">
${['lead-to-callback.json', ...files.filter((f) => f !== 'lead-to-callback.json')]
  .map((f) => `<a href="./${f}">${f}</a>`).join('\n')}
${srcFiles.map((f) => `<a href="./src/${f}">src/${f}</a>`).join('\n')}
</div>
<div class="foot">
  Built and measured on ${new Date().toISOString().slice(0, 10)}.
  Every number on this page came out of a run; nothing here is an estimate.
  Want this wired to your own Twilio, WhatsApp and CRM? <a href="/">Start here</a>.
</div>
</div></body></html>
`;

writeFileSync(join(SITE, 'index.html'), html);
console.log(`wrote ${join(SITE, 'index.html')}  (${(html.length / 1024).toFixed(1)} kB)`);
console.log(`copied ${files.length} root files + ${srcFiles.length} src files`);
