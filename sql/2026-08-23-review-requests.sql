-- =====================================================================
--  Google Review Request add-on — schema
--  Run once in the Supabase SQL editor. Safe to re-run (idempotent).
--
--  Adds:
--    1. settings columns on public.clients
--    2. public.review_requests   — one row per queued/sent review ask
--    3. public.sms_opt_outs      — the opt-out ledger (A2P 10DLC evidence)
--
--  Everything is read and written by serverless functions using the service
--  key, so RLS stays ON with no public policies. End-customer phone numbers
--  must never be reachable from the browser's anon key — the dashboard only
--  ever sees the masked last-4 that api/review-settings.js returns.
-- =====================================================================

-- ── 1. CLIENT SETTINGS ───────────────────────────────────────────────
-- Lives on clients (not a separate table) because it is 1:1 with a client
-- and every read of it already has the client row in hand.

alter table public.clients
  add column if not exists google_review_link       text,
  add column if not exists review_requests_enabled  boolean not null default false,
  add column if not exists review_delay_hours       integer not null default 2,
  add column if not exists review_followup_enabled  boolean not null default false,
  add column if not exists review_followup_days     integer not null default 3;

-- Mirrors the limits enforced in api/review-settings.js. Belt and braces:
-- a bad value here would make the cron schedule sends at nonsense times.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'clients_review_delay_hours_range') then
    alter table public.clients
      add constraint clients_review_delay_hours_range
      check (review_delay_hours between 0 and 168);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'clients_review_followup_days_range') then
    alter table public.clients
      add constraint clients_review_followup_days_range
      check (review_followup_days between 1 and 30);
  end if;
end $$;


-- ── 2. REVIEW REQUESTS ───────────────────────────────────────────────

create table if not exists public.review_requests (
  id                  uuid primary key default gen_random_uuid(),
  client_id           uuid not null references public.clients(id) on delete cascade,

  -- Who we're texting
  customer_name       text,
  customer_phone      text not null,               -- E.164, e.g. +15551234567

  -- Snapshotted at queue time so editing the link later can't retarget
  -- messages that were already promised to a customer.
  google_review_link  text not null,
  click_token         text not null,               -- 10 chars, powers /r/<token>

  status              text not null default 'pending',

  -- ── A2P 10DLC CONSENT EVIDENCE ──
  -- No row may exist without these. This is what gets produced if a carrier
  -- or the CTIA asks us to prove the customer agreed to be texted.
  consent_captured_at timestamptz not null,
  consent_method      text        not null,        -- e.g. 'verbal_at_job'
  consent_captured_by text,                        -- the business user who attested

  -- Lifecycle
  job_completed_at    timestamptz,
  scheduled_for       timestamptz not null,
  claimed_at          timestamptz,                 -- cron lock stamp
  sent_at             timestamptz,
  clicked_at          timestamptz,
  follow_up_sent_at   timestamptz,
  opted_out_at        timestamptz,

  twilio_sid          text,
  last_error          text,

  created_at          timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'review_requests_status_check') then
    alter table public.review_requests
      add constraint review_requests_status_check
      check (status in ('pending','sending','sent','clicked','opted_out','failed'));
  end if;
end $$;

-- The click token is a public URL path segment — it must be unique or one
-- customer's click would be recorded against another's request.
create unique index if not exists review_requests_click_token_key
  on public.review_requests (click_token);

-- Cron's hot path: pending rows that are due.
create index if not exists review_requests_due_idx
  on public.review_requests (status, scheduled_for);

-- Follow-up sweep: sent, never clicked, never followed up.
create index if not exists review_requests_followup_idx
  on public.review_requests (status, sent_at)
  where follow_up_sent_at is null and clicked_at is null;

-- Dashboard reads + the duplicate-queue check in review-request-create.js.
create index if not exists review_requests_client_created_idx
  on public.review_requests (client_id, created_at desc);

create index if not exists review_requests_client_phone_idx
  on public.review_requests (client_id, customer_phone);

-- The duplicate check in review-request-create.js is a SELECT followed by an
-- INSERT, which two simultaneous taps of "Job complete" both pass before
-- either writes. Only the database can actually prevent that, so the rule is
-- enforced here: at most ONE undelivered request per customer per client.
-- Partial, so the same customer can be asked again after a completed job.
create unique index if not exists review_requests_one_active_per_phone
  on public.review_requests (client_id, customer_phone)
  where status in ('pending', 'sending');

alter table public.review_requests enable row level security;
-- Deliberately no policies: service key only.


-- ── 3. OPT-OUT LEDGER ────────────────────────────────────────────────
-- Append-only in spirit. Never delete from this table — a STOP is permanent
-- until the customer texts START, which we do not currently support.

create table if not exists public.sms_opt_outs (
  id            uuid primary key default gen_random_uuid(),
  phone         text not null,                     -- E.164
  client_id     uuid not null references public.clients(id) on delete cascade,
  opted_out_at  timestamptz not null default now(),
  source        text not null default 'sms_stop',  -- sms_stop | manual | carrier
  created_at    timestamptz not null default now()
);

-- Required by the upsert in lib/review-requests.js:
--   sms_opt_outs?on_conflict=phone,client_id
-- Without this exact unique index the merge-duplicates Prefer header fails.
create unique index if not exists sms_opt_outs_phone_client_key
  on public.sms_opt_outs (phone, client_id);

alter table public.sms_opt_outs enable row level security;
-- Deliberately no policies: service key only.
