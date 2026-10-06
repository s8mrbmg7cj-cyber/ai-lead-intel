# Restoring the database

**Status: everything that can be done without your login is done.**
The schema is written and tested. What is left needs you to be signed in to
Supabase, which I can't do.

---

## What happened

The Supabase project the site used is **gone — deleted, not paused.**

`mbrhkeddgmywqqgdfdgx.supabase.co` returns NXDOMAIN from 8.8.8.8, 1.1.1.1
and 9.9.9.9. A paused project keeps its DNS; a deleted one loses it. Checked
2026-10-06.

Nothing looked wrong, which is the dangerous part. `aileadintel.com` returns
200 on every page. Only `/api/health` says so:

```
overall: fail
  supabase    fail - fetch failed     ← the database
  vapi        ok   - key valid
  paypal      ok   - auth ok + plan IDs set (live)
  twilio      ok   - creds valid
  phone_pool  fail - fetch failed     ← same cause
```

Vapi, PayPal and Twilio all succeed from the same server, so this is not a
network or Node problem. The database simply isn't there.

**There is no backup.** The data is not recoverable. What IS recoverable is
the structure, because every table and column is visible in the code, and
that is what `sql/schema.sql` now contains.

---

## What I already did

- **`sql/schema.sql`** — all 9 tables, rebuilt from the code: `clients`,
  `client_onboarding`, `calls`, `phone_pool`, `leads`, `activity_log`,
  `error_log`, `admin_login_log`, plus the `claim_phone_number` function.
  Safe to run more than once.
- **`sql/verify-schema.mjs`** — proves the schema can actually serve the
  site. It reads every column the code asks for (99 of them) and checks each
  one exists. It also has 6 mutation tests: each deletes one column and
  confirms the check notices. A test that can't fail isn't a test.
- **`public/supabase-config.js`** — the project URL and public key used to be
  copy-pasted into **10 separate pages**. Now they live in one file. Missing
  one of those ten would have broken exactly one page, quietly.
- **Removed the hardcoded fallbacks** in `api/provision.js` and
  `api/save-setup.js`. They defaulted to the dead project when the env var
  was missing, which is how a configuration mistake disguises itself as an
  outage.

---

## What you need to do

### 1. Make the new project

1. Go to **supabase.com/dashboard** and sign in.
2. Click **New project**.
3. Name it `ai-lead-intel`.
4. Set a database password and **save it in your password manager now** —
   Supabase will not show it again.
5. Region: **East US (North Virginia)**.
6. Click **Create new project**, then wait about two minutes.

### 2. Create the tables

1. In the left sidebar click **SQL Editor**.
2. Click **New query**.
3. Open `ai-lead-intel/sql/schema.sql`, copy **the whole file**, paste it in.
4. Click **Run**. You want "Success. No rows returned."
5. New query again. Paste the whole of
   `ai-lead-intel/sql/2026-08-23-review-requests.sql`. Click **Run**.
   **This one must go second** — it adds columns to a table the first file
   creates.

### 3. Send me two values

1. Left sidebar → **Project Settings** → **API**.
2. Copy the **Project URL** (looks like `https://abcdefgh.supabase.co`).
3. Copy the **publishable** key (starts `sb_publishable_`).
4. Paste both to me. **Both are public** — they ship to every visitor's
   browser already. I'll put them in `public/supabase-config.js` and push.

**Do not send me the `service_role` / secret key.** That one is a real
credential. It goes in step 4, typed by you, and nowhere else.

### 4. Set the server-side variables in Vercel

1. **vercel.com** → the **ai-lead-intel** project → **Settings** →
   **Environment Variables**.
2. Add or edit these three. Set each for **Production, Preview and
   Development** (the checkboxes under the value):

   | Name | Value | Where it comes from |
   |---|---|---|
   | `SUPABASE_URL` | the Project URL | Settings → API |
   | `SUPABASE_SERVICE_KEY` | the **service_role / secret** key | Settings → API |
   | `SUPABASE_ANON_KEY` | the publishable key | Settings → API |

   `SUPABASE_SERVICE_KEY` is the one that matters most — the code falls back
   to `SUPABASE_SECRET_KEY` and `SUPABASE_SERVICE_ROLE_KEY`, so if either of
   those is already set to an old value, **delete it**, or it may win.

3. Make sure `SUPABASE_WEBHOOK_SECRET` still exists. It's unrelated to the
   new project — it's a shared password between two of our own endpoints —
   but if it's missing, a paid Starter customer never gets provisioned.

### 5. Tell me, and I'll finish

Once steps 1–4 are done say so. I'll push the config change, trigger a
deploy, and check `/api/health`. **It is only fixed when that reads
`overall: ok`.** A page returning 200 proves nothing — the site returned 200
on every page the whole time it was broken.

If you mistype the URL in step 4, `/api/health` will now say so in plain
words — it prints the hostname that failed and that it doesn't resolve.
It used to just say `fetch failed`, which is the reason nobody noticed the
database was gone for a month. That's fixed regardless of the rest of this.

---

## Two things that will still be empty afterwards

The schema is the shape, not the contents.

1. **`phone_pool` will have no rows.** Provisioning a new customer claims a
   free number from it, so with the table empty the first signup fails with
   "out of numbers". The numbers exist in Twilio; they need re-inserting
   here. Tell me when you're at this point and I'll get the list out of
   Twilio and write the inserts.
2. **Every past client, call and lead is gone.** If any of the three ever
   mattered commercially, now is when we'd find out. Nothing in the repo
   suggests there was live customer data — see
   `project_storefix_first_customer.md` for the pattern of checking rather
   than assuming.

---

## Running the checks yourself

```bash
mkdir -p /tmp/pgparse && cd /tmp/pgparse && npm i pg-query-emscripten
cd <repo>
PGQUERY=/tmp/pgparse/node_modules/pg-query-emscripten/pg_query.js \
  node sql/verify-schema.mjs            # expect: PASS — all 99 column references
PGQUERY=/tmp/pgparse/node_modules/pg-query-emscripten/pg_query.js \
  node sql/verify-schema.mjs --mutate   # expect: all 6 mutation tests caught

node scripts/verify-health-errors.mjs  # expect: PASS — all 11 assertions
```

The last one needs no setup and no database. It checks that `/api/health`
names the *cause* of a failure rather than saying `fetch failed`.
