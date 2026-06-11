# Lead strategy — delta-CRM analysis (industry × geo)

*Generated 2026-06-11 from `data/strategy-input.json` (lead book × app-market momentum), synthesized from three independent strategy passes (market-heat, inventory, arm-design). Re-run `node src/leads/strategy-data.ts` to refresh the cross-tab — day-one momentum data firms up as nightly snapshots accumulate.*

## The one-line diagnosis

**The lead book is inverted against market heat.** 67% of send-ready inventory (lookalike D2C brands) sits in commerce_d2c — the coldest app bucket (3–10 charting apps/geo) — while the four hottest buckets (productivity_ai ~225 hot apps per pool geo, photo_video_design ~195, fintech ~145, education ~120) hold almost zero geo-tagged, qualified leads. Turkey has 0 leads in every bucket. Meanwhile 1,123 live expansion signals (apps charting strongly elsewhere, absent from IN/TR/ID/BR/MX) fuel arms holding just 87 stale leads.

This is not fatal: D2C brands are core 8x ICP and app charts don't measure them. But it means two distinct motions: **monetize the book you have** (D2C, geo-agnostic copy) while **rebuilding inventory around heat** (expansion-wave apps, pool geos).

## The plan (June 12 → July 5)

### Week 0 — before launch (June 12–13)
1. **Verification sprint on the 324 ICP-qualified** blocked only on email verification (commerce_d2c/unknown 177 → food 70 → other 37 → pool-geo 32). Flat-rate verifier (~$0.002/email ≈ $1 total; Apollo not needed). Target: sendable 53 → 200+ by launch, 300+ by June 18.
2. **Zero-cost geo pass on the 999 unknown-geo leads** (website TLD, LinkedIn HQ, store storefront). Unresolved default to the US/EN D2C sequence — nothing waits on geo.
3. **Re-validate the 87 new_entrant leads** against the live expansion-candidate list; their dated "just entered the IN/BR charts" evidence decays weekly.

### Launch (June 14)
4. **Send all 53 sendables as the calibration batch**, split across the four populated arms, identical template skeleton, approval gate per batch. Purpose: deliverability ramp (<3% bounce gate) + the start of per-arm baselines. Don't judge the strategy on this week — it's ballast.

### Week 1 (June 15–21)
5. **new_entrant personalized batch (~50)** — highest-intent copy in the book: dated chart-entry line in sentence one.
6. **linkedin_hiring as workhorse, aimed at heat**: 422 emails in hand; start with its 74 productivity_ai leads ("you're hiring growth while your category has 200+ apps surging — creator ads scale faster than the hire"). Hold its 127 commerce_d2c leads for the stratified comparison.
7. **lookalike capped at a controlled cell**: 30 commerce_d2c + 20 food sends, mirrored by an identical linkedin_hiring batch in the same buckets — this is what makes the arm A/B readable instead of confounded by bucket mix.
8. **Fill the empty app_discovery arm without Apollo**: 135 domain-ready expanders already identified in the analyzed shortlist (non-incumbent, momentum ≥0.5, charting 2+ markets, gap into a pool). Pattern-email (hello@/founders@/first@) + MX verification. Pitch: "charting in 7 markets, absent in India/Turkey — local creators are how you land." First 50 sends week of June 23.

### Weeks 2–3 (June 22 – July 5)
9. **All five arms reach 100 sends** (~July 5). Apply the <50%-of-mean kill flag **only at the 100-send mark and only within matched buckets** — the 'other' bucket is the control stratum (only bucket present in all four populated arms: 196/152/87/43). The Performance page reads this out automatically.
10. **apollo_websearch decision gate**: pattern-enrich its top-50 scored leads; <40% email yield by June 25 → pause the arm, shift effort to app_discovery.

## Sourcing gaps to close (the heat you can't currently touch)
- **Turkey: zero leads anywhere** vs top-3 heat in productivity_ai (226 hot), photo/video (195), fintech (147) — the 729-app Turkey list sits un-imported in ~/Downloads (phone-first; needs an email pass).
- **India under-weighted** (129 leads) vs the hottest geo overall + biggest expansion inflow (235 candidates across top buckets) — 1,124-app India list likewise on disk.
- **photo_video_design is the single biggest white space**: 13 leads, 0 qualified, vs the highest-momentum bucket in all 9 geos and 289 expansion candidates. Creator-tool apps are also the most natural UGC buyers.
- **fintech/education**: 78 and 95 leads, none qualified, vs 145/120 hot per geo; education has the best idea-quality scores (6.4–6.7) at the lowest saturation (~0.48).

## Risks the numbers flag
- Day-one discovery data: "new entries" inflated, momentum is one snapshot — re-pull expansion gaps before approving each weekly batch; keep heat claims in copy generic.
- Arm-bucket confounding will false-kill arms if the A/B isn't stratified (lookalike's D2C skew, new_entrant's all-'other' composition).
- Pattern-emails on fresh domains risk the launch: MX-verify, catch-all detection, low per-mailbox volume during warm-up; >3% bounce week 1 burns everything.
- Budget fit: many pool-market charting apps are small studios below the $5k/mo minimum — screen expanders by headcount/funding before promising the $10–20k sweet spot; expect IN/TR replies to need local-language follow-up.
- The approval gate is one human with 4+ batches queued June 13–23 — stagger submissions.
