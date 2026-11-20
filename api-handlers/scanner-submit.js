/*!
 * AI Lead Intel — Public Scanner Submit
 *
 * POST /api/scanner-submit
 *   body: { business_name, website, owner_name, email, phone, industry }
 *   → 200 { findings, score, wins, estimated_revenue }
 *
 * Generates templated findings based on inputs (no AI cost).
 * Saves lead to Supabase + emails Andrew at hello@aileadintel.com.
 */

import { rateLimit, getClientIp } from '../lib/rate-limit.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY;
const RESEND_KEY = process.env.RESEND_API_KEY;
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'hello@aileadintel.com';

// ============================================================
// INDUSTRY-AWARE TEMPLATED FINDINGS
// Each finding has: id, area, severity (high|med|low|good), title, detail, impact
// ============================================================
function generateFindings(input) {
  const findings = [];
  const industry = (input.industry || '').toLowerCase();

  // ---- Missed Call Problems ----
  findings.push({
    id: 'missed_calls',
    area: 'Missed Call Problems',
    severity: 'high',
    title: 'Likely losing 30-50% of inbound calls',
    detail: `Service businesses in ${input.industry || 'your industry'} typically miss 30-50% of inbound calls during peak hours and after-hours. Each missed call has a 78% chance of going to a competitor within 60 seconds.`,
    impact: 'high',
    estimated_loss_low: 2400,
    estimated_loss_high: 8400,
  });

  // ---- Slow Response Problems ----
  findings.push({
    id: 'slow_response',
    area: 'Slow Response Problems',
    severity: 'high',
    title: 'Response time gap vs. lead expectations',
    detail: 'Leads expect a response within 5 minutes. The industry average is 47 hours. If a competitor responds first, your conversion rate drops by 7x. Most local businesses lose qualified leads here without realizing it.',
    impact: 'high',
    estimated_loss_low: 1800,
    estimated_loss_high: 6200,
  });

  // ---- Lead Conversion Problems ----
  findings.push({
    id: 'lead_conversion',
    area: 'Lead Conversion Problems',
    severity: 'med',
    title: 'No structured lead capture from voice calls',
    detail: 'Inbound calls likely lack a consistent qualification process. Name, contact, service needed, and urgency aren\'t captured systematically, making follow-up inefficient and conversion-rate visibility impossible.',
    impact: 'med',
    estimated_loss_low: 900,
    estimated_loss_high: 3200,
  });

  // ---- Review Problems ----
  findings.push({
    id: 'reviews',
    area: 'Review Problems',
    severity: 'med',
    title: 'Inconsistent review acquisition',
    detail: 'Without an automated post-job review request system, you\'re likely missing 70-80% of happy customer reviews. Each review increases conversion rate by ~5%. Competitors with 100+ reviews dominate map pack visibility.',
    impact: 'med',
    estimated_loss_low: 1200,
    estimated_loss_high: 4000,
  });

  // ---- SEO Problems ----
  findings.push({
    id: 'seo',
    area: 'SEO Problems',
    severity: 'med',
    title: 'Local SEO underleveraged',
    detail: `Google Business Profile optimization and local citations drive 40%+ of leads in ${input.industry || 'service businesses'}. Most owners have a profile but haven\'t optimized service categories, photos, posts, or review cadence.`,
    impact: 'med',
    estimated_loss_low: 800,
    estimated_loss_high: 3500,
  });

  // ---- Advertising Problems ----
  findings.push({
    id: 'advertising',
    area: 'Advertising Problems',
    severity: 'med',
    title: 'Ad spend without call recovery',
    detail: 'If you run Google/Meta ads, every missed call from a paid lead is wasted spend. Recovery rate without AI receptionist: ~0%. With AI answering: ~85% lead recovery from paid traffic.',
    impact: 'med',
    estimated_loss_low: 1500,
    estimated_loss_high: 5000,
  });

  // ---- Competitive Weaknesses ----
  findings.push({
    id: 'competitive',
    area: 'Competitive Weaknesses',
    severity: 'high',
    title: 'Competitors with 24/7 answering will outflank you',
    detail: 'In every local market, 1-2 competitors are deploying AI answering or live operators. They will pick up calls you miss, especially nights, weekends, and during busy periods. The first business to answer wins ~70% of jobs.',
    impact: 'high',
    estimated_loss_low: 3000,
    estimated_loss_high: 9500,
  });

  // ---- Missed Revenue Opportunities (summary) ----
  findings.push({
    id: 'revenue_opp',
    area: 'Missed Revenue Opportunities',
    severity: 'high',
    title: 'After-hours and weekend leads going to voicemail',
    detail: 'Roughly 40-60% of service calls come outside business hours. Voicemail captures less than 18% of those callers. A 24/7 AI receptionist captures 95%+, converting dead time into booked jobs.',
    impact: 'high',
    estimated_loss_low: 2500,
    estimated_loss_high: 7800,
  });

  return findings;
}

function computeScore(findings) {
  // Lower score = bigger opportunity = more revenue you're leaving on the table
  // Score 0-100 where 100 = optimized, 0 = catastrophic
  const high = findings.filter(f => f.severity === 'high').length;
  const med = findings.filter(f => f.severity === 'med').length;
  const low = findings.filter(f => f.severity === 'low').length;
  const score = Math.max(15, 95 - (high * 11) - (med * 5) - (low * 2));
  return Math.round(score);
}

function generateWins(findings) {
  return {
    quick: [
      { title: '24/7 AI Receptionist (Day 1 impact)', detail: 'Deploy Riley to answer every call. Recovers ~85% of missed leads immediately.', effort: 'Low', timeline: '5-7 days' },
      { title: 'Automated missed-call text-back', detail: 'Every unanswered call triggers an SMS to the caller within 60 seconds. Recaptures cold leads.', effort: 'Low', timeline: 'Same day' },
      { title: 'Lead summary emails after every call', detail: 'AI emails you a clean summary the moment a call ends. Zero phone tag, zero missed details.', effort: 'Low', timeline: 'Automatic' },
    ],
    medium: [
      { title: 'Automated review request flow', detail: 'AI sends review requests via SMS after every booked job. Targets a 5-star average and 10+ new reviews per month.', effort: 'Medium', timeline: '2-3 weeks' },
      { title: 'Lead qualification + hot lead routing', detail: 'AI scores leads by urgency. Hot leads route directly to your phone; cold leads schedule callbacks. Cuts response time to seconds.', effort: 'Medium', timeline: '2-3 weeks' },
      { title: 'Call analytics dashboard', detail: 'Track call volume peaks, lead quality, conversion rates, and recovery patterns. Pro plan unlock.', effort: 'Medium', timeline: '1 week' },
    ],
    major: [
      { title: 'Full lead pipeline + follow-up automation', detail: 'Status tracking, follow-up reminders, and conversion attribution. Turns the AI receptionist into a complete sales engine.', effort: 'High', timeline: '4-6 weeks' },
      { title: 'Multi-location + team routing', detail: 'Route calls by service area, technician, or department. Scale to multiple crews without adding human dispatchers.', effort: 'High', timeline: '4-8 weeks' },
      { title: 'CRM + invoicing integration', detail: 'Push captured leads directly into ServiceTitan, Jobber, or Housecall Pro. Close loop from first call to paid invoice.', effort: 'High', timeline: '6-10 weeks' },
    ],
  };
}

function computeRevenueEstimate(findings) {
  let low = 0, high = 0;
  findings.forEach(f => {
    low += f.estimated_loss_low || 0;
    high += f.estimated_loss_high || 0;
  });
  return {
    monthly_low: low,
    monthly_high: high,
    annual_low: low * 12,
    annual_high: high * 12,
  };
}

// ============================================================
// SAVE LEAD (Supabase) — best effort
// ============================================================
async function saveLead(input, score, findings) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/leads`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        business_name: input.business_name,
        contact_name: input.owner_name,
        email: input.email,
        phone: input.phone,
        website: input.website,
        industry: input.industry,
        source: 'scanner',
        status: 'qualified',
        notes: `Scanner submission · Score ${score}/100 · ${findings.filter(f => f.severity === 'high').length} high-severity issues`,
      }),
    });
  } catch (e) {
    console.warn('[scanner-submit] lead save failed:', e.message);
  }
}

// ============================================================
// EMAIL NOTIFICATION (Resend)
// ============================================================
async function sendNotification(input, score, findings, estimate) {
  if (!RESEND_KEY) {
    console.warn('[scanner-submit] RESEND_API_KEY missing');
    return;
  }

  const highIssues = findings.filter(f => f.severity === 'high').length;
  const medIssues = findings.filter(f => f.severity === 'med').length;

  const html = `
<!DOCTYPE html>
<html><body style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; background:#08080a; color:#fafafa; padding:24px; max-width:600px; margin:0 auto;">
  <div style="background:#111114; border:1px solid rgba(255,106,0,0.22); border-radius:14px; padding:24px; margin-bottom:16px;">
    <div style="font-family:'Geist Mono', monospace; font-size:11px; letter-spacing:0.18em; text-transform:uppercase; color:#ff6a00; font-weight:600; margin-bottom:10px;">New Scanner Lead</div>
    <h1 style="font-size:24px; font-weight:700; margin:0 0 6px; letter-spacing:-0.02em;">${escapeHtml(input.business_name)}</h1>
    <div style="font-size:14px; color:#a1a1aa;">Score: <strong style="color:#ff6a00">${score}/100</strong> · ${highIssues} high · ${medIssues} medium</div>
  </div>

  <div style="background:#111114; border:1px solid rgba(255,255,255,0.06); border-radius:14px; padding:24px; margin-bottom:16px;">
    <div style="font-family:'Geist Mono', monospace; font-size:10px; letter-spacing:0.16em; text-transform:uppercase; color:#71717a; margin-bottom:14px; font-weight:600;">Contact</div>
    <table style="width:100%; font-size:14px; color:#d4d4d8;">
      <tr><td style="padding:6px 0; color:#71717a; width:120px;">Owner</td><td>${escapeHtml(input.owner_name)}</td></tr>
      <tr><td style="padding:6px 0; color:#71717a;">Email</td><td><a href="mailto:${escapeHtml(input.email)}" style="color:#ff9a00; text-decoration:none;">${escapeHtml(input.email)}</a></td></tr>
      <tr><td style="padding:6px 0; color:#71717a;">Phone</td><td><a href="tel:${escapeHtml(input.phone)}" style="color:#ff9a00; text-decoration:none;">${escapeHtml(input.phone)}</a></td></tr>
      <tr><td style="padding:6px 0; color:#71717a;">Website</td><td><a href="${escapeHtml(input.website)}" target="_blank" style="color:#ff9a00; text-decoration:none;">${escapeHtml(input.website)}</a></td></tr>
      <tr><td style="padding:6px 0; color:#71717a;">Industry</td><td>${escapeHtml(input.industry || '—')}</td></tr>
    </table>
  </div>

  <div style="background:#111114; border:1px solid rgba(255,255,255,0.06); border-radius:14px; padding:24px;">
    <div style="font-family:'Geist Mono', monospace; font-size:10px; letter-spacing:0.16em; text-transform:uppercase; color:#71717a; margin-bottom:14px; font-weight:600;">Revenue Estimate</div>
    <div style="font-size:13px; color:#d4d4d8; line-height:1.6;">
      <strong style="color:#34d399">$${fmtNum(estimate.monthly_low)} - $${fmtNum(estimate.monthly_high)}/month</strong> potential recovery<br>
      <span style="color:#71717a; font-size:12px;">Annual: $${fmtNum(estimate.annual_low)} - $${fmtNum(estimate.annual_high)}</span>
    </div>
  </div>

  <div style="margin-top:24px; text-align:center; font-family:'Geist Mono', monospace; font-size:10px; color:#52525b; letter-spacing:0.1em;">
    AI LEAD INTEL · SCANNER · ${new Date().toLocaleString()}
  </div>
</body></html>
  `;

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${RESEND_KEY}`,
      },
      body: JSON.stringify({
        from: 'AI Lead Intel <hello@aileadintel.com>',
        to: [NOTIFY_EMAIL],
        reply_to: input.email,
        subject: `🎯 New Scanner Lead: ${input.business_name} (Score ${score}/100)`,
        html,
      }),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      console.warn('[scanner-submit] Resend failed:', r.status, text.slice(0, 200));
    }
  } catch (e) {
    console.warn('[scanner-submit] notification failed:', e.message);
  }
}

function fmtNum(n) {
  return new Intl.NumberFormat('en-US').format(Math.round(n));
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ============================================================
// HANDLER
// ============================================================
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  // Rate limit by IP — 10 scans per hour per IP
  const ip = getClientIp(req);
  const rl = rateLimit(`scanner:${ip}`, 10, 60 * 60, 60 * 60);
  if (!rl.ok) {
    res.setHeader('Retry-After', String(rl.retryAfter));
    return res.status(429).json({
      success: false,
      error: 'Too many scans. Try again later.',
      retry_after_seconds: rl.retryAfter,
    });
  }

  // Parse body
  let body = req.body || {};
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (_) { body = {}; }
  }

  // Validate
  const required = ['business_name', 'website', 'owner_name', 'email', 'phone'];
  for (const field of required) {
    if (!body[field] || String(body[field]).trim().length < 2) {
      return res.status(400).json({ success: false, error: `Missing or invalid: ${field}` });
    }
  }

  const input = {
    business_name: String(body.business_name).slice(0, 200).trim(),
    website: String(body.website).slice(0, 300).trim(),
    owner_name: String(body.owner_name).slice(0, 100).trim(),
    email: String(body.email).slice(0, 150).trim().toLowerCase(),
    phone: String(body.phone).slice(0, 30).trim(),
    industry: String(body.industry || '').slice(0, 60).trim(),
  };

  // Generate findings (templated, no AI)
  const findings = generateFindings(input);
  const score = computeScore(findings);
  const wins = generateWins(findings);
  const estimate = computeRevenueEstimate(findings);

  // Fire-and-forget side effects
  saveLead(input, score, findings).catch(() => {});
  sendNotification(input, score, findings, estimate).catch(() => {});

  return res.status(200).json({
    success: true,
    score,
    findings,
    wins,
    estimate,
    business_name: input.business_name,
  });
}
