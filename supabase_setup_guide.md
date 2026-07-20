# Omegle 2 — Supabase Setup Guide

This guide is generated directly from your codebase. Every SQL column name, storage path, and environment variable matches what the code expects exactly.

---

## Step 1 — SQL: Create the `profiles` Table

Run this in **Supabase Dashboard → SQL Editor → New Query**.

```sql
-- ════════════════════════════════════════════════════════════════
-- Omegle 2 — Full Schema Bootstrap
-- Run once on a fresh Supabase project.
-- ════════════════════════════════════════════════════════════════

-- ── profiles ────────────────────────────────────────────────────
-- One row per authenticated user.
-- user_id is a FK to auth.users so Supabase can cascade deletes.
-- ────────────────────────────────────────────────────────────────
create table if not exists public.profiles (
  -- Primary key (also the unique conflict target used by .upsert)
  user_id         uuid        not null primary key
                              references auth.users (id) on delete cascade,

  -- Basic demographics
  age             smallint    check (age >= 13 and age <= 120),
  gender          text,

  -- Supabase Storage public URL (avatars bucket)
  profile_picture text,

  -- Interest pill IDs — stored as a text array.
  -- Valid values match the ACTIVITIES catalogue in profile-ui.js:
  --   'gaming','fitness','movies','anime','tech','travel',
  --   'music','art','cooking','sports','books','photography'
  activities      text[]      not null default '{}',

  -- Up to 5 freeform "Artist — Title" strings
  top_songs       text[]      not null default '{}',

  -- Housekeeping
  updated_at      timestamptz not null default now()
);

-- ── Row-Level Security ───────────────────────────────────────────
-- Enable RLS so that users can only read/write their own row.
alter table public.profiles enable row level security;

-- Users can read their own profile
create policy "Own profile is readable"
  on public.profiles
  for select
  using ( auth.uid() = user_id );

-- Users can insert / update their own profile
create policy "Own profile is writable"
  on public.profiles
  for insert
  with check ( auth.uid() = user_id );

create policy "Own profile is updatable"
  on public.profiles
  for update
  using ( auth.uid() = user_id );

-- ── Optional helper: auto-set updated_at on every update ────────
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_updated_at
  before update on public.profiles
  for each row execute procedure public.set_updated_at();
```

> [!IMPORTANT]
> The conflict resolution key used by `profile.js` is `user_id`:
> ```js
> .upsert(payload, { onConflict: 'user_id' })
> ```
> The `primary key` on `user_id` above satisfies this automatically — no extra unique index needed.

---

## Step 2 — Storage: Create the `avatars` Bucket

Your code in [`profile.js`](file:///c:/Users/Work/Desktop/OMEGLE%202/omegle2/public/js/profile.js) uploads to:

```
bucket : avatars
path   : {userId}/{timestamp}.{ext}
```

### In the Dashboard
1. Go to **Storage → New bucket**
2. Name it exactly: **`avatars`**
3. Toggle **Public bucket: ON** ✅  
   *(The code calls `.getPublicUrl(path)` — this only works for public buckets.)*
4. Leave all other settings as default.

### Storage RLS Policies
After creating the bucket, add these policies in **Storage → avatars → Policies**:

```sql
-- Allow authenticated users to upload to their own folder
create policy "Users upload own avatar"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Allow public read (required because getPublicUrl is used without a token)
create policy "Public avatar read"
  on storage.objects
  for select
  to public
  using ( bucket_id = 'avatars' );

-- Allow users to overwrite their own avatar (upsert: true in code)
create policy "Users update own avatar"
  on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
```

---

## Step 3 — Authentication: Google OAuth Provider

Your [`auth.js`](file:///c:/Users/Work/Desktop/OMEGLE%202/omegle2/public/js/auth.js) calls:

```js
_sb.auth.signInWithOAuth({
  provider: 'google',
  options: { redirectTo: window.location.origin },
});
```

`redirectTo: window.location.origin` means the callback URL is simply the **root of wherever the app is hosted**.

### In the Dashboard
Go to **Authentication → Providers → Google** and enable it.

You will need a Google Cloud OAuth 2.0 client. Here's what to put where:

| Setting | Value |
|---|---|
| **Google Client ID** | From Google Cloud Console |
| **Google Client Secret** | From Google Cloud Console |

### In Google Cloud Console
1. Go to **APIs & Services → Credentials → Create Credentials → OAuth 2.0 Client ID**
2. Application type: **Web application**
3. Add the following **Authorized redirect URIs**:

| Environment | Redirect URI |
|---|---|
| **Supabase callback (always required)** | `https://<your-project-ref>.supabase.co/auth/v1/callback` |
| **Local dev** | `http://localhost:3000` |
| **Docker (host port 3001)** | `http://localhost:3001` |
| **Production** | `https://yourdomain.com` |

> [!IMPORTANT]
> The Supabase callback URI is **mandatory** regardless of your app URL. Supabase handles the OAuth code exchange server-side, then redirects back to `window.location.origin`.

### In Supabase Dashboard → Authentication → URL Configuration

| Field | Value |
|---|---|
| **Site URL** | Your production URL (e.g. `https://yourdomain.com`) |
| **Redirect URLs (allowlist)** | Add every origin the app may run on, e.g.: `http://localhost:3000`, `http://localhost:3001`, `https://yourdomain.com` |

---

## Step 4 — Environment Variables

### Where the app reads them

`server.js` uses `dotenv` at the very top:

```js
require('dotenv').config();
// then later:
process.env.SUPABASE_URL
process.env.SUPABASE_ANON_KEY
```

The server exposes them to the browser via the `/config` endpoint. The browser **never** receives them directly from the environment — only through that fetch.

### The two variables

| Variable | Where to find it in Supabase |
|---|---|
| `SUPABASE_URL` | Dashboard → Project Settings → API → **Project URL** |
| `SUPABASE_ANON_KEY` | Dashboard → Project Settings → API → **anon / public** key |

> [!NOTE]
> The **anon key** is intentionally public-safe. Row-Level Security policies (set up in Step 1 & 2) are what restrict data access — not key secrecy.
> Do **not** put the `service_role` key in `.env` unless you add server-side admin operations.

---

### Scenario A — Running Locally (`node server.js`)

Edit **[`.env`](file:///c:/Users/Work/Desktop/OMEGLE%202/omegle2/.env)** in the project root:

```dotenv
SUPABASE_URL=https://<your-project-ref>.supabase.co
SUPABASE_ANON_KEY=eyJ...your-anon-key...
```

This file is already present and loaded by `require('dotenv').config()`. ✅  
It is already in [`.gitignore`](file:///c:/Users/Work/Desktop/OMEGLE%202/omegle2/.gitignore) — do not commit it.

---

### Scenario B — Running with Docker Compose

Your [`docker-compose.yml`](file:///c:/Users/Work/Desktop/OMEGLE%202/omegle2/docker-compose.yml) already reads the same `.env` file via variable interpolation:

```yaml
environment:
  - SUPABASE_URL=${SUPABASE_URL}
  - SUPABASE_ANON_KEY=${SUPABASE_ANON_KEY}
```

So the **exact same `.env` file** from Scenario A works here too. Docker Compose automatically loads `.env` from the project root when you run `docker compose up`. Nothing extra needed. ✅

> [!TIP]
> If you're deploying to a server without a `.env` file (e.g. a VPS with environment variables set system-wide or via a secrets manager), the `docker-compose.yml` interpolation will still work — just set `SUPABASE_URL` and `SUPABASE_ANON_KEY` as system environment variables on the host.

---

## Quick Verification Checklist

```
[ ] SQL: profiles table created with all 7 columns
[ ] SQL: RLS enabled on profiles (select + insert + update policies)
[ ] SQL: updated_at trigger created
[ ] Storage: "avatars" bucket created as PUBLIC
[ ] Storage: 3 RLS policies on storage.objects (insert, select, update)
[ ] Auth: Google provider enabled with Client ID + Secret
[ ] Google Cloud: Supabase callback URI added to allowed redirects
[ ] Google Cloud: localhost:3000 / localhost:3001 / prod URL added
[ ] Supabase: Site URL and Redirect URL allowlist configured
[ ] .env: SUPABASE_URL and SUPABASE_ANON_KEY filled in
[ ] Test: Sign in with Google works
[ ] Test: Profile modal saves without error
[ ] Test: Avatar upload appears in Storage → avatars bucket
[ ] Test: Two browser tabs can connect to each other via video
```
