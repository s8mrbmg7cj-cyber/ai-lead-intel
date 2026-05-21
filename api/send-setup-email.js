/*!
 * AI Lead Intel — Admin: Send Setup Email button
 *
 * Drop into admin page after your existing table renders. Auto-detects each
 * client row by its data-slug attribute and adds a "Send setup email" button.
 *
 * If your admin uses a different attribute (e.g. data-client-slug or data-id),
 * change ROW_SLUG_ATTR below. If it uses a custom action drawer, plug in there.
 */

(function () {
  'use strict';

  // ===== CONFIG =====
  const ROW_SLUG_ATTR = 'data-slug'; // attribute on each row that holds client_slug
  const BUTTON_LABEL = 'Send setup email';
  const CONFIRM_TEXT = 'Send setup email to this customer?';

  // ===== STYLES =====
  if (!document.getElementById('admin-setup-email-styles')) {
    const style = document.createElement('style');
    style.id = 'admin-setup-email-styles';
    style.textContent = `
      .send-setup-email-btn {
        display: inline-flex; align-items: center; gap: 6px;
        padding: 6px 11px;
        background: rgba(255,106,0,0.10);
        border: 1px solid rgba(255,106,0,0.22);
        border-radius: 7px;
        color: #ff6a00;
        font-family: inherit;
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.02em;
        cursor: pointer;
        transition: all 0.15s;
        white-space: nowrap;
      }
      .send-setup-email-btn:hover {
        background: rgba(255,106,0,0.18);
        border-color: rgba(255,106,0,0.35);
        transform: translateY(-1px);
      }
      .send-setup-email-btn:disabled {
        opacity: 0.6;
        cursor: not-allowed;
        transform: none;
      }
      .send-setup-email-btn.sent {
        background: rgba(52,211,153,0.12);
        border-color: rgba(52,211,153,0.30);
        color: #34d399;
      }
      .send-setup-email-btn.error {
        background: rgba(248,113,113,0.12);
        border-color: rgba(248,113,113,0.30);
        color: #f87171;
      }
      .send-setup-spinner {
        width: 10px; height: 10px;
        border: 1.5px solid currentColor;
        border-top-color: transparent;
        border-radius: 50%;
        animation: sse-spin 0.7s linear infinite;
      }
      @keyframes sse-spin { to { transform: rotate(360deg); } }
    `;
    document.head.appendChild(style);
  }

  // ===== HELPERS =====
  function makeButton(slug) {
    const btn = document.createElement('button');
    btn.className = 'send-setup-email-btn';
    btn.type = 'button';
    btn.dataset.slug = slug;
    btn.innerHTML = `
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/>
        <polyline points="22,6 12,13 2,6"/>
      </svg>
      <span class="sse-label">${BUTTON_LABEL}</span>
    `;
    btn.addEventListener('click', handleClick);
    return btn;
  }

  async function handleClick(e) {
    e.stopPropagation();
    e.preventDefault();
    const btn = e.currentTarget;
    const slug = btn.dataset.slug;
    if (!slug) return;
    if (btn.disabled) return;

    if (!window.confirm(CONFIRM_TEXT)) return;

    const labelEl = btn.querySelector('.sse-label');
    const original = labelEl.textContent;
    btn.disabled = true;
    btn.classList.remove('sent', 'error');
    labelEl.innerHTML = '<span class="send-setup-spinner"></span> Sending...';

    try {
      const res = await fetch('/api/send-setup-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_slug: slug }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok || !data.success) {
        const err = data.error || `HTTP ${res.status}`;
        console.error('[admin] send-setup-email failed:', err, data);
        labelEl.textContent = 'Failed';
        btn.classList.add('error');
        setTimeout(() => {
          labelEl.textContent = original;
          btn.classList.remove('error');
          btn.disabled = false;
        }, 3000);
        return;
      }

      console.log('[admin] Setup email sent:', data);
      labelEl.textContent = `Sent to ${data.email_sent_to || 'customer'}`;
      btn.classList.add('sent');
      setTimeout(() => {
        labelEl.textContent = original;
        btn.classList.remove('sent');
        btn.disabled = false;
      }, 4000);
    } catch (err) {
      console.error('[admin] send-setup-email exception:', err);
      labelEl.textContent = 'Error';
      btn.classList.add('error');
      setTimeout(() => {
        labelEl.textContent = original;
        btn.classList.remove('error');
        btn.disabled = false;
      }, 3000);
    }
  }

  function attachToRows() {
    const rows = document.querySelectorAll(`[${ROW_SLUG_ATTR}]:not([data-sse-attached])`);
    rows.forEach(row => {
      const slug = row.getAttribute(ROW_SLUG_ATTR);
      if (!slug) return;
      row.setAttribute('data-sse-attached', '1');

      // Find a sensible place to inject the button. Tries common patterns.
      let target = row.querySelector('.row-actions') ||
                   row.querySelector('[data-actions]') ||
                   row.querySelector('.actions') ||
                   row.querySelector('td:last-child');

      // If no obvious target, append directly to the row
      if (!target) target = row;

      target.appendChild(makeButton(slug));
    });
  }

  // Initial attach
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', attachToRows);
  } else {
    attachToRows();
  }

  // Re-attach when rows change (handles dynamic re-renders)
  const observer = new MutationObserver(() => {
    attachToRows();
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // Expose for debugging
  window.refreshSetupEmailButtons = attachToRows;
})();
