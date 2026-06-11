-- Lead intelligence section. The core tables below ARE the 8x_lead_intel
-- schema (leads / classifications / exclusions / config / threshold_suggestions /
-- campaigns / campaign_leads / events / runs) — created only if absent so this
-- is a no-op against a Supabase project where 8x_lead_intel already ran its
-- migrations. We reuse `events` as the lead_events table (same shape) and
-- `threshold_suggestions` as the suggestions table. No parallel lead tables.

create table if not exists leads (
  id uuid primary key default gen_random_uuid(),
  run_id text,
  source_arm text not null, -- new_entrant | lookalike | linkedin_hiring | apollo_websearch | app_discovery
  company text,
  domain text,
  email text,
  email_status text,
  contact_name text,
  contact_title text,
  category text,
  hq text,
  raw_payload jsonb,
  created_at timestamptz not null default now(),
  unique (domain, email)
);

create table if not exists classifications (
  id bigint generated always as identity primary key,
  lead_id uuid not null references leads(id) on delete cascade,
  model_version text,
  config_version text,
  business_model text,
  company_stage text,
  can_afford_icp boolean,
  market_status text,
  fit_verdict text,
  expansion_confidence numeric,
  jaka_score numeric,
  reason text,
  classified_at timestamptz not null default now()
); -- append-only; reclassification inserts a new row

create table if not exists exclusions (
  id bigint generated always as identity primary key,
  domain text not null,
  reason text,
  source text, -- client | manual | bounce | unsubscribe
  added_at timestamptz not null default now()
);

create table if not exists config (
  key text not null,
  value jsonb not null,
  version int not null default 1,
  active boolean not null default true,
  primary key (key, version)
);

create table if not exists threshold_suggestions (
  id bigint generated always as identity primary key,
  proposed jsonb not null,
  rationale text,
  evidence jsonb,
  status text not null default 'pending', -- pending | approved | rejected
  decided_by text,
  decided_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists campaigns (
  id uuid primary key default gen_random_uuid(),
  instantly_campaign_id text,
  name text not null,
  status text not null default 'draft', -- draft | pending_approval | approved | live | done | rejected
  approved_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists campaign_leads (
  campaign_id uuid not null references campaigns(id) on delete cascade,
  lead_id uuid not null references leads(id) on delete cascade,
  instantly_lead_id text,
  send_status text,
  primary key (campaign_id, lead_id)
);

create table if not exists events (
  id bigint generated always as identity primary key,
  lead_id uuid references leads(id) on delete cascade,
  campaign_id uuid references campaigns(id) on delete set null,
  type text not null, -- sent | open | reply | positive_reply | meeting | bounce | unsubscribe
  payload jsonb,
  occurred_at timestamptz not null
);

create table if not exists runs (
  id bigint generated always as identity primary key,
  stage text not null,
  started_at timestamptz,
  finished_at timestamptz,
  input_count int,
  output_count int,
  error_count int,
  notes text
);

-- ---- Migrations of existing tables: fields this dashboard needs ----
alter table leads add column if not exists geo text;                -- sourcing pools: tr, br, mx, in, …
alter table leads add column if not exists signal_source_url text; -- provenance of the originating signal
alter table leads add column if not exists enriched_at timestamptz;
alter table leads add column if not exists stage text;             -- materialized funnel stage (funnel_rollup job)
alter table leads alter column source_arm set not null;
alter table config add column if not exists updated_at timestamptz default now();
alter table config add column if not exists updated_by text;

-- Idempotent instantly_sync upserts need a natural key on events.
create unique index if not exists events_natural_key
  on events (lead_id, campaign_id, type, occurred_at);
create index if not exists events_type_time on events (type, occurred_at);
create index if not exists leads_arm on leads (source_arm);
create index if not exists leads_stage on leads (stage);
create index if not exists classifications_lead on classifications (lead_id, classified_at desc);

-- ---- New tables (absent from 8x_lead_intel) ----

-- Human gate #1: nothing reaches Instantly without a row here.
create table if not exists approvals (
  id bigint generated always as identity primary key,
  batch_id uuid not null references campaigns(id) on delete cascade,
  lead_ids uuid[] not null,
  excluded_lead_ids uuid[] not null default '{}',
  status text not null check (status in ('approved', 'rejected')),
  approved_by text not null,
  note text,
  created_at timestamptz not null default now()
);

-- Human gate #2 audit trail: every settings change, suggested or manual.
create table if not exists settings_audit (
  id bigint generated always as identity primary key,
  setting text not null,
  old_value jsonb,
  new_value jsonb,
  suggested_by text not null check (suggested_by in ('system', 'user')),
  approved_by text not null,
  created_at timestamptz not null default now()
);

-- Materialized funnel counts so the Pipeline page is one query.
create table if not exists funnel_rollups (
  stage text not null,
  source_arm text not null default '*',
  geo text not null default '*',
  count int not null,
  computed_at timestamptz not null default now(),
  primary key (stage, source_arm, geo)
);

alter table leads enable row level security;
alter table classifications enable row level security;
alter table exclusions enable row level security;
alter table config enable row level security;
alter table threshold_suggestions enable row level security;
alter table campaigns enable row level security;
alter table campaign_leads enable row level security;
alter table events enable row level security;
alter table runs enable row level security;
alter table approvals enable row level security;
alter table settings_audit enable row level security;
alter table funnel_rollups enable row level security;
