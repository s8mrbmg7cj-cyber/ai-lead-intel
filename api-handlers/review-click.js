// api/review-click.js
//
// The short link inside every review text: https://aileadintel.com/r/<token>
// (rewritten to /api/review-click?token=<token> in vercel.json).
//
// Records the click, then 302s to the business's Google review page. The
// destination ALWAYS comes from the stored row — never from a query parameter —
// so this endpoint can't be used as an open redirect. The link was validated as
// https at save time and is re-checked here before it reaches a Location header.

import { sb, enc, isValidReviewLink, reportError } from '../lib/review-requests.js';

// Carriers and messaging apps pre-fetch links to scan them. Those hits are
// HEAD requests or obvious bot agents — counting them would make the
// click-through numbers we show the owner a lie.
const BOT_UA = /bot|crawler|spider|preview|scanner|curl|wget|monitor|slurp|facebookexternalhit|whatsapp|proofpoint|symantec|barracuda/i;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // The destination is a third party (Google) — don't leak our path to it.
  res.setHeader('Referrer-Policy', 'no-referrer');

  const token = String(req.query?.token || '').trim();

  // Tokens are 10 chars from a fixed alphabet — anything else is a probe.
  if (!/^[a-z2-9]{10}$/.test(token)) {
    return res.status(404).send('Link not found.');
  }

  try {
    const rows = await sb(
      `review_requests?select=id,google_review_link,clicked_at,status&click_token=eq.${enc(token)}&limit=1`
    );
    const row = Array.isArray(rows) ? rows[0] : null;

    if (!row || !isValidReviewLink(row.google_review_link)) {
      return res.status(404).send('Link not found.');
    }

    const ua = String(req.headers['user-agent'] || '');
    const isRealVisit = req.method === 'GET' && !BOT_UA.test(ua);

    if (isRealVisit && !row.clicked_at) {
      // Conditional PATCH: first real click wins, later ones are no-ops.
      //
      // 'clicked' is only ever a promotion from 'sent'. Promoting a 'failed' or
      // 'pending' row would invent a successful send in the owner's stats, and
      // promoting an 'opted_out' row would resurrect it into the active set.
      // Those rows still get clicked_at stamped — the click really happened —
      // but they keep the status that reflects what we actually did.
      const patch = { clicked_at: new Date().toISOString() };
      if (row.status === 'sent') patch.status = 'clicked';

      try {
        await sb(`review_requests?id=eq.${enc(row.id)}&clicked_at=is.null`, {
          method: 'PATCH',
          prefer: 'return=minimal',
          body: patch,
        });
      } catch (err) {
        // Never block the customer from reaching Google because our write failed.
        await reportError({ action: 'review-click/mark', error: err });
      }
    }

    res.setHeader('Location', row.google_review_link);
    return res.status(302).end();
  } catch (err) {
    await reportError({ action: 'review-click', error: err });
    return res.status(404).send('Link not found.');
  }
}
