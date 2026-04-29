// /api/vapi/call-ended.js
// Webhook endpoint that Vapi calls when a phone call ends
// Saves call to Supabase, scores the lead, and emails a summary

export const config = {
  maxDuration: 30,
};

export default async function handler(req, res) {
  // Only accept POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const payload = req.body;

    // Vapi sends different message types - we only care about end-of-call reports
    const messageType = payload?.message?.type;

    if (messageType !== 'end-of-call-report' && messageType !== 'status-update') {
      // Acknowledge other webhook types silently
      return res.status(200).json({ received: true });
    }

    // Only process actual end-of-call reports
    if (messageType !== 'end-of-call-report') {
      return res.status(200).json({ received: true });
    }

    const message = payload.message;
    const call = message.call || {};
    const customer = call.customer || {};
    const assistant = call.assistant || {};

    // Extract the data we want
    const callData = {
      vapi_call_id: call.id,
      assistant_id: call.assistantId || assistant.id,
      phone_number_id: call.phoneNumberId,
      caller_number: customer.number || call.customer?.number || 'Unknown',
      caller_name: customer.name || null,
      duration_seconds: Math.round(call.duration || message.durationSeconds || 0),
      call_status: call.status || 'ended',
      ended_reason: message.endedReason || call.endedReason || 'unknown',
      transcript: message.transcript || formatTranscript(message.messages),
      summary: message.summary || message.analysis?.summary || null,
      recording_url: message.recordingUrl || call.recordingUrl || null,
      raw_payload: payload,
    };

    // Score the lead based on conversation content
    const leadAnalysis = analyzeLead(callData.transcript || '');
    callData.lead_score = leadAnalysis.score;
    callData.outcome = leadAnalysis.outcome;
    callData.asked_for_transfer = leadAnalysis.askedForTransfer;
    callData.asked_for_pricing = leadAnalysis.askedForPricing;
    callData.client_id = 'prime_vault'; // Hardcoded for now

    // Save to Supabase
    await saveToSupabase(callData);

    // Send email summary
    await sendEmailSummary(callData, leadAnalysis);

    // Send push notification for hot leads
    if (leadAnalysis.score === 'HOT') {
      await sendPushNotification(callData);
    }

    return res.status(200).json({ success: true, callId: call.id });
  } catch (error) {
    console.error('call-ended webhook error:', error);
    // Always return 200 so Vapi doesn't retry endlessly
    return res.status(200).json({ error: error.message });
  }
}

// Format transcript from messages array if needed
function formatTranscript(messages) {
  if (!messages || !Array.isArray(messages)) return '';
  return messages
    .filter(m => m.role && m.message)
    .map(m => {
      const role = m.role === 'bot' || m.role === 'assistant' ? 'AI' : 'Caller';
      return `${role}: ${m.message}`;
    })
    .join('\n');
}

// Analyze the transcript to score the lead
function analyzeLead(transcript) {
  const t = (transcript || '').toLowerCase();

  const hotSignals = [
    'want to book', 'want to rent', 'lock it in', 'reserve',
    'sign up', 'i\'ll take', 'let\'s do it', 'sounds good let\'s',
    'ready to', 'when can i come', 'how do i sign'
  ];

  const warmSignals = [
    'price', 'pricing', 'how much', 'cost', 'monthly',
    'discount', 'promo', 'deal', 'available', 'availability',
    'when', 'hours', 'open', 'tomorrow', 'today', 'this week',
    'looking for', 'need', 'thinking about'
  ];

  const askedForTransfer = /speak to|talk to|representative|real person|someone|human|manager|owner/i.test(t);
  const askedForPricing = /price|pricing|how much|cost|monthly|rate|quote/i.test(t);

  // Score the lead
  let score = 'COLD';
  let outcome = 'Information call';

  for (const signal of hotSignals) {
    if (t.includes(signal)) {
      score = 'HOT';
      outcome = 'Customer ready to buy / book';
      break;
    }
  }

  if (score !== 'HOT') {
    let warmCount = 0;
    for (const signal of warmSignals) {
      if (t.includes(signal)) warmCount++;
    }
    if (warmCount >= 2) {
      score = 'WARM';
      outcome = 'Interested customer - asking questions';
    }
  }

  if (askedForTransfer) {
    if (score === 'COLD') score = 'WARM';
    outcome = (score === 'HOT' ? outcome + ' - ' : '') + 'Asked for human';
  }

  if (!t || t.length < 50) {
    score = 'NONE';
    outcome = 'Very short call - possibly hangup';
  }

  return {
    score,
    outcome,
    askedForTransfer,
    askedForPricing,
  };
}

// Save the call to Supabase
async function saveToSupabase(callData) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/calls`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'apikey': process.env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal,resolution=merge-duplicates',
    },
    body: JSON.stringify(callData),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Supabase save failed:', response.status, errorText);
    throw new Error(`Supabase error: ${response.status}`);
  }
}

// Send the email summary using Resend
async function sendEmailSummary(callData, leadAnalysis) {
  const resendKey = process.env.RESEND_API_KEY;
  const toEmail = process.env.NOTIFY_EMAIL || 'andrewyoung02@icloud.com';

  if (!resendKey) {
    console.error('No RESEND_API_KEY set');
    return;
  }

  // Format duration nicely
  const minutes = Math.floor(callData.duration_seconds / 60);
  const seconds = callData.duration_seconds % 60;
  const durationStr = `${minutes}m ${seconds}s`;

  // Lead score emoji
  const scoreEmojis = {
    HOT: '🔥',
    WARM: '🟡',
    COLD: '🔵',
    NONE: '⚪',
  };
  const scoreEmoji = scoreEmojis[leadAnalysis.score] || '⚪';

  // Time
  const callTime = new Date().toLocaleString('en-US', {
    timeZone: 'America/Chicago',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    month: 'short',
    day: 'numeric',
  });

  // Format the email
  const subject = `${scoreEmoji} ${leadAnalysis.score} Lead - Call from ${callData.caller_number}`;

  const html = `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: #f5f5f5; color: #1a1a1a; }
    .card { background: white; border-radius: 12px; padding: 24px; box-shadow: 0 2px 8px rgba(0,0,0,0.05); margin-bottom: 16px; }
    .badge { display: inline-block; padding: 4px 12px; border-radius: 99px; font-weight: 600; font-size: 13px; }
    .badge-hot { background: #fee; color: #c00; }
    .badge-warm { background: #fef3c7; color: #92400e; }
    .badge-cold { background: #e0f2fe; color: #075985; }
    .badge-none { background: #f3f4f6; color: #6b7280; }
    .info-row { display: flex; padding: 8px 0; border-bottom: 1px solid #f0f0f0; font-size: 14px; }
    .info-row:last-child { border-bottom: none; }
    .info-label { width: 120px; color: #6b7280; }
    .info-value { flex: 1; color: #1a1a1a; font-weight: 500; }
    .summary { background: #f9fafb; border-left: 3px solid #ff6a00; padding: 16px; border-radius: 6px; margin-top: 12px; font-size: 14px; line-height: 1.6; }
    .transcript { background: #f9fafb; border-radius: 6px; padding: 16px; margin-top: 12px; font-size: 13px; line-height: 1.6; max-height: 400px; overflow-y: auto; white-space: pre-wrap; }
    .action-button { display: inline-block; padding: 12px 20px; background: #ff6a00; color: white; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 14px; margin-top: 12px; }
    h1 { font-size: 22px; margin: 0 0 8px 0; }
    h2 { font-size: 16px; margin: 0 0 12px 0; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px; }
    .footer { text-align: center; color: #9ca3af; font-size: 12px; margin-top: 24px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${scoreEmoji} ${leadAnalysis.score} Lead</h1>
    <span class="badge badge-${leadAnalysis.score.toLowerCase()}">${leadAnalysis.outcome}</span>
  </div>
  <div class="card">
    <h2>Call Details</h2>
    <div class="info-row">
      <div class="info-label">Caller</div>
      <div class="info-value"><a href="tel:${callData.caller_number}">${callData.caller_number}</a></div>
    </div>
    <div class="info-row">
      <div class="info-label">Time</div>
      <div class="info-value">${callTime}</div>
    </div>
    <div class="info-row">
      <div class="info-label">Duration</div>
      <div class="info-value">${durationStr}</div>
    </div>
    <div class="info-row">
      <div class="info-label">Outcome</div>
      <div class="info-value">${leadAnalysis.outcome}</div>
    </div>
    <div class="info-row">
      <div class="info-label">Transferred</div>
      <div class="info-value">${leadAnalysis.askedForTransfer ? 'Yes' : 'No'}</div>
    </div>
    <div class="info-row">
      <div class="info-label">Asked Pricing</div>
      <div class="info-value">${leadAnalysis.askedForPricing ? 'Yes' : 'No'}</div>
    </div>
  </div>
  ${callData.summary ? `
  <div class="card">
    <h2>Summary</h2>
    <div class="summary">${escapeHtml(callData.summary)}</div>
  </div>
  ` : ''}
  ${callData.transcript ? `
  <div class="card">
    <h2>Full Transcript</h2>
    <div class="transcript">${escapeHtml(callData.transcript)}</div>
  </div>
  ` : ''}
  ${callData.recording_url ? `
  <div class="card">
    <h2>Audio Recording</h2>
    <a href="${callData.recording_url}" class="action-button">Listen to Recording</a>
  </div>
  ` : ''}
  ${leadAnalysis.score === 'HOT' || leadAnalysis.score === 'WARM' ? `
  <div class="card" style="background: #fff7ed; border: 2px solid #ff6a00;">
    <h2 style="color: #ff6a00;">Recommended Action</h2>
    <p style="margin: 0; font-size: 15px;">Call this customer back ${leadAnalysis.score === 'HOT' ? 'within 1 hour' : 'within 24 hours'} for the best chance of closing.</p>
    <a href="tel:${callData.caller_number}" class="action-button">Call Back Now</a>
  </div>
  ` : ''}
  <div class="footer">
    Powered by AI Lead Intel<br>
    Call ID: ${callData.vapi_call_id || 'unknown'}
  </div>
</body>
</html>
  `;

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${resendKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'AI Lead Intel <onboarding@resend.dev>',
      to: [toEmail],
      subject: subject,
      html: html,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Resend email failed:', response.status, errorText);
  }
}

// Send push notification for hot leads
async function sendPushNotification(callData) {
  const ntfyTopic = process.env.NTFY_TOPIC;
  if (!ntfyTopic) return;

  try {
    await fetch(`https://ntfy.sh/${ntfyTopic}`, {
      method: 'POST',
      headers: {
        'Title': 'HOT LEAD - Call Back Now',
        'Priority': 'high',
        'Tags': 'fire,phone',
      },
      body: `Caller ${callData.caller_number} is ready to buy. Call them back ASAP.`,
    });
  } catch (error) {
    console.error('Push notification failed:', error);
  }
}

// Helper: escape HTML to prevent injection
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
