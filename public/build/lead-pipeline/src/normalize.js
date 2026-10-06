// Node 1 of 3 — Normalize & validate.
//
// Accepts three shapes without caring which: a Meta Lead Ads webhook, a plain
// JSON website form, or a form-encoded POST. Emits one flat lead object.
//
// Rule that matters: a lead is only INVALID if we cannot reach the human.
// Everything else is a warning. A missing name is not a reason to drop someone
// who left a working phone number.

function normalizeLead(raw) {
  const flat = {};

  // Meta Lead Ads nests the answers in entry[].changes[].value.field_data[].
  const fd =
    raw?.entry?.[0]?.changes?.[0]?.value?.field_data ||
    raw?.field_data ||
    null;

  if (Array.isArray(fd)) {
    for (const f of fd) {
      const key = String(f?.name ?? '').toLowerCase().trim();
      if (!key) continue;
      flat[key] = Array.isArray(f?.values) ? f.values[0] : f?.value;
    }
  }

  // Plain form shapes: take every scalar at the top level.
  for (const [k, v] of Object.entries(raw ?? {})) {
    if (typeof v === 'string' || typeof v === 'number') {
      flat[k.toLowerCase().trim()] = v;
    }
  }

  const pick = (...names) => {
    for (const n of names) {
      const v = flat[n];
      if (v !== undefined && v !== null && String(v).trim() !== '') {
        return String(v).trim();
      }
    }
    return '';
  };

  const name = pick('full_name', 'fullname', 'name', 'contact_name', 'first_name');
  const emailRaw = pick('email', 'email_address', 'work_email').toLowerCase();
  const phoneRaw = pick('phone', 'phone_number', 'mobile', 'tel', 'telephone');
  const message = pick(
    'message', 'notes', 'comments', 'details', 'job_description',
    'describe_your_project', 'what_do_you_need', 'how_can_we_help'
  );
  const service = pick('service', 'service_needed', 'job_type', 'category', 'what_service');
  const city = pick('city', 'town', 'location');
  const zip = pick('zip', 'zip_code', 'postal_code', 'postcode');
  const source = pick('source', 'utm_source', 'platform') ||
    (Array.isArray(fd) ? 'meta_lead_ads' : 'web_form');

  // Phone → E.164. Twilio rejects anything else, so do it here, once.
  const digits = phoneRaw.replace(/[^\d]/g, '');
  let phone = '';
  if (digits.length === 10) phone = '+1' + digits;
  else if (digits.length === 11 && digits.startsWith('1')) phone = '+' + digits;
  else if (digits.length >= 11 && digits.length <= 15) phone = '+' + digits;

  // The domain is one or more dot-separated labels followed by a TLD. The first
  // version of this pattern forbade dots inside the domain, which silently
  // rejected every "@company.co.uk" and every subdomain address — and a lead who
  // left only that email was then marked unreachable and never contacted at all.
  // Deliberately not RFC 5322: the only question is whether it is worth sending
  // to, and anything this lets through that bounces will bounce visibly.
  const emailOk = /^[^@\s]+@([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(emailRaw);
  const email = emailOk ? emailRaw : '';

  const errors = [];
  const warnings = [];

  // The ONLY fatal condition: nobody to contact.
  if (!phone && !email) {
    errors.push('unreachable: no usable phone and no usable email');
  }
  if (phoneRaw && !phone) warnings.push(`phone could not be parsed: "${phoneRaw}"`);
  if (emailRaw && !emailOk) warnings.push(`email could not be parsed: "${emailRaw}"`);
  if (!name) warnings.push('no name supplied');
  if (!message && !service) warnings.push('no message and no service selected');

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    lead: {
      name,
      email,
      phone,
      message,
      service,
      city,
      zip,
      source,
      received_at: new Date().toISOString(),
      t0: Date.now(),
      // Used to suppress a duplicate alert if the same person submits twice.
      dedupe_key: (phone || email || name).toLowerCase(),
      raw_field_count: Object.keys(flat).length,
    },
  };
}

export { normalizeLead };
