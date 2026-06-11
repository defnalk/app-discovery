-- Per-app analysis: market saturation, idea quality, vibecoding buildability.
-- Written by the analyze job (multi-agent now, Haiku nightly for new apps).

create table if not exists app_analysis (
  app_id uuid primary key references apps(id) on delete cascade,
  analyzed_at timestamptz not null default now(),
  model_version text,
  idea_score numeric,           -- 0-10: how good an opportunity the concept is
  idea_note text,
  buildability text,            -- weekend | few_days | week_or_two | months | too_complex
  buildability_note text,
  saturation numeric,           -- 0-1: how crowded the category is
  saturation_note text,
  too_complex boolean not null default false
);
alter table app_analysis enable row level security;
