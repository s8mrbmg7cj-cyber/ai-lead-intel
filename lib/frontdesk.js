// lib/frontdesk.js
// AI Front Desk conversation engine
// Handles the back-and-forth SMS conversation with an inbound lead
// Qualifies them, answers questions, simulates booking

const SYSTEM_PROMPT = `You are a friendly, efficient front desk assistant for a local service business. 
Your job is to:
1. Greet the customer warmly
2. Find out what service they need
3. Get basic details (vehicle type for detailing, property size for landscaping, etc.)
4. Offer available times and confirm a booking

Rules:
- Keep responses SHORT — 1-3 sentences max (this is SMS)
- Sound like a real person, not a bot
- Never say "I am an AI" or "as an AI assistant"
- Be friendly but efficient — move toward booking
- If they ask for pricing, give a range, then move toward booking
- Available times: weekdays 8am-5pm, Saturdays 9am-2pm
- If they seem ready, confirm the booking with: "Perfect! I've got you down for [day] at [time]. We'll send a reminder the day before."`;

// Build conversation history for the API call
export async function getAIResponse({ 
  conversationHistory, 
  newMessage, 
  businessName, 
  businessType 
}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  // Build messages array from conversation history
  const messages = [
    ...conversationHistory,
    { role: "user", content: newMessage }
  ];

  if (!apiKey) {
    return getFallbackResponse(newMessage, conversationHistory.length);
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
        max_tokens: 200,
        system: SYSTEM_PROMPT + "\n\nYou work for: " + businessName + " (" + businessType + ")",
        messages,
      }),
    });

    const data = await res.json();
    return data.content?.[0]?.text || getFallbackResponse(newMessage, messages.length);

  } catch (err) {
    console.log("FRONTDESK AI ERROR:", err.message);
    return getFallbackResponse(newMessage, conversationHistory.length);
  }
}

// Fallback responses when no API key (for testing)
function getFallbackResponse(message, turnNumber) {
  const msg = message.toLowerCase();
  
  if (turnNumber === 0 || msg.includes("hello") || msg.includes("hi")) {
    return "Hey! Thanks for reaching out. What service can I help you with today?";
  }
  if (msg.includes("detail") || msg.includes("car") || msg.includes("truck")) {
    return "Got it! What type of vehicle — car, truck, or SUV? And are you looking for interior, exterior, or the full package?";
  }
  if (msg.includes("interior") || msg.includes("exterior") || msg.includes("full")) {
    return "Perfect. We have openings Tuesday at 10am or Thursday at 2pm this week — which works better for you?";
  }
  if (msg.includes("tuesday") || msg.includes("thursday") || msg.includes("monday") || msg.includes("friday")) {
    return "Perfect! I've got you down for that slot. Can I get your name so I can confirm the booking?";
  }
  if (msg.includes("price") || msg.includes("cost") || msg.includes("how much")) {
    return "Full details run $150-250 depending on vehicle size. Want to lock in a time and we can confirm the exact price when we see the vehicle?";
  }
  return "Sounds good! When works best for you — we have openings Tuesday through Saturday this week.";
}

// Determine if lead is "booked" based on conversation
export function isBooked(conversationHistory) {
  const lastMessages = conversationHistory.slice(-3);
  return lastMessages.some(m => 
    m.content?.toLowerCase().includes("got you down") ||
    m.content?.toLowerCase().includes("confirmed") ||
    m.content?.toLowerCase().includes("booked")
  );
}

// Determine conversation stage
export function getStage(conversationHistory) {
  const length = conversationHistory.length;
  if (length === 0) return "new";
  if (length <= 2) return "greeting";
  if (length <= 6) return "qualifying";
  if (isBooked(conversationHistory)) return "booked";
  return "following_up";
}
