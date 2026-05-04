/**
 * AI Lead Intel — Phone Formatter
 * Drop this script into any page that has phone inputs.
 *
 * USAGE:
 *   <input type="tel" class="phone-input" placeholder="385-600-8134" maxlength="12" />
 *   <script src="/js/phone-format.js" defer></script>
 *
 * Features:
 *   - Auto-formats as user types: 3856008134 → 385-600-8134
 *   - Caps at 10 digits (US format)
 *   - Strips all non-numeric input
 *   - Preserves cursor position when editing middle digits
 *   - Validates 10 digits on blur (adds .invalid class if not 10 digits)
 *   - Re-runs on dynamically added inputs
 *
 * Helpers exposed on window:
 *   window.AILeadIntelPhone.format(value) → formatted string
 *   window.AILeadIntelPhone.isValid(value) → true if exactly 10 digits
 *   window.AILeadIntelPhone.attach(input) → attach to a specific input element
 */
(function () {
  'use strict';

  function format(raw) {
    var digits = String(raw || '').replace(/\D/g, '').slice(0, 10);
    if (digits.length === 0) return '';
    if (digits.length <= 3) return digits;
    if (digits.length <= 6) return digits.slice(0, 3) + '-' + digits.slice(3);
    return digits.slice(0, 3) + '-' + digits.slice(3, 6) + '-' + digits.slice(6, 10);
  }

  function isValid(value) {
    return String(value || '').replace(/\D/g, '').length === 10;
  }

  function attach(input) {
    if (!input || input.dataset.phoneFormatted === '1') return;
    input.dataset.phoneFormatted = '1';

    // Helpful native attrs (only set if not already set by the page)
    if (!input.hasAttribute('inputmode')) input.setAttribute('inputmode', 'numeric');
    if (!input.hasAttribute('maxlength')) input.setAttribute('maxlength', '12'); // 10 digits + 2 dashes
    if (!input.hasAttribute('autocomplete')) input.setAttribute('autocomplete', 'tel');

    input.addEventListener('input', function () {
      var before = input.value;
      var cursorPos = input.selectionStart || before.length;
      var formatted = format(before);
      input.value = formatted;

      // Reposition cursor accounting for added/removed dashes
      var beforeDigits = before.slice(0, cursorPos).replace(/\D/g, '').length;
      var newPos = 0, count = 0;
      for (var i = 0; i < formatted.length; i++) {
        if (count === beforeDigits) { newPos = i; break; }
        if (/\d/.test(formatted[i])) count++;
        newPos = i + 1;
      }
      try { input.setSelectionRange(newPos, newPos); } catch (_) {}

      // Clear invalid state while user is typing
      input.classList.remove('invalid');
    });

    input.addEventListener('blur', function () {
      input.value = format(input.value);
      // Mark invalid (visual cue) — page CSS can target .phone-input.invalid
      if (input.value && !isValid(input.value)) {
        input.classList.add('invalid');
      } else {
        input.classList.remove('invalid');
      }
    });

    // Block non-numeric paste
    input.addEventListener('paste', function (e) {
      try {
        var pasted = (e.clipboardData || window.clipboardData).getData('text');
        if (pasted) {
          e.preventDefault();
          var combined = (input.value + pasted);
          input.value = format(combined);
        }
      } catch (_) {}
    });
  }

  function attachAll() {
    var inputs = document.querySelectorAll('.phone-input, input[data-phone]');
    for (var i = 0; i < inputs.length; i++) attach(inputs[i]);
  }

  // Run on page ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', attachAll);
  } else {
    attachAll();
  }

  // Watch for dynamically added phone inputs (forms loaded later, modals, etc.)
  if (typeof MutationObserver !== 'undefined') {
    var mo = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var added = mutations[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var node = added[j];
          if (node.nodeType !== 1) continue;
          if (node.matches && (node.matches('.phone-input') || node.matches('input[data-phone]'))) {
            attach(node);
          } else if (node.querySelectorAll) {
            var nested = node.querySelectorAll('.phone-input, input[data-phone]');
            for (var k = 0; k < nested.length; k++) attach(nested[k]);
          }
        }
      }
    });
    mo.observe(document.body || document.documentElement, { childList: true, subtree: true });
  }

  // Expose helpers
  window.AILeadIntelPhone = {
    format: format,
    isValid: isValid,
    attach: attach,
  };
})();
