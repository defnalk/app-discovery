-- App discovery engine: core schema.
-- Apply with: supabase db push   (or paste into the Supabase SQL editor)

create table if not exists apps (
  id uuid primary key default gen_random_uuid(),
  store_id text not null,
  store text not null check (store in ('apple', 'google')),
  name text not null,
  developer_name text,
  developer_domain text,
  category text,
  description text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  status text not null default 'active',
  unique (store_id, store)
);

-- Append-only time series. One row per app/geo/chart/source/day keeps reruns idempotent.
create table if not exists app_snapshots (
  id bigint generated always as identity primary key,
  app_id uuid not null references apps(id) on delete cascade,
  captured_at timestamptz not null default now(),
  snapshot_date date not null default current_date,
  geo text not null,
  chart_rank int,
  chart_type text not null,
  rating numeric,
  rating_count bigint,
  installs bigint,
  source text not null,
  unique (app_id, geo, chart_type, source, snapshot_date)
);
create index if not exists app_snapshots_app_geo_time on app_snapshots (app_id, geo, captured_at desc);
create index if not exists app_snapshots_date on app_snapshots (snapshot_date);

-- Claims harvested from X / Product Hunt, fact-checked against store data.
create table if not exists app_claims (
  id bigint generated always as identity primary key,
  app_id uuid references apps(id) on delete cascade,
  claimed_metric text not null,
  claimed_value numeric,
  claim_source_url text,
  verified_value numeric,
  discrepancy_ratio numeric,
  captured_at timestamptz not null default now(),
  unique (app_id, claimed_metric, claim_source_url)
);

-- Apollo firmographics for shortlisted apps' developers.
create table if not exists app_companies (
  id bigint generated always as identity primary key,
  app_id uuid not null references apps(id) on delete cascade,
  apollo_org_id text,
  hq text,
  stage text,
  employee_count int,
  contact_name text,
  contact_email text,
  enriched_at timestamptz,
  unique (app_id)
);

-- Momentum components, one row per app per geo (overwritten each scoring run).
create table if not exists app_scores (
  app_id uuid not null references apps(id) on delete cascade,
  geo text not null,
  computed_at timestamptz not null default now(),
  rank_now int,
  rank_prev int,
  rank_velocity numeric,
  rating_growth numeric,
  momentum_score numeric,
  primary key (app_id, geo)
);

-- Per-app rollup the dashboard reads (overwritten each scoring run).
create table if not exists app_rollups (
  app_id uuid primary key references apps(id) on delete cascade,
  computed_at timestamptz not null default now(),
  momentum_score numeric,
  geos_live text[] not null default '{}',
  new_geos text[] not null default '{}',
  geo_gap text[] not null default '{}',
  is_incumbent boolean not null default false,
  shortlisted boolean not null default false,
  best_rank int,
  rating numeric,
  rating_count bigint,
  fact_check_flag boolean not null default false
);

-- Provenance for every job run (Apify run ids land in detail).
create table if not exists ingest_runs (
  id bigint generated always as identity primary key,
  source text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  ok boolean,
  detail jsonb
);

-- Service-role key bypasses RLS; enabling it with no policies locks out anon access.
alter table apps enable row level security;
alter table app_snapshots enable row level security;
alter table app_claims enable row level security;
alter table app_companies enable row level security;
alter table app_scores enable row level security;
alter table app_rollups enable row level security;
alter table ingest_runs enable row level security;
