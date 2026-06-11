-- Nightly delta-CRM cross-tab snapshots (lead book vs market heat per industry x geo).
create table if not exists strategy_snapshots (
  id bigint generated always as identity primary key,
  computed_at timestamptz not null default now(),
  data jsonb not null
);
alter table strategy_snapshots enable row level security;
