-- Idea Radar: candidate app ideas surfaced from social chatter (X / LinkedIn /
-- Product Hunt / web), scored upstream of the store charts. Additive; safe to
-- re-run. The ingest + analyze jobs are token-gated, so this table simply sits
-- empty until APIFY_TOKEN / ANTHROPIC_API_KEY are set.
create table if not exists idea_radar (
  id            bigint generated always as identity primary key,
  dedup_key     text unique not null,            -- stable id (source + url/name)
  source        text not null,                   -- x | linkedin | producthunt | hackernews | web
  source_url    text,
  author        text,
  posted_at     timestamptz,
  app_name      text,                            -- null until analyzed
  concept       text,                            -- one-line "what it is"
  category      text,
  novelty       numeric,                         -- 0-10, "groundbreaking"
  buildability  text,                            -- weekend | few_days | week_or_two | months | too_complex
  demand        numeric,                         -- 0-10, demand/traction signal
  play          numeric,                         -- 0-100 composite
  why           text,                            -- one-line "why it's a fast play"
  status        text not null default 'new',     -- new | scored
  captured_at   timestamptz not null default now()
);
create index if not exists idea_radar_play_idx on idea_radar (play desc);
create index if not exists idea_radar_status_idx on idea_radar (status);
