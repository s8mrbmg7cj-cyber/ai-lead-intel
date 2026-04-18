// lib/scraper.js
// Lead scraping + data layer
// Uses Apify Google Maps scraper in production
// Falls back to realistic simulated data for testing

export const SIMULATED_LEADS = [
  {
    business_name: "Mike's Auto Detail",
    phone: "+18015550192",
    website: "mikesautodetail.com",
    review_count: 23,
    rating: 4.1,
    category: "car detailing",
    city: "Salt Lake City, UT",
    reviews_sample: [
      "Great detail but took forever to call me back",
      "Phone goes straight to voicemail half the time",
      "Good work when you can actually get them on the phone"
    ]
  },
  {
    business_name: "Green Thumb Landscaping",
    phone: "+18015550341",
    website: null,
    review_count: 8,
    rating: 3.9,
    category: "landscaping",
    city: "Provo, UT",
    reviews_sample: [
      "No website, hard to find info online",
      "Called twice before anyone answered",
      "Does good work but communication is rough"
    ]
  },
  {
    business_name: "CoolBreeze HVAC",
    phone: "+18015550847",
    website: "coolbreezeheating.com",
    review_count: 67,
    rating: 4.4,
    category: "HVAC",
    city: "Ogden, UT",
    reviews_sample: [
      "Wish they had online booking",
      "Hard to get a quote upfront",
      "Great technicians, terrible scheduling system"
    ]
  },
  {
    business_name: "Spotless Window Cleaning",
    phone: "+18015550923",
    website: null,
    review_count: 4,
    rating: 4.8,
    category: "window cleaning",
    city: "Salt Lake City, UT",
    reviews_sample: [
      "Amazing work but no online presence",
      "Found them by word of mouth only",
      "Deserves way more reviews"
    ]
  },
  {
    business_name: "Premier Plumbing Co",
    phone: "+18015550614",
    website: "premierplumbingutah.com",
    review_count: 142,
    rating: 3.7,
    category: "plumbing",
    city: "Murray, UT",
    reviews_sample: [
      "No text back after missed call, had to call 3 times",
      "Slow to respond to messages",
      "Good plumbers but communication needs serious work"
    ]
  }
];

// Production: swap simulated data for real Apify scrape
export async function scrapeGoogleMaps({ query, city, limit = 20 }) {
  const APIFY_TOKEN = process.env.APIFY_TOKEN;

  if (!APIFY_TOKEN) {
    console.log("SCRAPER: No Apify token — using simulated data");
    return SIMULATED_LEADS.filter(l =>
      !query || l.category.includes(query.toLowerCase())
    ).slice(0, limit);
  }

  try {
    const runRes = await fetch(
      "https://api.apify.com/v2/acts/compass~google-maps-scraper/runs?token=" + APIFY_TOKEN,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          searchStringsArray: [query + " in " + city],
          maxCrawledPlacesPerSearch: limit,
          language: "en",
        }),
      }
    );
    const run = await runRes.json();
    const runId = run.data?.id;

    let attempts = 0;
    while (attempts < 12) {
      await new Promise(r => setTimeout(r, 5000));
      const statusRes = await fetch(
        "https://api.apify.com/v2/actor-runs/" + runId + "?token=" + APIFY_TOKEN
      );
      const status = await statusRes.json();
      if (status.data?.status === "SUCCEEDED") break;
      attempts++;
    }

    const dataRes = await fetch(
      "https://api.apify.com/v2/actor-runs/" + runId + "/dataset/items?token=" + APIFY_TOKEN
    );
    const items = await dataRes.json();

    return items.map(item => ({
      business_name: item.title || "",
      phone: item.phone || "",
      website: item.website || null,
      review_count: item.reviewsCount || 0,
      rating: item.totalScore || 0,
      category: query,
      city,
      reviews_sample: (item.reviews || []).slice(0, 3).map(r => r.text),
    }));

  } catch (err) {
    console.log("APIFY ERROR:", err.message);
    return SIMULATED_LEADS.slice(0, limit);
  }
}
