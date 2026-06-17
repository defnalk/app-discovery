-- Play ops layer: lets the play-manager + engineer pairs CLAIM/RESERVE a play so
-- two pairs never build the same app, and SUBMIT their own play ideas; admins
-- (Defne, Hussain) review both. Lightweight auth (name + shared team passcode) for
-- the rough draft — upgrade to real accounts + the place-dashboard API later.
-- Additive + idempotent.

create table if not exists play_managers (
  id          bigint generated always as identity primary key,
  name        text not null,
  email       text,
  role        text not null default 'manager',   -- manager | admin
  created_at  timestamptz not null default now(),
  unique (name)
);

create table if not exists play_claims (
  id           bigint generated always as identity primary key,
  subject_type text not null,                     -- app | idea
  subject_id   text not null,                     -- app id / store_id / idea dedup_key
  subject_name text,                              -- denormalized for display
  category     text,
  manager_name text not null,                     -- who reserved it
  status       text not null default 'reserved',  -- reserved | started | released | done
  claimed_at   timestamptz not null default now(),
  start_by     timestamptz,                       -- claimed_at + 24h (start-or-lose timer)
  started_at   timestamptz,                       -- when they actually began building
  note         text,
  unique (subject_type, subject_id)               -- one active claim per play → no double-builds
);
create index if not exists play_claims_manager_idx on play_claims (manager_name);

create table if not exists play_submissions (
  id           bigint generated always as identity primary key,
  manager_name text not null,
  app_name     text not null,
  category     text,
  market       text,
  pitch        text,                              -- the idea / why it's a good play
  details      jsonb,                             -- flexible extra fields (form spec evolves)
  status       text not null default 'submitted', -- submitted | approved | rejected
  submitted_at timestamptz not null default now()
);
