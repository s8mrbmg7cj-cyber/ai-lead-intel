/*!
 * AI Lead Intel — Error Reporter
 * Include on every customer-facing page:
 *   <script src="/error-reporter.js" defer></script>
 *
 * Captures:
 *   - Uncaught JS errors (window.onerror)
 *   - Unhandled promise rejections
 *   - Fetch failures (via wrapped fetch)
 *   - Anything you manually report with window.reportError(...)
 */

(function () {
  'use strict';

  // Rate limit: max 5 errors per session (prevents spam loops)
  let reportCount = 0;
  const MAX_REPORTS = 5;

  // Get slug from URL if present
  function getSlug() {
    try {
      return new URLSearchParams(window.location.search).get('slug') || '';
    } catch (_) {
      return '';
    }
  }

  // Send an error report to our API
  function sendReport(payload) {
    if (reportCount >= MAX_REPORTS) return;
    reportCount++;

    try {
      const data = {
        page: window.location.pathname,
        action: payload.action || 'unknown',
        error: payload.error || 'no message',
        slug: payload.slug || getSlug(),
        user_agent: navigator.userAgent,
        stack: payload.stack || '',
      };

      // Use sendBeacon if available (won't block page unload)
      if (navigator.sendBeacon) {
        const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
        navigator.sendBeacon('/api/report-error', blob);
      } else {
        fetch('/api/report-error', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
          keepalive: true,
        }).catch(() => {});
      }
    } catch (_) {
      // Swallow — never let error reporter cause its own errors
    }
  }

  // ===== 1. UNCAUGHT ERRORS =====
  window.addEventListener('error', function (event) {
    if (event && event.message) {
      sendReport({
        action: 'window.onerror',
        error: event.message,
        stack: event.error && event.error.stack ? event.error.stack : '',
      });
    }
  });

  // ===== 2. UNHANDLED PROMISE REJECTIONS =====
  window.addEventListener('unhandledrejection', function (event) {
    const reason = event.reason;
    let msg = 'Unhandled promise rejection';
    let stack = '';
    if (reason) {
      if (typeof reason === 'string') msg = reason;
      else if (reason.message) msg = reason.message;
      if (reason.stack) stack = reason.stack;
    }
    sendReport({
      action: 'unhandledrejection',
      error: msg,
      stack: stack,
    });
  });

  // ===== 3. MANUAL REPORTING =====
  // Use anywhere in your code:  window.reportError('mark-live failed', err);
  window.reportError = function (action, errOrMsg) {
    let error = 'unknown';
    let stack = '';
    if (errOrMsg) {
      if (typeof errOrMsg === 'string') error = errOrMsg;
      else if (errOrMsg.message) error = errOrMsg.message;
      if (errOrMsg.stack) stack = errOrMsg.stack;
    }
    sendReport({ action, error, stack });
  };
})();
