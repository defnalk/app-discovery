# app-discovery

Live consumer-app discovery engine + lead pipeline dashboard. Replaces the
static `app_database.numbers` spreadsheet with a self-updating system:
ingest store charts nightly → score momentum → surface a shortlist → feed
app developer companies into the existing lead pipeline.

## Layout

```
supabase/migrations/   0001 apps schema · 0002 lead-intel schema (8x_lead_intel-compatible)
src/lib/               config, logging (logs/*.jsonl), rate-limited HTTP, storage layer
src/jobs/              apps-side jobs: ingest-apple, ingest-play, ingest-producthunt,
                       ingest-x (phase-2 stub), score, factcheck, enrich-apollo, build-dashboard
src/leads/             leads-side: db, instantly client, jobs (instantly_sync, funnel_rollup,
                       suggestion_engine), routes (4 dashboard pages), seed-demo
src/run-nightly.ts     orchestrator — every job isolated, one failure never blocks the rest
src/serve.ts           dashboard server (apps page + leads pages), optional shared-token gate
.github/workflows/     nightly cron (02:15 UTC)
```

## Setup

1. Create a Supabase project, run both files in `supabase/migrations/` (SQL editor
   or `supabase db push`). 0002 is `create table if not exists` throughout — it is a
   no-op for any 8x_lead_intel table that already exists, and only adds the missing
   columns (`leads.geo`, `leads.signal_source_url`, `leads.enriched_at`, `leads.stage`).
2. `cp .env.example .env` and fill in. Only `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`
   are required; every other source job skips itself politely when its key is unset.
3. `npm install` (Node ≥ 24 — runs TypeScript natively, no build step).
4. GitHub Actions: add the same values as repo secrets for the nightly cron.

Local dev without Supabase: `LOCAL_STORE=1` persists everything to `data/*.json`
with identical semantics. `npm run leads:seed-demo` fills the leads section with
demo data.

## Commands

| command | what |
|---|---|
| `npm run nightly` | full nightly run (all sources + scoring + dashboard + leads jobs) |
| `npm run ingest:apple` | Apple RSS charts (9 geos × 6 categories × free/grossing) + iTunes Lookup |
| `npm run ingest:play` | Google Play via Apify (needs `APIFY_TOKEN`; run ids stored for provenance) |
| `npm run ingest:producthunt` | PH daily top consumer posts → claims (needs `PRODUCT_HUNT_TOKEN`) |
| `npm run score` | momentum per app per geo + rollups + geo-arbitrage flags |
| `npm run factcheck` | claimed vs verified numbers; >3× flags suspect |
| `node src/jobs/analyze.ts` | idea/saturation/buildability analysis of new shortlist apps (Haiku; needs `ANTHROPIC_API_KEY`); too-complex apps dropped from shortlist |
| `npm run enrich` | Apollo enrichment of shortlist → `leads_out/*.csv` + leads pipeline (`source=app_discovery`) |
| `npm run dashboard` | rebuild static apps page (`public/index.html`) |
| `npm run serve` | serve dashboard at :8787 (set `DASHBOARD_TOKEN` to gate with `?token=…`) |
| `npm run leads:sync` / `leads:rollup` / `leads:suggest` | leads jobs individually |

## How scoring works

Per app per geo over a 7-day window: rank velocity (chart-position delta;
entering the chart counts as coming from rank 101) + rating-count growth rate +
new-geo appearances, plus a newness bonus decaying over 30 days (newness ranks,
it never gates). Incumbents — rating_count > 500k or a known-major developer —
stay in the table but are excluded from the shortlist. Geo-arbitrage: apps with
rank ≤ 50 in 2+ markets get a `geo_gap` list of the large markets (in, br, tr,
id, mx) they're absent from.

## Leads section (dashboard at /leads)

Reuses the 8x_lead_intel schema — `leads`, `classifications`, `config`,
`threshold_suggestions`, `campaigns`, `campaign_leads`, `events` (used as the
lead-events table), `runs` — no parallel lead tables.

- **Pipeline** — funnel counts (click a stage to filter), full lead table with
  arm/geo/tier/stage/email-status filters and provenance on every lead.
- **Approval Queue** — human gate #1. Batches land as `pending_approval`
  campaigns; approving pushes leads to the linked Instantly campaign (which
  stays paused — activation happens inside Instantly, never here) and records
  who/when. Rejecting requires a note. **No auto-approve path exists and none
  may be added.**
- **Performance** — sends/replies/positive/meetings per strategy arm, reply-rate
  A/B readout, 30-day time series, reply table traceable to arm/score/signal.
  Arms < 50% of mean reply rate after 100+ sends get flagged.
- **Settings** — human gate #2. Active thresholds read-only with last editor;
  system-computed suggestions wait in pending until a human accepts (applies +
  audits) or dismisses. Every change lands in `settings_audit`.

## Provenance & safety rails

- Every external call is logged to `logs/YYYY-MM-DD.jsonl` with status/duration.
- Apify run ids stored on snapshots (`source=apify:<runId>`); `ingest_runs` /
  `runs` record every job execution.
- Lead inserts without `source_arm` are rejected.
- All jobs are idempotent and safe to rerun (natural-key upserts everywhere).
- Nothing in this codebase can start, resume, or schedule email sending.
