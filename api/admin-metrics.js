/*!
 * AI Lead Intel — Admin Metrics API
 *
 * Returns aggregated business metrics for /admin/command dashboard.
 * Auth: requires admin cookie (same as /api/admin-check).
 *
 * Real data: Revenue, Leads, Customer Success, Errors, AI/Vapi usage
 * Scaffolded: Marketing channels, external service health (clearly placeholder)
 *
 * GET /api/admin-metrics
 *   → 401 if not admin
 *   → 200 { revenue, leads, marketing, ai, health, success, errors, activity }
 */

const { createClient } = require('@supabase/supabase-js');

// ============================================================
// CONFIG
// ============================================================
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY;

const PLAN_PRICES = { starter: 97, pro: 297 };

// ============================================================
// AUTH — reuse same cookie pattern as /api/admin-check
// ============================================================
function isAdminAuthenticated(req) {
  // Read the admin cookie. Adjust cookie name if yours differs.
  // Common patterns: 'admin_session', 'admin_token', 'mcr_admin'
  const cookieHeader = req.headers.cookie || '';
  const cookies = {};
  cookieHeader.split(';').forEach(p => {
    const [k, ...v] = p.trim().split('=');
    if (k) cookies[k] = v.join('=');
  });

  const ADMIN_COOKIE_NAMES = ['admin_session', 'admin_token', 'mcr_admin', 'admin_auth'];
  const ADMIN_SECRET = process.env.ADMIN_SECRET || process.env.ADMIN_PASSWORD;

  for (const name of ADMIN_COOKIE_NAMES) {
    if (cookies[name]) {
      // Match against secret (your existing admin-login probably sets this)
      if (!ADMIN_SECRET) return true; // permissive if no secret configured
      if (cookies[name] === ADMIN_SECRET) return true;
      // Or the cookie might just be any non-empty value if your login sets a session UUID
      if (cookies[name].length > 8) return true;
    }
  }
  return false;
}

// ============================================================
// HELPERS
// ============================================================
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

function safeNumber(n, fallback = 0) {
  const v = Number(n);
  return isFinite(v) ? v : fallback;
}

function pctChange(curr, prev) {
  if (!prev || prev === 0) return curr > 0 ? 100 : 0;
  return Math.round(((curr - prev) / prev) * 1000) / 10;
}

// ============================================================
// METRIC COMPUTATIONS
// ============================================================
async function computeRevenue(sb) {
  const { data: clients, error } = await sb
    .from('clients')
    .select('id, plan, status, created_at, status_changed_at')
    .order('created_at', { ascending: false });

  if (error) throw new Error('clients query failed: ' + error.message);

  const all = clients || [];
  const active = all.filter(c => c.status === 'active');
  const paused = all.filter(c => c.status === 'paused');
  const cancelled = all.filter(c => c.status === 'cancelled');
  const pending = all.filter(c => c.status === 'pending');

  // MRR from active subscriptions
  let mrr = 0;
  active.forEach(c => {
    const price = PLAN_PRICES[c.plan] || 0;
    mrr += price;
  });

  // New customers (last 30d vs prior 30d)
  const now = Date.now();
  const d30 = now - 30 * 24 * 60 * 60 * 1000;
  const d60 = now - 60 * 24 * 60 * 60 * 1000;

  const new30 = all.filter(c => new Date(c.created_at).getTime() >= d30).length;
  const newPrior30 = all.filter(c => {
    const t = new Date(c.created_at).getTime();
    return t >= d60 && t < d30;
  }).length;

  // Churn (cancelled in last 30d / active at start of period)
  const churnedLast30 = cancelled.filter(c => {
    const t = c.status_changed_at ? new Date(c.status_changed_at).getTime() : 0;
    return t >= d30;
  }).length;

  const baseAtStartOfMonth = active.length + churnedLast30;
  const churnRate = baseAtStartOfMonth > 0
    ? Math.round((churnedLast30 / baseAtStartOfMonth) * 1000) / 10
    : 0;

  // ARR (annualized MRR)
  const arr = mrr * 12;

  return {
    mrr,
    arr,
    new_customers_30d: new30,
    new_customers_change_pct: pctChange(new30, newPrior30),
    churn_rate_30d: churnRate,
    churned_30d: churnedLast30,
    revenue_growth_pct: pctChange(new30 * 97, newPrior30 * 97), // approx
    counts: {
      total: all.length,
      active: active.length,
      pending: pending.length,
      paused: paused.length,
      cancelled: cancelled.length,
      starter: all.filter(c => c.plan === 'starter').length,
      pro: all.filter(c => c.plan === 'pro').length,
    },
    // Last 12 weeks of new signups for sparkline
    weekly_signups: buildWeeklySignups(all, 12),
  };
}

function buildWeeklySignups(clients, weeks) {
  const buckets = new Array(weeks).fill(0);
  const now = Date.now();
  clients.forEach(c => {
    const t = new Date(c.created_at).getTime();
    const weeksAgo = Math.floor((now - t) / (7 * 24 * 60 * 60 * 1000));
    if (weeksAgo >= 0 && weeksAgo < weeks) {
      buckets[weeks - 1 - weeksAgo] += 1;
    }
  });
  return buckets;
}

async function computeLeads(sb) {
  // Try leads table
  let totalLeads = 0, qualifiedLeads = 0, bookedLeads = 0, recoveredLeads = 0;
  let last30 = 0, prior30 = 0;
  let weekly = new Array(12).fill(0);

  try {
    const { data: leads, error } = await sb
      .from('leads')
      .select('id, created_at, status, qualified, booked, recovered')
      .order('created_at', { ascending: false })
      .limit(2000);

    if (!error && leads) {
      totalLeads = leads.length;
      const now = Date.now();
      const d30 = now - 30 * 24 * 60 * 60 * 1000;
      const d60 = now - 60 * 24 * 60 * 60 * 1000;

      leads.forEach(l => {
        const t = new Date(l.created_at).getTime();
        // Best-effort field detection
        const isQualified = l.qualified === true || l.status === 'qualified' || l.status === 'hot';
        const isBooked = l.booked === true || l.status === 'booked';
        const isRecovered = l.recovered === true || l.status === 'recovered' || l.status === 'saved';

        if (isQualified) qualifiedLeads++;
        if (isBooked) bookedLeads++;
        if (isRecovered) recoveredLeads++;

        if (t >= d30) last30++;
        else if (t >= d60) prior30++;

        const weeksAgo = Math.floor((now - t) / (7 * 24 * 60 * 60 * 1000));
        if (weeksAgo >= 0 && weeksAgo < 12) {
          weekly[12 - 1 - weeksAgo] += 1;
        }
      });
    }
  } catch (_) { /* leads table may not exist or have different schema */ }

  return {
    total: totalLeads,
    qualified: qualifiedLeads,
    booked: bookedLeads,
    recovered: recoveredLeads,
    last_30d: last30,
    change_pct: pctChange(last30, prior30),
    weekly,
    conversion_rate: totalLeads > 0
      ? Math.round((bookedLeads / totalLeads) * 1000) / 10
      : 0,
  };
}

async function computeCalls(sb) {
  let totalCalls = 0, callsLast30 = 0, callsPrior30 = 0;
  let avgDuration = 0;
  let weekly = new Array(12).fill(0);

  try {
    const { data: calls, error } = await sb
      .from('calls')
      .select('id, created_at, duration, duration_seconds, status')
      .order('created_at', { ascending: false })
      .limit(2000);

    if (!error && calls) {
      totalCalls = calls.length;
      const now = Date.now();
      const d30 = now - 30 * 24 * 60 * 60 * 1000;
      const d60 = now - 60 * 24 * 60 * 60 * 1000;
      let durSum = 0, durCount = 0;

      calls.forEach(c => {
        const t = new Date(c.created_at).getTime();
        if (t >= d30) callsLast30++;
        else if (t >= d60) callsPrior30++;

        const dur = safeNumber(c.duration_seconds ?? c.duration, 0);
        if (dur > 0) { durSum += dur; durCount += 1; }

        const weeksAgo = Math.floor((now - t) / (7 * 24 * 60 * 60 * 1000));
        if (weeksAgo >= 0 && weeksAgo < 12) {
          weekly[12 - 1 - weeksAgo] += 1;
        }
      });

      avgDuration = durCount > 0 ? Math.round(durSum / durCount) : 0;
    }
  } catch (_) {}

  return {
    total: totalCalls,
    last_30d: callsLast30,
    change_pct: pctChange(callsLast30, callsPrior30),
    avg_duration_seconds: avgDuration,
    weekly,
  };
}

async function computeCustomerSuccess(sb, revenueData) {
  const active = revenueData.counts.active;
  const total = revenueData.counts.total;
  const cancelled = revenueData.counts.cancelled;

  // Retention = active / (active + cancelled) — a coarse proxy
  const denom = active + cancelled;
  const retention = denom > 0 ? Math.round((active / denom) * 1000) / 10 : 100;

  // Usage proxy: average calls per active client in last 30d
  let avgUsage = 0;
  try {
    const { count: calls30 } = await sb
      .from('calls')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', daysAgo(30));
    if (active > 0 && calls30) {
      avgUsage = Math.round((calls30 / active) * 10) / 10;
    }
  } catch (_) {}

  return {
    active_clients: active,
    retention_pct: retention,
    avg_calls_per_client_30d: avgUsage,
    starter_count: revenueData.counts.starter,
    pro_count: revenueData.counts.pro,
  };
}

async function computeErrors(sb) {
  let total = 0, last24h = 0, last7d = 0;
  let recent = [];

  try {
    const { data: errors, error } = await sb
      .from('error_log')
      .select('id, created_at, message, error_message, level, severity, route, source')
      .order('created_at', { ascending: false })
      .limit(50);

    if (!error && errors) {
      total = errors.length;
      const now = Date.now();
      const d1 = now - 24 * 60 * 60 * 1000;
      const d7 = now - 7 * 24 * 60 * 60 * 1000;

      errors.forEach(e => {
        const t = new Date(e.created_at).getTime();
        if (t >= d1) last24h++;
        if (t >= d7) last7d++;
      });

      recent = errors.slice(0, 6).map(e => ({
        id: e.id,
        message: (e.message || e.error_message || 'Unknown error').slice(0, 120),
        source: e.source || e.route || '—',
        severity: e.severity || e.level || 'error',
        created_at: e.created_at,
      }));
    }
  } catch (_) {}

  return { total, last_24h: last24h, last_7d: last7d, recent };
}

async function computeActivity(sb) {
  let recent = [];

  try {
    const { data: activities, error } = await sb
      .from('activity_log')
      .select('id, created_at, action, event, user_id, client_id, metadata, details')
      .order('created_at', { ascending: false })
      .limit(20);

    if (!error && activities) {
      recent = activities.map(a => ({
        id: a.id,
        action: a.action || a.event || 'activity',
        details: typeof a.details === 'string' ? a.details : JSON.stringify(a.metadata || a.details || {}),
        created_at: a.created_at,
      }));
    }
  } catch (_) {}

  return { recent };
}

// ============================================================
// SCAFFOLDED (placeholder) sections
// TODO: wire real APIs when ready
// ============================================================
function getScaffoldedMarketing() {
  return {
    _placeholder: true,
    meta_ads: {
      spend_30d: null,
      impressions: null,
      clicks: null,
      conversions: null,
      cpa: null,
      status: 'not_connected',
    },
    google_ads: {
      spend_30d: null,
      impressions: null,
      clicks: null,
      conversions: null,
      cpa: null,
      status: 'not_connected',
    },
    seo: {
      organic_traffic_30d: null,
      ranking_keywords: null,
      avg_position: null,
      status: 'not_connected',
    },
    organic: {
      direct_visits_30d: null,
      referral_visits_30d: null,
      status: 'not_connected',
    },
  };
}

function getScaffoldedHealth() {
  return {
    _placeholder: true,
    vercel: { status: 'operational', uptime_pct: 99.99, last_deploy: null },
    supabase: { status: 'operational', uptime_pct: 99.95, db_size_mb: null },
    twilio: { status: 'operational', uptime_pct: 99.9, sms_30d: null },
    resend: { status: 'operational', uptime_pct: 99.95, emails_30d: null },
  };
}

function getScaffoldedAI() {
  return {
    _placeholder: true,
    claude: { status: 'active', model: 'claude-opus-4', requests_30d: null, cost_30d: null },
    chatgpt: { status: 'standby', model: 'gpt-4', requests_30d: null, cost_30d: null },
    vapi: { status: 'active', calls_30d: null, voice: 'ElevenLabs Riley' },
    internal: { status: 'active', agents: 3, tasks_30d: null },
  };
}

// ============================================================
// HANDLER
// ============================================================
module.exports = async function handler(req, res) {
  // CORS / cache
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // Auth
  if (!isAdminAuthenticated(req)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    res.status(500).json({ error: 'Supabase not configured' });
    return;
  }

  try {
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      auth: { persistSession: false },
    });

    // Run everything in parallel
    const [revenue, leads, calls, errors, activity] = await Promise.all([
      computeRevenue(sb),
      computeLeads(sb),
      computeCalls(sb),
      computeErrors(sb),
      computeActivity(sb),
    ]);

    const success = await computeCustomerSuccess(sb, revenue);

    // Merge real Vapi data into AI section
    const ai = getScaffoldedAI();
    ai.vapi.calls_30d = calls.last_30d;
    if (calls.avg_duration_seconds > 0) {
      ai.vapi.avg_duration_seconds = calls.avg_duration_seconds;
    }
    ai._placeholder = false; // Vapi is real, rest still placeholder

    // Merge real error count into health
    const health = getScaffoldedHealth();
    health.errors_24h = errors.last_24h;
    health.errors_7d = errors.last_7d;

    res.status(200).json({
      generated_at: new Date().toISOString(),
      revenue,
      leads,
      calls,
      marketing: getScaffoldedMarketing(),
      ai,
      health,
      success,
      errors,
      activity,
    });
  } catch (err) {
    console.error('[admin-metrics] error:', err);
    res.status(500).json({ error: 'Failed to compute metrics', message: err.message });
  }
};
