/*!
 * AI Lead Intel — Admin Auth Guard (HARD BLOCK VERSION)
 *
 * Must be loaded as the FIRST script in <head> on every admin page.
 * Immediately hides the document, calls /api/admin-check, then either
 * reveals the page or redirects to /admin/login.
 *
 * Console traces:
 *   [auth-guard] loaded
 *   [auth-guard] checking session
 *   [auth-guard] authorized
 *   [auth-guard] unauthorized redirect
 */

(function () {
  'use strict';

  console.log('[auth-guard] loaded');

  // ===== INSTANT HIDE (before any paint) =====
  // documentElement is always available — it's the <html> tag itself
  try {
    document.documentElement.style.visibility = 'hidden';
  } catch (e) {
    console.error('[auth-guard] could not hide document:', e);
  }

  const CURRENT_PATH = window.location.pathname + window.location.search;
  const LOGIN_URL = `/admin/login?return=${encodeURIComponent(CURRENT_PATH)}`;

  // Don't run guard on the login page itself
  if (window.location.pathname.startsWith('/admin/login')) {
    document.documentElement.style.visibility = 'visible';
    return;
  }

  function reveal() {
    document.documentElement.style.visibility = 'visible';
  }

  function redirectToLogin() {
    console.log('[auth-guard] unauthorized redirect');
    // Don't reveal — leave hidden so the user never sees flash
    window.location.replace(LOGIN_URL);
  }

  // ===== CHECK AUTH IMMEDIATELY =====
  console.log('[auth-guard] checking session');

  fetch('/api/admin-check', { credentials: 'same-origin', cache: 'no-store' })
    .then(r => {
      if (r.status === 401) {
        redirectToLogin();
        return null;
      }
      return r.json().catch(() => ({}));
    })
    .then(data => {
      if (!data) return; // already redirected
      if (!data.success) {
        redirectToLogin();
        return;
      }
      console.log('[auth-guard] authorized');
      reveal();
      // Inject logout button once DOM is ready
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', injectLogoutButton);
      } else {
        injectLogoutButton();
      }
    })
    .catch(err => {
      console.error('[auth-guard] check failed:', err);
      redirectToLogin();
    });

  // ===== LOGOUT BUTTON =====
  function injectLogoutButton() {
    // Inject style
    const style = document.createElement('style');
    style.textContent = `
      .admin-logout-btn {
        display: inline-flex; align-items: center; gap: 6px;
        padding: 6px 11px;
        background: rgba(255,255,255,0.03);
        border: 1px solid rgba(255,255,255,0.10);
        border-radius: 7px;
        color: #a1a1aa;
        font-family: 'Geist Mono', monospace;
        font-size: 10.5px; font-weight: 600;
        letter-spacing: 0.08em; text-transform: uppercase;
        cursor: pointer;
        transition: all 0.15s;
      }
      .admin-logout-btn:hover {
        background: rgba(248,113,113,0.10);
        border-color: rgba(248,113,113,0.30);
        color: #f87171;
      }
    `;
    document.head.appendChild(style);

    const btn = document.createElement('button');
    btn.className = 'admin-logout-btn';
    btn.type = 'button';
    btn.innerHTML = `
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
        <polyline points="16 17 21 12 16 7"/>
        <line x1="21" y1="12" x2="9" y2="12"/>
      </svg>
      <span>Log out</span>
    `;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await fetch('/api/admin-login', { method: 'DELETE', credentials: 'same-origin' });
      } catch (_) {}
      window.location.href = '/admin/login';
    });

    const target = document.querySelector('.nav-right') ||
                   document.querySelector('.topnav') ||
                   document.body;
    target.appendChild(btn);
  }

  // Expose for manual calls
  window.adminLogout = async () => {
    try {
      await fetch('/api/admin-login', { method: 'DELETE', credentials: 'same-origin' });
    } catch (_) {}
    window.location.href = '/admin/login';
  };

  // Failsafe: if something hangs for 8 seconds, just redirect to login
  setTimeout(() => {
    if (document.documentElement.style.visibility === 'hidden') {
      console.warn('[auth-guard] timed out — forcing redirect');
      redirectToLogin();
    }
  }, 8000);
})();
