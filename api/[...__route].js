// api/[...__route].js — consolidated API dispatcher.
//
// WHY THIS EXISTS: Vercel's Hobby plan allows at most 12 serverless functions
// per deployment, and it counts every .js file under api/ as one function.
// This repo had 37, so every deploy failed with "No more than 12 Serverless
// Functions can be added to a Deployment on the Hobby plan."
//
// THE FIX: simple JSON endpoints moved to /api-handlers (NOT counted — only
// files under api/ count) and are served through this single catch-all
// function. Public URLs are unchanged: /api/health still works, Vercel just
// routes it here because no concrete api/health.js exists anymore.
//
// WHAT STAYS AS REAL FILES IN api/ (9 functions + this one = 10 of 12):
//   - stripe-webhook, paypal-webhook, cancel-subscription, onboarding-return,
//     review-request-send — they export `config` (raw body / parser settings)
//     which only works on a standalone function file.
//   - twilio-webhook, vapi-webhook, vapi/call-ended, vapi/call-ended-backup —
//     live telephony; their URLs are registered in external dashboards and
//     they are too critical to route through a dispatcher.
//
// ADDING AN ENDPOINT: put the file in /api-handlers, import it below, add it
// to `routes`. Do NOT add new files to api/ unless they need `config`.

import adminCheck from '../api-handlers/admin-check.js';
import adminLogin from '../api-handlers/admin-login.js';
import adminMetrics from '../api-handlers/admin-metrics.js';
import adminScanner from '../api-handlers/admin-scanner.js';
import authLinkUser from '../api-handlers/auth-link-user.js';
import createPaymentLink from '../api-handlers/create-payment-link.js';
import dispatchLeads from '../api-handlers/dispatch-leads.js';
import dispatchSend from '../api-handlers/dispatch-send.js';
import fbLeadsWebhook from '../api-handlers/fb-leads-webhook.js';
import forgotPassword from '../api-handlers/forgot-password.js';
import generateMessage from '../api-handlers/generate-message.js';
import healthCheck from '../api-handlers/health-check.js';
import healthExtras from '../api-handlers/health-extras.js';
import health from '../api-handlers/health.js';
import leadSubmit from '../api-handlers/lead-submit.js';
import markLive from '../api-handlers/mark-live.js';
import matchIntake from '../api-handlers/match-intake.js';
import onboardingSubmit from '../api-handlers/onboarding-submit.js';
import provision from '../api-handlers/provision.js';
import reportError from '../api-handlers/report-error.js';
import reviewClick from '../api-handlers/review-click.js';
import reviewRequestCreate from '../api-handlers/review-request-create.js';
import reviewSettings from '../api-handlers/review-settings.js';
import saveSetup from '../api-handlers/save-setup.js';
import scannerSubmit from '../api-handlers/scanner-submit.js';
import sendReport from '../api-handlers/send-report.js';
import sendSetupEmail from '../api-handlers/send-setup-email.js';
import supabaseWebhook from '../api-handlers/supabase-webhook.js';

const routes = {
  'admin-check': adminCheck,
  'admin-login': adminLogin,
  'admin-metrics': adminMetrics,
  'admin-scanner': adminScanner,
  'auth-link-user': authLinkUser,
  'create-payment-link': createPaymentLink,
  'dispatch-leads': dispatchLeads,
  'dispatch-send': dispatchSend,
  'fb-leads-webhook': fbLeadsWebhook,
  'forgot-password': forgotPassword,
  'generate-message': generateMessage,
  'health-check': healthCheck,
  'health-extras': healthExtras,
  'health': health,
  'lead-submit': leadSubmit,
  'mark-live': markLive,
  'match-intake': matchIntake,
  'onboarding-submit': onboardingSubmit,
  'provision': provision,
  'report-error': reportError,
  'review-click': reviewClick,
  'review-request-create': reviewRequestCreate,
  'review-settings': reviewSettings,
  'save-setup': saveSetup,
  'scanner-submit': scannerSubmit,
  'send-report': sendReport,
  'send-setup-email': sendSetupEmail,
  'supabase-webhook': supabaseWebhook,
};

export default function handler(req, res) {
  const seg = req.query.__route;
  const name = Array.isArray(seg) ? seg.join('/') : seg;
  delete req.query.__route; // handlers should see exactly the query they always saw

  const route = Object.prototype.hasOwnProperty.call(routes, name) ? routes[name] : null;
  if (!route) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  return route(req, res);
}
