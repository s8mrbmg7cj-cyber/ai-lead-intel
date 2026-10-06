-- =====================================================================
--  AI Lead Intel — FULL BASE SCHEMA
--
--  WHY THIS FILE EXISTS
--  The original Supabase project was deleted. On 2026-10-06 the host
--  mbrhkeddgmywqqgdfdgx.supabase.co returned NXDOMAIN from 8.8.8.8,
--  1.1.1.1 and 9.9.9.9 (a paused project keeps its DNS; a deleted one
--  does not), and /api/health reported `supabase fail - fetch failed`
--  while vapi, paypal and twilio all passed from the same runtime.
--  No dump survived, so this schema was RECONSTRUCTED FROM THE CODE:
--  every column below is written or read by a file in api/ or lib/.
--
--  HOW TO RUN
--    1. Supabase dashboard → SQL Editor → paste this whole file → Run.
--    2. Then run sql/2026-08-23-review-requests.sql (it ALTERs
--       public.clients, so it must come second).
--    3. Set SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY
--       in Vercel, redeploy, and check /api/health reads `overall: ok`.
--
--  Safe to re-run: every statement is idempotent.
--
--  RLS is ON everywhere with NO policies. Every read and write in this
--  product goes through a serverless function holding the service role
--  key, which bypasses RLS. The browser's anon key must never be able
--  to reach a client's phone number, transcript or payment id.
--  One deliberate exception is noted on clients.
-- =====================================================================

create extension if not exists pgcrypto;   -- gen_random_uuid()


-- ── 1. CLIENT_ONBOARDING ─────────────────────────────────────────────
-- The raw intake form, saved verbatim BEFORE any interpretation. The
-- clients row is derived from it; this table is the receipt. Created
-- first because clients.onboarding_id references it.

create table if not exists public.client_onboarding (
  id                    uuid primary key default gen_random_uuid(),

  business_name         text,
  industry              text,
  business_phone        text,

  forward_number        text,
  backup_number         text,
  transfer_hours        text,
  offer_urgent_transfer boolean not null default false,

  voicemail_email       text,
  call_reasons          text,
  services_offered      text,
  service_area          text,
  payment_link          text,
  booking_link          text,
  info_link             text,
  tone                  text,
  notes                 text,

  status                text not null default 'new',

  -- The untouched form body. If a column above is ever wrong, this is
  -- what it can be re-derived from.
  raw_data              jsonb,

  created_at            timestamptz not null default now()
);

create index if not exists client_onboarding_created_idx
  on public.client_onboarding (created_at desc);

alter table public.client_onboarding enable row level security;


-- ── 2. CLIENTS ───────────────────────────────────────────────────────
-- The account row. One per paying business.

create table if not exists public.clients (
  id                     uuid primary key default gen_random_uuid(),

  business_name          text,
  client_slug            text,                 -- URL identity; unique below
  notify_email           text,
  phone_number           text,                 -- the BUSINESS's own number
  plan                   text,
  status                 text not null default 'pending',
  active                 boolean not null default true,
  notes                  text,

  onboarding_id          uuid references public.client_onboarding(id) on delete set null,

  -- Supabase Auth user. Nullable: a client row is created at payment,
  -- before the customer has chosen a password.
  owner_user_id          uuid,

  -- Business profile (editable later by api/save-setup.js)
  industry               text,
  website                text,
  business_type          text,
  business_hours         text,
  service_area           text,
  services_offered       text,
  forwarding_number      text,
  transfer_destination   text,
  emergency_rules        text,
  offer_urgent_transfer  boolean not null default false,

  -- Receptionist configuration
  caller_greeting        text,
  voice_style            text,
  ai_prompt              text,
  ai_greeting            text,
  ai_personality         text,
  transfer_behavior      text,
  services_summary       text,
  faq_summary            text,
  ai_setup_status        text,                 -- 'ready' | 'live'
  setup_complete         boolean not null default false,

  -- Notifications
  ntfy_topic             text,
  alert_sms_number       text,
  setup_email_sent       boolean not null default false,
  setup_email_sent_at    timestamptz,
  report_frequency       text,
  report_email           text,
  last_report_sent_at    timestamptz,

  -- Billing
  payment_amount         numeric(10,2),
  payment_provider       text,                 -- 'stripe' | 'paypal'
  payment_required       boolean not null default true,
  payment_pending        boolean not null default true,
  payment_status         text not null default 'unpaid',
  payment_external_id    text,                 -- Stripe sub/session or PayPal sub id
  payment_link           text,
  paid_at                timestamptz,

  -- Provisioning
  -- provision_requested_at is a ONE-TIME LOCK, not a timestamp for
  -- humans. onboarding-return.js and stripe-webhook.js both try to
  -- provision the same Starter client; each does
  --   PATCH ...&provision_requested_at=is.null
  -- so exactly one of them gets rows back and proceeds. If this column
  -- is missing or gets a default, BOTH provision and the customer is
  -- charged for two phone numbers.
  provision_requested_at timestamptz,
  twilio_number          text,
  vapi_assistant_id      text,
  vapi_phone_number_id   text,

  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

-- api/onboarding-submit.js depends on BOTH of these existing: it catches
-- the 409 they raise, then retries without the phone and with a suffixed
-- slug. Without the indexes there is no 409, the retry never runs, and
-- duplicate accounts are created silently.
create unique index if not exists clients_client_slug_key
  on public.clients (client_slug);

create unique index if not exists clients_phone_number_key
  on public.clients (phone_number)
  where phone_number is not null;

-- Hot lookups: every payment webhook resolves a client by one of these.
create index if not exists clients_payment_external_id_idx
  on public.clients (payment_external_id);

create index if not exists clients_owner_user_id_idx
  on public.clients (owner_user_id);

-- api/send-report.js's cron selector.
create index if not exists clients_report_selector_idx
  on public.clients (plan, report_frequency, active);

alter table public.clients enable row level security;
-- api/save-setup.js prefers the service key but falls back to the
-- signed-in user's token, which only works if an owner UPDATE policy
-- exists. None is created here on purpose: with SUPABASE_SERVICE_ROLE_KEY
-- set in Vercel the fallback is never taken, and adding the policy would
-- expose every column above to the browser.


-- ── 3. PHONE_POOL ────────────────────────────────────────────────────
-- Numbers bought in advance. client_id IS NULL means available.

create table if not exists public.phone_pool (
  id                   uuid primary key default gen_random_uuid(),
  phone_number         text not null,
  client_id            uuid references public.clients(id) on delete set null,
  assigned_at          timestamptz,
  vapi_phone_number_id text,
  created_at           timestamptz not null default now()
);

-- A number can exist once. Every release/claim path in provision.js,
-- stripe-webhook.js and paypal-webhook.js addresses rows by
-- phone_number=eq.<n> and assumes it matches at most one row.
create unique index if not exists phone_pool_phone_number_key
  on public.phone_pool (phone_number);

-- The free-pool scan in /api/health and health-extras.js.
create index if not exists phone_pool_free_idx
  on public.phone_pool (client_id);

alter table public.phone_pool enable row level security;


-- ── 3b. CLAIM_PHONE_NUMBER ───────────────────────────────────────────
-- Called as POST /rest/v1/rpc/claim_phone_number {"p_client_id": "..."}
-- by api/provision.js.
--
-- This is a function and not a SELECT-then-UPDATE in the API for one
-- reason: two clients paying in the same second would both read the same
-- free row and both be given the same phone number. FOR UPDATE SKIP
-- LOCKED makes the second caller step over the locked row and take the
-- next free one. Returns zero rows when the pool is empty — provision.js
-- treats that as "out of numbers" and alerts, so do not make it raise.

create or replace function public.claim_phone_number(p_client_id uuid)
returns table (
  id                   uuid,
  phone_number         text,
  vapi_phone_number_id text,
  client_id            uuid,
  assigned_at          timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  -- Idempotent: if this client already holds a number, hand back the
  -- same one. provision.js can be retried safely.
  select p.id into v_id
    from public.phone_pool p
   where p.client_id = p_client_id
   limit 1;

  if v_id is null then
    select p.id into v_id
      from public.phone_pool p
     where p.client_id is null
     order by p.created_at
     for update skip locked
     limit 1;
  end if;

  if v_id is null then
    return;                      -- pool empty; caller handles it
  end if;

  return query
    update public.phone_pool p
       set client_id   = p_client_id,
           assigned_at = coalesce(p.assigned_at, now())
     where p.id = v_id
   returning p.id, p.phone_number, p.vapi_phone_number_id, p.client_id, p.assigned_at;
end;
$$;


-- ── 4. CALLS ─────────────────────────────────────────────────────────
-- One row per completed Vapi call, written by api/vapi/call-ended.js.

create table if not exists public.calls (
  id                 uuid primary key default gen_random_uuid(),

  -- NOTE: the owning client is client_uuid, NOT client_id. This is the
  -- only column call-ended.js writes and the only one the dashboard
  -- reads. api/send-report.js once queried client_id here and every
  -- report shipped all-zero stats. Do not add a client_id column.
  client_uuid        uuid references public.clients(id) on delete cascade,

  vapi_call_id       text,
  assistant_id       text,
  phone_number_id    text,

  caller_number      text,
  caller_name        text,
  duration_seconds   integer,
  call_status        text,
  ended_reason       text,
  transcript         text,
  summary            text,
  recording_url      text,

  -- Derived by the lead analyser in call-ended.js
  lead_score         integer,
  outcome            text,
  asked_for_transfer boolean,
  asked_for_pricing  boolean,

  raw_payload        jsonb,

  created_at         timestamptz not null default now()
);

-- Vapi retries webhooks. Without this, one call can be stored twice and
-- every report double-counts it.
create unique index if not exists calls_vapi_call_id_key
  on public.calls (vapi_call_id)
  where vapi_call_id is not null;

-- The report window query: client_uuid + created_at range, newest first.
create index if not exists calls_client_created_idx
  on public.calls (client_uuid, created_at desc);

create index if not exists calls_created_idx
  on public.calls (created_at desc);

alter table public.calls enable row level security;


-- ── 5. LEADS ─────────────────────────────────────────────────────────
-- Inbound interest in AI Lead Intel itself (website form, scanner,
-- Facebook lead ads) — NOT a client's customers.

create table if not exists public.leads (
  id            uuid primary key default gen_random_uuid(),
  business_name text,
  contact_name  text,
  email         text,
  phone         text,
  website       text,
  industry      text,
  source        text,                       -- 'lead_form' | 'scanner' | 'facebook'
  status        text not null default 'new',
  notes         text,
  created_at    timestamptz not null default now()
);

create index if not exists leads_created_idx
  on public.leads (created_at desc);

alter table public.leads enable row level security;


-- ── 6. ACTIVITY_LOG ──────────────────────────────────────────────────
-- api/supabase-webhook.js reads this BEFORE sending a setup email:
--   ?client_id=eq.<id>&action=eq.setup_email_sent&limit=1
-- i.e. the log is load-bearing, not decorative. If this table is empty
-- or missing, the duplicate check cannot see the earlier send and the
-- customer gets the welcome email twice.

create table if not exists public.activity_log (
  id         uuid primary key default gen_random_uuid(),
  client_id  uuid references public.clients(id) on delete cascade,
  action     text not null,
  details    text,
  created_at timestamptz not null default now()
);

create index if not exists activity_log_client_action_idx
  on public.activity_log (client_id, action);

alter table public.activity_log enable row level security;


-- ── 7. ERROR_LOG ─────────────────────────────────────────────────────

create table if not exists public.error_log (
  id            uuid primary key default gen_random_uuid(),
  page          text,
  action        text,
  error_message text,
  client_slug   text,
  user_agent    text,
  stack_trace   text,
  created_at    timestamptz not null default now()
);

create index if not exists error_log_created_idx
  on public.error_log (created_at desc);

alter table public.error_log enable row level security;


-- ── 8. ADMIN_LOGIN_LOG ───────────────────────────────────────────────
-- Every admin login attempt, success or failure. Append-only in spirit.

create table if not exists public.admin_login_log (
  id         uuid primary key default gen_random_uuid(),
  ip         text,
  user_agent text,
  outcome    text,                           -- 'success' | 'failure'
  reason     text,
  created_at timestamptz not null default now()
);

create index if not exists admin_login_log_created_idx
  on public.admin_login_log (created_at desc);

alter table public.admin_login_log enable row level security;


-- ── 9. UPDATED_AT ────────────────────────────────────────────────────
-- api/mark-live.js and the onboarding PATCH both send updated_at
-- explicitly, but nothing else does. The trigger makes the column true
-- for every write rather than only the two that remember.

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists clients_touch_updated_at on public.clients;
create trigger clients_touch_updated_at
  before update on public.clients
  for each row execute function public.touch_updated_at();
