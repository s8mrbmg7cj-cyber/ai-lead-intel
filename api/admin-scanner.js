/*!
 * AI Lead Intel — Admin AI Scanner
 *
 * POST /api/admin-scanner
 *   body: { website, industry, notes }
 *   → streams JSON chunks of Claude analysis
 *
 * Uses Anthropic Claude to do real AI analysis of a business.
 * Admin-only — requires admin_session cookie.
 */

import { requireAdmin } from '../lib/auth.js';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-opus-4-5'; // Best for analysis. Fast variant: 'claude-haiku-4-5'

// ============================================================
// SYSTEM PROMPT
// ============================================================
const SYSTEM_PROMPT = `You are an expert AI business consultant specializing in lead generation, customer acquisition, and revenue recovery for local service businesses (HVAC, plumbing, landscaping, self-storage, roofing, electricians, etc.).

You are auditing a business to find specific, actionable revenue opportunities. Be direct, specific, and quantitative wherever possible. Avoid generic advice.

Your output must be valid JSON matching this exact schema:

{
  "score": <0-100, where 100 = fully optimized, lower = more opportunity>,
  "summary": "<2-3 sentence executive summary>",
  "findings": [
    {
      "area": "<one of: Missed Revenue Opportunities, Slow Response Problems, Lead Conversion Problems, Review Problems, Missed Call Problems, SEO Problems, Advertising Problems, Competitive Weaknesses>",
      "severity": "<high | med | low | good>",
      "title": "<short, specific problem>",
      "detail": "<2-4 sentences explaining the issue with concrete numbers where possible>",
      "impact": "<high | med | low>",
      "estimated_monthly_loss": <number in USD>
    }
  ],
  "wins": {
    "quick": [
      { "title": "<title>", "detail": "<1-2 sentences>", "effort": "Low", "timeline": "<e.g. '5-7 days'>" }
    ],
    "medium": [
      { "title": "<title>", "detail": "<1-2 sentences>", "effort": "Medium", "timeline": "<e.g. '2-4 weeks'>" }
    ],
    "major": [
      { "title": "<title>", "detail": "<1-2 sentences>", "effort": "High", "timeline": "<e.g. '6-10 weeks'>" }
    ]
  },
  "estimate": {
    "monthly_low": <number>,
    "monthly_high": <number>,
    "annual_low": <number>,
    "annual_high": <number>
  },
  "talking_points": [
    "<3-5 specific things to say on a sales call with this business>"
  ]
}

Rules:
- Cover ALL 8 problem areas in findings — even if some are "good"
- Be specific: use dollar amounts, percentages, timeframes
- Estimates should be realistic for a small/medium local business ($500-$15,000/month opportunity ranges)
- 3 quick wins, 3 medium wins, 3 major wins
- Quick wins must be deployable in days, not weeks
- talking_points should sound like a consultant who already understands this specific business
- Return ONLY the JSON. No preamble, no markdown code fences, no explanation.`;

// ============================================================
// HANDLER
// ============================================================
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!requireAdmin(req, res)) return;

  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  }

  // Parse body
  let body = req.body || {};
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (_) { body = {}; }
  }

  const website = String(body.website || '').slice(0, 500).trim();
  const industry = String(body.industry || '').slice(0, 100).trim();
  const notes = String(body.notes || '').slice(0, 2000).trim();

  if (!website) {
    return res.status(400).json({ error: 'website is required' });
  }

  // Build user prompt
  const userPrompt = `Audit this local service business:

**Website:** ${website}
**Industry:** ${industry || 'Unknown — infer from website'}
**Additional context from sales team:**
${notes || '(none provided)'}

Run a complete audit covering all 8 problem areas. Be specific, quantitative, and assume this business currently has NO AI receptionist or modern lead capture system. Identify what they're losing and what wins are available.

Return only the JSON object.`;

  // ============================================================
  // STREAMING SETUP
  // ============================================================
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');

  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4000,
        stream: true,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text().catch(() => '');
      console.error('[admin-scanner] Anthropic API error:', anthropicRes.status, errText);
      res.write(JSON.stringify({ error: `Anthropic API ${anthropicRes.status}`, detail: errText.slice(0, 500) }));
      return res.end();
    }

    // ============================================================
    // STREAM ANTHROPIC SSE → CLIENT
    // We extract text deltas and forward them as a raw text stream.
    // Client reassembles the full text and parses JSON at the end.
    // ============================================================
    const reader = anthropicRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (!payload || payload === '[DONE]') continue;

        try {
          const event = JSON.parse(payload);
          if (event.type === 'content_block_delta' && event.delta && event.delta.text) {
            res.write(event.delta.text);
          } else if (event.type === 'message_stop') {
            // Done
          } else if (event.type === 'error') {
            console.error('[admin-scanner] stream error event:', event);
            res.write('\n__ERROR__:' + JSON.stringify(event));
          }
        } catch (e) {
          // skip malformed events
        }
      }
    }

    res.end();
  } catch (err) {
    console.error('[admin-scanner] fatal:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Scanner failed', message: err.message });
    } else {
      res.write('\n__ERROR__:' + JSON.stringify({ message: err.message }));
      res.end();
    }
  }
}
