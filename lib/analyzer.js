// lib/analyzer.js
// AI Analysis Engine
// Takes business data → returns weaknesses + opportunity + outreach messages
// Uses Claude (Anthropic) API — swap for OpenAI if preferred

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
  if (!apiKey) {
    // Return mock analysis for testing without API key
    return getMockAnalysis(business);
  }

  const reviewText = reviews_sample.length > 0
    ? reviews_sample.join(" | ")
    : "No reviews available";

  const prompt = `You are analyzing a local ${category} business to help identify sales opportunities.

Business: ${business_name}
Location: ${city}
Rating: ${rating}/5 stars
Review count: ${review_count}
Website: ${website || "None"}
Sample customer reviews: ${reviewText}

Analyze this business and return ONLY a JSON object with this exact structure (no markdown, no extra text):
{
  "weakness_1": "one specific weakness in 1 sentence",
  "weakness_2": "second specific weakness in 1 sentence", 
  "opportunity": "one concrete opportunity to improve their lead conversion in 1 sentence",
  "sms_message": "a casual 1-2 sentence SMS outreach message personalized to this business — NOT salesy, ends with a curiosity question, sounds like a real person",
  "email_subject": "short email subject line, max 8 words",
  "email_body": "2-3 sentence email body — professional but conversational, references something specific about their business, ends with a soft question",
  "followup_sms_1": "follow-up SMS for 2 days later if no reply — even more casual",
  "followup_sms_2": "final follow-up SMS for 5 days later — brief, low pressure"
}

Rules:
- Be SPECIFIC to this business — mention their rating, review count, or lack of website
- SMS messages must be under 160 characters
- Never use words like: "revolutionize", "game-changer", "skyrocket", "leverage"
- Sound like a real person, not a robot or marketer`;

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
        max_tokens: 800,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const data = await res.json();
    const text = data.content?.[0]?.text || "";
    
    // Strip any markdown code fences if present
    const clean = text.replace(/```json|```/g, "").trim();
    const analysis = JSON.parse(clean);

    return {
      business_name,
      category,
      rating,
      review_count,
      website,
      city,
      ...analysis,
    };

  } catch (err) {
    console.log("ANALYZER ERROR:", err.message);
    return getMockAnalysis(business);
  }
}

// Mock analysis — used when no API key is set (for testing)
function getMockAnalysis(business) {
  const { business_name, category, rating, review_count, website, city } = business;
  const noWebsite = !website;
  const lowReviews = review_count < 20;

  return {
    business_name,
    category,
    rating,
    review_count,
    website,
    city,
    weakness_1: noWebsite
      ? "No website means prospects can't find pricing or book online — they call competitors instead"
      : "Reviews mention slow response to calls and texts, costing them warm leads",
    weakness_2: lowReviews
      ? `Only ${review_count} reviews makes them nearly invisible on Google compared to competitors`
      : `${rating}/5 rating suggests customer experience issues that reduce repeat business`,
    opportunity: "Adding an instant text-back when calls are missed would recover an estimated 30-40% of lost leads",
    sms_message: `Hey — noticed ${business_name} doesn't have a way to auto-follow up on missed calls. Curious how many leads you're losing a week to that?`,
    email_subject: `Quick question about ${business_name}'s missed calls`,
    email_body: `Hey — I was looking at ${business_name} online and noticed a few things that are probably costing you leads every week. ${noWebsite ? "Not having a website makes it tough for people to find you after hours." : "A few reviews mention calls going unanswered."} I built a simple system that texts people back automatically when you miss their call — curious if that's something you've thought about?`,
    followup_sms_1: `Hey, just circling back — still curious if missed calls are a problem for you. Happy to show you what I mean with no pressure.`,
    followup_sms_2: `Last one from me — if the timing's ever right to chat about automating your follow-ups, just reply. Hope business is good!`,
  };
}

// Analyze multiple businesses in parallel (with rate limiting)
export async function analyzeAll(businesses) {
  const results = [];
  
  // Process in batches of 3 to avoid API rate limits
  for (let i = 0; i < businesses.length; i += 3) {
    const batch = businesses.slice(i, i + 3);
    const batchResults = await Promise.all(batch.map(b => analyzeBusiness(b)));
    results.push(...batchResults);
    
    // Small delay between batches
    if (i + 3 < businesses.length) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  
  return results;
}
