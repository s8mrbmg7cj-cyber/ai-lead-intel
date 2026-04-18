# AI Lead Intel — Complete Setup Guide

## File Structure
```
/api
  generate-message.js   ← Lead Intel Agent endpoint
  lead-submit.js        ← Inbound form handler
  sms-reply.js          ← AI Front Desk SMS handler
  send-sms.js           ← Manual SMS sender
/lib
  scraper.js            ← Google Maps data (Apify or simulated)
  analyzer.js           ← AI analysis + message generation
  frontdesk.js          ← AI conversation engine
/public
  index.html            ← Landing page (client-facing)
  agent.html            ← Operator panel (your tool)
vercel.json
package.json
```

---

## Step 1: Deploy to Vercel
1. Push this folder to a new GitHub repo
2. Go to vercel.com → New Project → import the repo
3. Click Deploy

## Step 2: Add Environment Variables
In Vercel → Settings → Environment Variables, add:

| Variable | Value | Required? |
|---|---|---|
| ANTHROPIC_API_KEY | Your Claude API key | YES — get at console.anthropic.com |
| TWILIO_ACCOUNT_SID | Your Twilio SID | For real SMS |
| TWILIO_AUTH_TOKEN | Your Twilio token | For real SMS |
| TWILIO_PHONE_NUMBER | +1XXXXXXXXXX | For real SMS |
| RESEND_API_KEY | Your Resend key | For email notifications |
| NOTIFY_EMAIL | your@email.com | Your email |
| APIFY_TOKEN | Your Apify token | For real Google Maps data |
| BUSINESS_NAME | Mike's Auto Detail | For AI front desk |
| BUSINESS_TYPE | car detailing | For AI front desk |

**Without API keys:** Everything still runs in mock mode. Great for testing.

## Step 3: Test the Lead Intel Agent
1. Go to: yourapp.vercel.app/agent.html
2. Enter "car detailing" + your city
3. Click Run Agent
4. See AI-generated weaknesses + outreach messages

## Step 4: Test the Landing Page
1. Go to: yourapp.vercel.app
2. Fill out the form
3. Check your Twilio/email for notification

## Step 5: Set Twilio Webhook for SMS replies
In Twilio Console → Phone Numbers → Configure:
- A Message Comes In → Webhook → POST
- URL: https://yourapp.vercel.app/api/sms-reply

---

## How to Make Money

### Immediate (Week 1)
1. Run the agent on local businesses in your city
2. Text the outreach messages manually (copy from agent dashboard)
3. When they respond → offer to show them a demo
4. Close at $297-497/month

### Pricing Model
| Plan | Price | What you provide |
|---|---|---|
| Starter | $297/mo | Missed call text-back + follow-ups |
| Pro | $497/mo | + AI front desk (qualifies + books) |
| Agency | $997/mo | + Multiple locations + reporting |

### Path to $50k/month
- 100 clients × $500/mo = $50,000/mo
- Your costs: ~$50-100/client/month (Twilio + API calls)
- Your profit: ~$400-450/client/month

### ROI pitch to clients
"If this system recovers 2 missed jobs per month at $250 each,
that's $500 recovered. You pay me $297. You're up $200 and 
your customers get a better experience."

---

## Example AI Outreach Output
```json
{
  "business_name": "Mike's Auto Detail",
  "weakness_1": "23 reviews over their lifetime means they're nearly invisible on Google searches",
  "weakness_2": "Multiple reviews mention calls going to voicemail with no callback",
  "opportunity": "Auto text-back on missed calls could recover 30-40% of lost prospects",
  "sms_message": "Hey — noticed Mike's Auto Detail doesn't have a way to auto-follow up on missed calls. Curious how many leads you're losing a week to that?",
  "email_subject": "Quick question about Mike's missed calls",
  "followup_sms_1": "Just circling back — still curious if missed calls are costing you jobs. Happy to show you what I mean with no pressure.",
  "followup_sms_2": "Last one from me — if timing's ever right to chat about automating follow-ups, just reply. Hope business is good!"
}
```

## Example AI Front Desk Conversation
Customer calls → you miss it → AI texts within 60 seconds:

AI: "Hey! Sorry we missed your call — we don't want to lose you. What service were you looking for?"
Customer: "Need a full detail on my truck"
AI: "Got it! Interior + exterior or just one? And standard size or oversized?"
Customer: "Full package, standard F-150"
AI: "Perfect. Full detail on an F-150 runs $220-260. We have Thursday at 10am or Friday at 2pm — which works?"
Customer: "Thursday!"
AI: "You're set! Thursday at 10am. We'll send a reminder Wednesday night. See you then!"
→ BOOKED. You get notified. You just show up.
