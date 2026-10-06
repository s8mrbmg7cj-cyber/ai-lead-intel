/* ─────────────────────────────────────────────────────────────────────
   Supabase connection details for the BROWSER.

   THE ONLY PLACE THESE TWO VALUES LIVE.

   They used to be pasted into ten separate pages — account, sign-in,
   create-password, reset-password, dashboard-app, phone-setup, setup,
   go-live, admin and mission/control. When the Supabase project was
   deleted in October 2026, pointing the site at a new one meant finding
   and editing twenty lines across ten files, and missing one would break
   exactly one page in a way nobody notices until a customer hits it.

   Both values below are PUBLIC. The URL is public by definition and the
   publishable key is designed to ship to browsers — it can only do what
   row-level security allows, and every table in sql/schema.sql has RLS on
   with no policies. The key that must never appear in this directory is
   the service role key; it lives in Vercel's environment only.

   TO POINT THE SITE AT A NEW SUPABASE PROJECT:
   change the two values here, and set SUPABASE_URL, SUPABASE_SERVICE_KEY
   and SUPABASE_ANON_KEY in Vercel for the server side. Nothing else.
   ───────────────────────────────────────────────────────────────────── */

window.SUPABASE_URL = 'https://mbrhkeddgmywqqgdfdgx.supabase.co';
window.SUPABASE_ANON_KEY = 'sb_publishable__YkhmAu61Nr8VetJS8pJqA_MHrmO69t';

/* A page that loads before this file would call createClient(undefined,
   undefined) and fail with a message about an invalid URL, which reads
   like a Supabase outage rather than a missing script tag. Say what it
   actually is. */
if (!window.SUPABASE_URL || !window.SUPABASE_ANON_KEY) {
  console.error('[supabase-config] values missing — did this page forget <script src="/supabase-config.js"></script> in <head>?');
}
