// lib/frontdesk.js — v2
// AI Front Desk for AI Lead Intel inbound leads
// When someone fills out the landing page form, this handles the full conversation
// No calls needed — AI closes the deal over text and sends PayPal link

const LANDING_PAGE = process.env.LANDING_PAGE_URL || "ai-lead-intel.vercel.app";

const PAYMENT = {
  starter: "paypal.me/AILeadIntel/297",
  pro: "paypal.me/AILeadIntel/497",
  agency: "paypal.me/AILeadIntel/997",
};

const SYSTEM_PROMPT = `You are Alex, a friendly assistant for AI Lead Intel — a service that helps local service businesses (detailers, landscapers, HVAC, plumbers, etc.) never lose a job from a missed call again.

YOUR JOB: Have a natural text conversation that:
1. Makes them feel the pain of missed calls
2. Explains how the service works simply
3. Answers their questions honestly
4. Moves them toward paying

ABOUT THE SERVICE:
- When someone calls a business and they don't answer, we auto-text that caller back within 60 seconds
- The AI then qualifies them, answers questions, and books the job automatically
- Business owner gets notified — they just show up and do the work
- Setup takes 48 hours, we handle everything technical
- No contracts, cancel anytime

PRICING:
- Starter ($297/month): Auto text-back + 2 follow-ups. Owner handles replies manually
- Pro ($497/month): Full AI front desk — qualifies leads AND books jobs automatically. Most popular.
- Agency ($997/month): Up to 5 locations. Best for multi-location businesses.

PAYMENT LINKS (send when they're ready to pay):
- Starter: paypal.me/AILeadIntel/297
- Pro: paypal.me/AILeadIntel/497
- Agency: paypal.me/AILeadIntel/997

ROI PITCH: Most clients recover the monthly cost in the first week from just 1-2 jobs they would've lost. Average business loses 5-10 calls a week. At $200/job that's $1,000-2,000 walking out the door monthly.

RULES:
- Keep texts SHORT — 2-3 sentences max. This is SMS not email.
- Sound like a real human, not a bot or salesperson
- Never say "AI", "automation", "SaaS", "revolutionize"
- Say "system" or "service" instead of AI
- Focus on JOBS and MONEY, not technology
- Be casual and friendly — like texting a friend who happens to know about this stuff
- When they seem ready, ask "Want to get started? I can have it live for you within 48 hours."
- When they say yes, ask which plan fits them best, then send the PayPal link
- If they ask about something you don't know, say "Great question — let me find out and get back to you"
- NEVER be pushy. If they say not interested, wish them well and say the door is open

CONVERSATION FLOW:
1. Welcome + ask about their missed calls situation
2. Listen to their reply, validate the problem
3. Explain how it works in simple terms
4. Handle any questions or objections
5. Ask if they want to get started
6. Send payment link for their chosen plan`;

// In-memory conversation store (use Supabase in production)
const conversations = global._frontdeskConvos || new Map();
global._frontdeskConvos = conversations;

// Called when someone first submits the landing page form
export async function getWelcomeMessage(leadData) {
  const { name, business_type } = leadData;
  
  const firstName = name?.split(" ")[0] || "there";
  const biz = business_type || "your business";

  return `Hey ${firstName}! Thanks for reaching out about AI Lead Intel. Quick question — when you're out working on a ${biz} job and someone calls you, what usually happens to that call?`;
}

// Called when they reply to any text
export async function getAIResponse({ phone, message, leadData }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  // Get or create conversation history
  if (!conversations.has(phone)) {
    conversations.set(phone, []);
  }
  const history = conversations.get(phone);

  // Add their message
  history.push({ role: "user", content: message });

  // Check for keywords that need special handling
  const msg = message.toLowerCase();
  const wantsToPayStarter = msg.includes("starter") || msg.includes("297") || msg.includes("basic");
  const wantsToPayPro = msg.includes("pro") || msg.includes("497") || (msg.includes("ai") && msg.includes("book"));
  const wantsToPayAgency = msg.includes("agency") || msg.includes("997") || msg.includes("multiple") || msg.includes("locations");
  const sayingYes = msg.includes("yes") || msg.includes("yeah") || msg.includes("sure") || msg.includes("let's do it") || msg.includes("lets do it") || msg.includes("sign me up");
  const wantsInfo = msg.includes("send info") || msg.includes("send me") || msg.includes("more info") || msg.includes("learn more");
  const askingPrice = msg.includes("how much") || msg.includes("price") || msg.includes("cost") || msg.includes("pricing");

  // Handle payment requests directly without AI
  if (wantsToPayStarter) {
    const reply = `Perfect! Starter plan it is — $297/month. Here's your payment link: ${PAYMENT.starter}\n\nOnce you pay I'll reach out within 24 hours to get everything set up. Takes about 48 hours total and I handle everything. Questions?`;
    history.push({ role: "assistant", content: reply });
    conversations.set(phone, history);
    return reply;
  }

  if (wantsToPayAgency) {
    const reply = `Agency plan — great choice for multiple locations. $997/month covers up to 5 locations. Here's the link: ${PAYMENT.agency}\n\nPay there and I'll reach out within 24 hours to start setup. I'll need the details for each location but we'll go through that together.`;
    history.push({ role: "assistant", content: reply });
    conversations.set(phone, history);
    return reply;
  }

  if (wantsToPayPro || sayingYes) {
    const reply = `Awesome! Most people go with Pro ($497/month) — it's the full setup where the AI handles the whole conversation and books the job for you. Here's your payment link: ${PAYMENT.pro}\n\nOnce you pay I'll reach out within 24 hours. Have it live for you in 48 hours. Sound good?`;
    history.push({ role: "assistant", content: reply });
    conversations.set(phone, history);
    return reply;
  }

  if (wantsInfo) {
    const reply = `Here's a quick demo that shows exactly how it works: ${LANDING_PAGE}\n\nThe demo at the top shows a real missed call turning into a booked job. Takes 2 minutes to see the whole thing. What type of business do you run?`;
    history.push({ role: "assistant", content: reply });
    conversations.set(phone, history);
    return reply;
  }

  if (askingPrice) {
    const reply = `Three options:\n• Starter $297/mo — auto text-back, you handle replies\n• Pro $497/mo — AI handles full conversation + books jobs (most popular)\n• Agency $997/mo — up to 5 locations\n\nMost clients recover the cost in the first week from jobs they would've lost. Which sounds like the right fit?`;
    history.push({ role: "assistant", content: reply });
    conversations.set(phone, history);
    return reply;
  }

  // Use Claude API for everything else
  if (!apiKey) {
    const fallback = getFallbackResponse(message, history.length, leadData);
    history.push({ role: "assistant", content: fallback });
    conversations.set(phone, history);
    return fallback;
  }

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
        max_tokens: 300,
        system: SYSTEM_PROMPT + `\n\nLead info: Name: ${leadData?.name || "unknown"}, Business type: ${leadData?.business_type || "unknown"}`,
        messages: history,
      }),
    });

    const data = await res.json();
    const reply = data.content?.[0]?.text || getFallbackResponse(message, history.length, leadData);

    history.push({ role: "assistant", content: reply });
    conversations.set(phone, history);
    return reply;

  } catch (err) {
    console.log("FRONTDESK ERROR:", err.message);
    const fallback = getFallbackResponse(message, history.length, leadData);
    history.push({ role: "assistant", content: fallback });
    conversations.set(phone, history);
    return fallback;
  }
}

// Fallback responses when API fails
function getFallbackResponse(message, turnCount, leadData) {
  const biz = leadData?.business_type || "your business";
  const msg = message.toLowerCase();

  if (turnCount <= 1) {
    return `Most ${biz} owners tell me they lose 5-8 calls a week while they're on jobs. At even $150/job that's real money. Does that sound familiar?`;
  }
  if (msg.includes("yes") || msg.includes("yeah")) {
    return `Exactly — and the problem is those people don't leave voicemails. They just call the next result on Google. Our system texts them back within 60 seconds so they hear from you before they book someone else. Want to see how it works? ${LANDING_PAGE}`;
  }
  if (msg.includes("how") || msg.includes("work")) {
    return `Simple — someone calls you, you miss it, they get a text from YOUR number within 60 seconds. The AI asks what they need, answers questions, and books them in. You just get a notification that a job is booked. Want me to walk you through the plans?`;
  }
  return `That makes sense! The main thing business owners tell us is they had no idea how many jobs they were losing until they saw it in action. Want to take a look at what it costs to get set up? ${LANDING_PAGE}`;
}

// Check if lead is booked/converted
export function isConverted(phone) {
  const history = conversations.get(phone) || [];
  return history.some(m =>
    m.content?.includes("paypal.me") ||
    m.content?.toLowerCase().includes("payment link")
  );
}

// Get conversation history for a phone number
export function getHistory(phone) {
  return conversations.get(phone) || [];
}
