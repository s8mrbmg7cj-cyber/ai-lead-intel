// api/dispatch-leads.js — the leads the dispatch page shows.
//
// Reads them back out of ntfy, which is the one store in this stack that cannot
// be dead: it needs no credentials and no database. Every Supabase project on
// this account is PAUSED (free tier, ~7 days idle), so a lead list backed by
// Supabase would be a blank screen at the moment a homeowner is waiting.
//
// KNOWN LIMIT, STATED OUT LOUD BECAUSE IT WILL MATTER: ntfy's free cache holds
// roughly 12 hours. This endpoint is NOT an archive and must never be described
// as one. The durable copy of every lead is the email Resend sends — that has
// been verified working. The response carries `cache_window_hours` so the page
// can print the limit instead of implying an empty list means "no leads ever".

import { parseLead, isLeadNotification, keyOk } from "../lib/dispatch.js";

const TOPIC = process.env.NTFY_TOPIC || "mcr-leads-andrew-2025";
const CACHE_WINDOW_HOURS = 12;

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  // Same key as the send endpoint. The lead list carries homeowners' names and
  // phone numbers, so it is not public even though it spends no money.
  const key = req.headers["x-dispatch-key"] || req.query?.k || "";
  if (!keyOk(key)) return res.status(401).json({ error: "bad or missing key" });

  try {
    const r = await fetch(`https://ntfy.sh/${encodeURIComponent(TOPIC)}/json?poll=1&since=all`, {
      headers: { Accept: "application/x-ndjson" },
    });
    if (!r.ok) {
      const body = (await r.text()).slice(0, 160);
      return res.status(502).json({ error: `ntfy HTTP ${r.status}`, detail: body });
    }

    const text = await r.text();
    const leads = [];
    const skipped = { health: 0, unusable: 0, malformed: 0 };

    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let n;
      try { n = JSON.parse(line); } catch { skipped.malformed++; continue; }
      if (!isLeadNotification(n)) { skipped.health++; continue; }
      const lead = parseLead(n.message, n.title, { id: n.id, time: n.time });
      // A lead with no callable number cannot be dispatched. Count it rather
      // than render a card that looks actionable and isn't.
      if (!lead.usable) { skipped.unusable++; continue; }
      leads.push(lead);
    }

    leads.sort((a, b) => b.at - a.at);

    return res.status(200).json({
      ok: true,
      leads,
      // The page prints these. A zero that means "nothing in the last 12 hours"
      // must never be allowed to read as "nothing has ever come in" — a capped
      // window can never prove a zero.
      count: leads.length,
      cache_window_hours: CACHE_WINDOW_HOURS,
      skipped,
    });
  } catch (e) {
    // undici's whole .message for a network failure is "fetch failed". The real
    // reason hides on .cause, and throwing it away cost a month on this repo.
    let root = e;
    for (let i = 0; i < 5 && root && root.cause; i++) root = root.cause;
    return res.status(502).json({
      error: "could not reach the notification store",
      detail: [root?.code, root?.message || String(e)].filter(Boolean).join(": ").slice(0, 180),
    });
  }
}
