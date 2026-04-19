// lib/analyzer.js
// AI Analysis Engine — upgraded with better messages + landing page link

const LANDING_PAGE = process.env.LANDING_PAGE_URL || "ai-lead-intel.vercel.app";

export async function analyzeBusiness(business) {
  const {
    business_name,
    category,
    rating,
    review_count,
    website,
    reviews_sample = [],
    city,
  } = business;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return getMockAnalysis(business);

  const reviewText = reviews_sample.length > 0
    ? reviews_sample.join(" | ")
    : "No reviews available";

  const prompt = `You are analyzing a local ${category} business to identify sales opportunities for an AI missed-call recovery service.

Business: ${business_name}
Location: ${city}
Rating: ${rating}/5 stars
Review count: ${review_count}
Website: ${website || "None"}
Sample customer reviews: ${reviewText}

Return ONLY a JSON object, no markdown, no extra text:
{
  "weakness_1": "one specific weakness in 1 sentence — reference their actual rating, review count, or website status",
  "weakness_2": "second specific weakness — focus on lead handling or response time based on reviews",
  "opportunity": "one concrete opportunity — be specific about estimated revenue impact",
  "pain_point": "the single biggest pain point this business has in 1 short sentence — make it feel real",
  "sms_message": "casual 1-2 sentence opening SMS — sounds like a real person texting a friend, references something specific about their business, ends with a genuine curiosity question — NO link, NOT salesy, under 160 chars",
  "email_subject": "short punchy subject line under 8 words — makes them want to open it",
  "email_body": "3-4 sentences — opens with something specific about their business, agitates the problem, hints at a solution, ends with a soft yes/no question. Professional but human tone.",
  "followup_sms_1": "follow-up SMS for 2 days later — more casual, reference the landing page URL ${LANDING_PAGE} naturally like 'built something that might help — [url]', under 160 chars",
  "followup_sms_2": "final SMS day 5 — very short, friendly, zero pressure, last attempt vibe",
  "followup_email": "follow-up email body for day 3 — share a quick result like 'helped a detailer recover 3 jobs last week', include the landing page link ${LANDING_PAGE}, short and punchy"
}

Rules:
- SPECIFIC to this exact business — use their name, rating, review count
- SMS under 160 chars each
- First SMS has NO link — just curiosity
- Follow-up SMS 1 includes the landing page link naturally
- Never say: revolutionize, game-changer, skyrocket, leverage, synergy
- Sound like a real 22-year-old entrepreneur, not a marketer`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const data = await res.json();
    const text = data.content?.[0]?.text || "";
    const clean = text.replace(/```json|```/g, "").trim();
    const analysis = JSON.parse(clean);

    return { business_name, category, rating, review_count, website, city, ...analysis };

  } catch (err) {
    console.log("ANALYZER ERROR:", err.message);
    return getMockAnalysis(business);
  }
}

function getMockAnalysis(business) {
  const { business_name, category, rating, review_count, website, city } = business;
  const noWebsite = !website;
  const lowReviews = review_count < 20;

  return {
    business_name, category, rating, review_count, website, city,
    weakness_1: noWebsite
      ? `${business_name} has no website — prospects can't find pricing after hours and go to competitors`
      : `Reviews for ${business_name} mention slow call-backs, which means warm leads are going cold`,
    weakness_2: lowReviews
      ? `Only ${review_count} reviews makes ${business_name} nearly invisible on Google searches`
      : `A ${rating}/5 rating is holding ${business_name} back from getting premium referrals`,
    opportunity: `Auto text-back on missed calls could recover 30-40% of lost leads — that's potentially $1,000+ per month`,
    pain_point: `Missing calls while on jobs and losing those customers to competitors`,
    sms_message: `Hey — quick question about ${business_name}. When you miss a call while you're on a job, what happens to that lead?`,
    email_subject: `${business_name} — losing jobs to missed calls?`,
    email_body: `Hey — I was checking out ${business_name} and noticed ${noWebsite ? "you don't have a website, which makes it hard for people to reach you after hours" : `a few reviews mention difficulty reaching you by phone`}. Most ${category} businesses lose 5-10 leads a week just from missed calls — people hang up and call the next result on Google. I built a system that texts them back within 60 seconds automatically. Worth a quick look?`,
    followup_sms_1: `Hey, built something that's been helping ${category} businesses recover missed leads — ${LANDING_PAGE} — might be worth 2 mins of your time?`,
    followup_sms_2: `Last one from me — hope business is good! If timing's ever right: ${LANDING_PAGE}`,
    followup_email: `Hey — just wanted to share a quick win. Helped a ${category} business recover 3 jobs last week that would've been lost to voicemail — all automated. Here's how it works: ${LANDING_PAGE}. Worth a look?`,
  };
}

export async function analyzeAll(businesses) {
  const results = [];
  for (let i = 0; i < businesses.length; i += 3) {
    const batch = businesses.slice(i, i + 3);
    const batchResults = await Promise.all(batch.map(b => analyzeBusiness(b)));
    results.push(...batchResults);
    if (i + 3 < businesses.length) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  return results;
}
