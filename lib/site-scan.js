// =====================================================================
//  lib/site-scan.js  —  AI Lead Intel   (ESM)
//
//  Reads a customer's own website and turns it into a short factual brief
//  the AI receptionist can use on calls — services, hours, service area,
//  pricing, brands, financing, and so on.
//
//  WHY: customers type three words into "what services do you offer" and
//  their website already lists forty. Scanning the site means the receptionist
//  knows the business better than the onboarding form ever captured, with no
//  extra work from the customer.
//
//  Uses ANTHROPIC_API_KEY (already set — same key lib/analyzer.js uses).
//  If the key is missing, the site is unreachable, or anything else goes
//  wrong, this returns null and the caller carries on without it. Enriching
//  the prompt must never be able to block provisioning.
//
//  SECURITY — this fetches a URL supplied by a customer, so it is a classic
//  SSRF sink. Anything that would let a caller point us at internal
//  infrastructure is refused:
//    - http/https only (no file:, gopher:, data:, ftp:)
//    - no localhost / private / link-local / loopback hosts, incl. the cloud
//      metadata address 169.254.169.254
//    - redirects are followed manually so EVERY hop is re-validated (a public
//      URL that 302s to 127.0.0.1 is the standard bypass)
//    - hard caps on time and bytes so a slow or enormous page can't hang us
// =====================================================================

const MAX_BYTES = 400_000;      // ~400KB of HTML is plenty for any small-biz site
const FETCH_TIMEOUT_MS = 8000;  // per request
const MAX_REDIRECTS = 3;
const MAX_TEXT_CHARS = 14_000;  // what we hand to the model

// Hosts that must never be fetched, however the URL is dressed up.
function isBlockedHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.home.arpa')) return true;
  // IPv6 loopback / unique-local / link-local
  if (h === '::1' || h === '::' ) return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(h)) return true;
  if (/^fe80:/i.test(h)) return true;
  // IPv4-mapped IPv6, e.g. ::ffff:127.0.0.1
  const mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  const ipv4 = mapped ? mapped[1] : h;
  const m = ipv4.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (m.some((p, i) => i > 0 && Number(p) > 255)) return true;
    if (a === 0 || a === 10 || a === 127) return true;          // this-network, private, loopback
    if (a === 169 && b === 254) return true;                    // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;           // private
    if (a === 192 && b === 168) return true;                    // private
    if (a === 100 && b >= 64 && b <= 127) return true;          // carrier-grade NAT
    if (a >= 224) return true;                                  // multicast / reserved
  }
  return false;
}

// Accepts what a customer actually types ("acmehvac.com", "www.acmehvac.com/").
export function normalizeSiteUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (isBlockedHost(u.hostname)) return null;
  // Must look like a real domain, not a bare hostname on the local network.
  if (!/\.[a-z]{2,}$/i.test(u.hostname)) return null;
  return u.toString();
}

// Fetch with manual redirect handling so every hop gets re-validated.
async function safeFetch(startUrl) {
  let url = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(url, {
        redirect: 'manual',
        signal: ctrl.signal,
        headers: {
          // Identify honestly. Some hosts block unknown agents outright.
          'User-Agent': 'AILeadIntelBot/1.0 (+https://aileadintel.com)',
          'Accept': 'text/html,application/xhtml+xml',
        },
      });
    } finally {
      clearTimeout(timer);
    }

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return null;
      const next = new URL(loc, url);
      if (next.protocol !== 'http:' && next.protocol !== 'https:') return null;
      if (isBlockedHost(next.hostname)) return null;   // the SSRF bypass, blocked
      url = next.toString();
      continue;
    }

    if (!res.ok) return null;
    const type = res.headers.get('content-type') || '';
    if (!/text\/html|application\/xhtml/i.test(type)) return null;

    // Read with a byte cap so a huge page can't exhaust memory.
    const reader = res.body?.getReader?.();
    if (!reader) {
      const txt = await res.text();
      return txt.slice(0, MAX_BYTES);
    }
    const chunks = [];
    let total = 0;
    while (total < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      chunks.push(value);
    }
    try { await reader.cancel(); } catch { /* already closed */ }
    return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8').slice(0, MAX_BYTES);
  }
  return null;
}

// Strip a page down to readable text. Scripts/styles/nav noise removed.
export function htmlToText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#0?39;|&apos;/gi, "'")
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim()
    .slice(0, MAX_TEXT_CHARS);
}

/**
 * Scan a business website and return a short factual brief, or null.
 * Never throws — provisioning must not fail because someone's site is down.
 *
 * @returns {Promise<string|null>} plain-text brief to append to the AI prompt
 */
export async function scanBusinessSite(rawUrl, { businessName = '', env = process.env } = {}) {
  const url = normalizeSiteUrl(rawUrl);
  if (!url) return null;

  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log('[site-scan] skipped — no ANTHROPIC_API_KEY');
    return null;
  }

  let text;
  try {
    const html = await safeFetch(url);
    text = htmlToText(html);
  } catch (err) {
    console.log('[site-scan] fetch failed for', url, '—', err.message);
    return null;
  }
  // Too little content to be worth a model call (JS-only site, parked domain).
  if (!text || text.length < 200) {
    console.log('[site-scan] not enough readable text at', url);
    return null;
  }

  const prompt = `Below is the text of the website for a business${businessName ? ` called "${businessName}"` : ''}.

Extract ONLY facts that a phone receptionist would need. Write them as short plain-line bullets under these headings, and OMIT any heading the site does not clearly state:
Services:
Brands / equipment:
Service area:
Hours:
Pricing / fees:
Financing or offers:
Booking / scheduling notes:
Other useful facts:

Hard rules:
- Use ONLY what the page actually says. Never guess, infer, or fill gaps with typical industry knowledge.
- If the site says almost nothing useful, reply with exactly: NONE
- No marketing language, no adjectives, no sales copy. Facts only.
- Keep the whole thing under 250 words.

WEBSITE TEXT:
${text}`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: env.CLAUDE_MODEL || 'claude-sonnet-4-6',
        max_tokens: 700,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) {
      console.log('[site-scan] Claude error', res.status);
      return null;
    }
    const data = await res.json();
    const out = (data?.content?.[0]?.text || '').trim();
    if (!out || /^NONE$/i.test(out)) return null;
    return out;
  } catch (err) {
    console.log('[site-scan] Claude call failed:', err.message);
    return null;
  }
}
