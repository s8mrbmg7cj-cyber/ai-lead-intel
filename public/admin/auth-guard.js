/*!
 * AI Lead Intel — Admin Auth Guard
 *
 * Drop into every page under /admin/ to:
 *   1. Verify the user has a valid admin_session cookie (server-side check)
 *   2. Redirect to /admin/login if not
 *   3. Add a small logout button in the top-right of the nav
 *
 * The cookie is HttpOnly so we can't read it from JS — we rely on the server
 * to validate it by calling /api/admin-check.
 */

(function () {
  'use strict';

  const CURRENT_PATH = window.location.pathname + window.location.search;
  const LOGIN_URL = `/admin/login?return=${encodeURIComponent(CURRENT_PATH)}`;

  // Don't run guard on the login page itself
  if (window.location.pathname.startsWith('/admin/login')) return;

  // ===== STYLES =====
  const style = document.createElement('style');
  style.textContent = `
    .admin-guard-blocker {
      position: fixed; inset: 0;
      background: #08080a;
      display: flex; align-items: center; justify-content: center;
      z-index: 99999;
      font-family: 'Geist Mono', monospace;
      color: rgba(255,255,255,0.5);
      font-size: 12px; letter-spacing: 0.12em;
      text-transform: uppercase;
    }
    .admin-guard-spinner {
      width: 28px; height: 28px;
      border: 3px solid rgba(255,255,255,0.1);
      border-top-color: #ff6a00;
      border-radius: 50%;
      animation: ag-spin 0.8s linear infinite;
      margin-right: 14px;
    }
    @keyframes ag-spin { to { transform: rotate(360deg); } }
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

  // ===== BLOCK PAGE UNTIL AUTH RESOLVED =====
  const blocker = document.createElement('div');
  blocker.className = 'admin-guard-blocker';
  blocker.innerHTML = `<div class="admin-guard-spinner"></div><span>Verifying access</span>`;
  document.body.appendChild(blocker);

  // ===== CHECK AUTH =====
  fetch('/api/admin-check', { credentials: 'same-origin' })
    .then(r => r.json().catch(() => ({})))
    .then(data => {
      if (!data || !data.success) {
        window.location.replace(LOGIN_URL);
        return;
      }
      // ✅ Authenticated — remove blocker, wire up logout
      blocker.remove();
      injectLogoutButton();
    })
    .catch(() => {
      window.location.replace(LOGIN_URL);
    });

  // ===== LOGOUT BUTTON =====
  function injectLogoutButton() {
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

    // Find a good spot — try the topnav first, fall back to body
    const navRight = document.querySelector('.nav-right') ||
                     document.querySelector('.topnav') ||
                     document.body;
    navRight.appendChild(btn);
  }

  // Expose for manual calls
  window.adminLogout = async () => {
    try {
      await fetch('/api/admin-login', { method: 'DELETE', credentials: 'same-origin' });
    } catch (_) {}
    window.location.href = '/admin/login';
  };
})();
