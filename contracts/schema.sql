-- FROZEN CONTRACT. Track A owns this file. B and C read it, never edit it.
-- Need a column? Ask in the group chat. Track A adds it and pushes a migration.
--
-- Run once in the Supabase SQL editor before anyone starts.

create extension if not exists vector;

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------

create table users (
  id uuid primary key default gen_random_uuid(),
  handle text unique,
  created_at timestamptz default now(),
  notes_unlocked_at timestamptz
);

-- zero-install participants (iMessage duel cards, QR scans)
create table devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete cascade,
  fingerprint text unique not null,
  first_seen timestamptz default now()
);

-- ---------------------------------------------------------------------------
-- Corpus
-- ---------------------------------------------------------------------------

create table venues (
  id uuid primary key default gen_random_uuid(),
  gplace_id text unique,
  name text not null,
  lat double precision not null,
  lng double precision not null,
  price_band smallint check (price_band between 1 and 4),
  neighborhood text,
  noise_level smallint,
  popular_times jsonb,
  created_at timestamptz default now()
);

create table dishes (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid references venues(id) on delete cascade,
  name text not null,
  description text,
  price_cents integer,
  phi vector(24),
  phi_confidence real[] check (array_length(phi_confidence, 1) = 24),
  verified boolean default false,          -- diagnostic pool only
  image_url text,
  last_extracted_at timestamptz default now()
);

create index dishes_phi_idx on dishes using ivfflat (phi vector_cosine_ops);
create index dishes_venue_idx on dishes(venue_id);
create index dishes_verified_idx on dishes(verified) where verified = true;

-- ---------------------------------------------------------------------------
-- Signal
-- ---------------------------------------------------------------------------

create table duels (
  id uuid primary key default gen_random_uuid(),
  device_id uuid references devices(id) on delete cascade,
  user_id uuid references users(id) on delete cascade,
  dish_a uuid references dishes(id),
  dish_b uuid references dishes(id),
  winner uuid references dishes(id),
  surface text check (surface in ('feed','imessage','agent','demo')),
  created_at timestamptz default now()
);

create index duels_user_idx on duels(user_id, created_at desc);
create index duels_device_idx on duels(device_id, created_at desc);

create table logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete cascade,
  dish_id uuid references dishes(id),
  rating smallint check (rating between 1 and 5),
  note text,
  created_at timestamptz default now()
);

-- ---------------------------------------------------------------------------
-- Model state
-- ---------------------------------------------------------------------------

create table prefs (
  user_id uuid primary key references users(id) on delete cascade,
  theta vector(24),
  n_comparisons integer default 0,
  posterior_var real,
  updated_at timestamptz default now()
);

create index prefs_theta_idx on prefs using ivfflat (theta vector_cosine_ops);

create table palate_region (
  user_id uuid references users(id) on delete cascade,
  volume real,
  explored_axes text[],
  frontier_axes text[],
  measured_at timestamptz default now(),
  primary key (user_id, measured_at)
);

-- INTERNAL ONLY. Never selected into any API response. Never rendered.
create table reliability (
  user_id uuid primary key references users(id) on delete cascade,
  score real default 0.5,
  n_evaluated integer default 0,
  updated_at timestamptz default now()
);

-- ---------------------------------------------------------------------------
-- Constraints: FILTERS, NEVER FEATURES.
-- Never joined into prefs. Never placed in an LLM prompt. Never returned by an
-- API in any form other than a count. Article 9 special category data.
-- ---------------------------------------------------------------------------

create table constraints (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete cascade,
  kind text not null,        -- 'allergy' | 'religious' | 'dietary' | 'access'
  value text not null,
  source text default 'self', -- 'self' | 'merge_hris'
  consented_at timestamptz not null,
  created_at timestamptz default now()
);

-- ---------------------------------------------------------------------------
-- Enterprise
-- ---------------------------------------------------------------------------

create table orgs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  merge_account_token text,     -- encrypted at rest, server-only
  max_per_head_cents integer,
  created_at timestamptz default now()
);

create table org_members (
  org_id uuid references orgs(id) on delete cascade,
  user_id uuid references users(id) on delete cascade,
  merge_employee_id text,
  consented_at timestamptz,
  primary key (org_id, user_id)
);

-- ---------------------------------------------------------------------------
-- Generation audit: every rendered message keeps its packet, so any sentence
-- can be traced back to the evidence that produced it.
-- ---------------------------------------------------------------------------

create table packets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete cascade,
  packet jsonb not null,
  rendered_text text,
  source_channel text,
  created_at timestamptz default now()
);

-- ---------------------------------------------------------------------------
-- RLS. Not optional.
-- ---------------------------------------------------------------------------

alter table constraints enable row level security;
alter table reliability enable row level security;
alter table prefs enable row level security;
alter table logs enable row level security;

-- constraints: readable only by their own subject. Service role bypasses for
-- the filter path only.
create policy constraints_own on constraints
  for all using (auth.uid() = user_id);

-- reliability: NOBODY reads this via the client. Service role only.
create policy reliability_none on reliability
  for all using (false);

create policy prefs_own on prefs
  for all using (auth.uid() = user_id);

create policy logs_own on logs
  for all using (auth.uid() = user_id);
