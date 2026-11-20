// api/generate-message.js
// POST /api/generate-message
// Takes a search query + city → scrapes leads → analyzes → returns outreach messages
// This is the core of the Lead Intel Agent

import { scrapeGoogleMaps } from "../lib/scraper.js";
import { analyzeAll } from "../lib/analyzer.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).json({ ok: true });
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { query, city, limit = 5 } = req.body || {};

  if (!query || !city) {
    return res.status(400).json({ error: "query and city are required" });
  }

  try {
    console.log("GENERATE: scraping", query, "in", city);

    // Step 1: Get business data
    const businesses = await scrapeGoogleMaps({ query, city, limit });
    console.log("GENERATE: found", businesses.length, "businesses");

    // Step 2: Analyze each business with AI
    const analyzed = await analyzeAll(businesses);
    console.log("GENERATE: analyzed", analyzed.length, "businesses");

    // Step 3: Return structured results
    return res.status(200).json({
      success: true,
      count: analyzed.length,
      query,
      city,
      leads: analyzed.map(b => ({
        business_name: b.business_name,
        phone: b.phone,
        website: b.website,
        rating: b.rating,
        review_count: b.review_count,
        city: b.city,
        weakness_1: b.weakness_1,
        weakness_2: b.weakness_2,
        opportunity: b.opportunity,
        outreach: {
          sms: b.sms_message,
          email_subject: b.email_subject,
          email_body: b.email_body,
          followup_sms_1: b.followup_sms_1,
          followup_sms_2: b.followup_sms_2,
        }
      }))
    });

  } catch (err) {
    console.log("GENERATE ERROR:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
