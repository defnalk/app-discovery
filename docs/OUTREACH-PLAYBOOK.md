# Cold email playbook + messaging drafts

*Drafted 2026-06-12. Pairs with docs/LEAD-STRATEGY.md. All sends pass the human approval gate; nothing here auto-sends.*

## Deliverability rules (the non-negotiables)

1. **Domain warm-up: 2–4 weeks before real volume** on the new sending domains. Until then, warm-up tools only (Instantly warmup is already enabled per the cold-email-ops kit).
2. **Pre-warmed accounts (~$65) for lower-priority markets only** — fine for testing messaging in TR/MX/ID pools now; never for top US leads (reputation risk on the leads that matter most).
3. Ramp: ≤20 sends/mailbox/day week 1 → 50/day by week 3. Bounce gate <3%, spam complaints <0.1% — one bad day on a fresh domain undoes weeks of warm-up.
4. Verify every email before send (flat-rate verifier; accept-all addresses get a separate, smaller test cell).
5. Plain-text emails, one link max (or none in email #1), no images/tracking pixels in week 1. Spintax subject/opening variants so mailbox providers don't see identical bodies.
6. 2–3 sentence emails. One CTA, low-friction ("worth a quick look?" not "book 30 minutes").
7. Sequence: 3 touches over 8–10 days (day 0, day 3–4 bump, day 8–10 breakup). Reply handling > more touches.
8. Send in recipient's business hours; localize subject lines in TR/BR/MX even if body stays English; expect local-language replies in TR/BR — route to a speaker or translate fast.

## Messaging drafts per sourcing strategy (arm)

**Experiment now, even pre-warm-up** — these go into Instantly as paused campaign variants so testing starts the moment domains are ready.

### new_entrant — "you just landed"
> Subject: `{{company}} × {{market}} — saw the news`
> Saw {{company}} {{entered the IN charts / opened in São Paulo / launched on the TR App Store}} {{evidence_date}}. Landing a new market usually means UA costs you don't have at home — local creators are the cheap way in. We run short-form creator ads for consumer apps entering {{market}}; first test batch live in ~a week. Worth a quick look?

*Personalization slot: the dated expansion evidence, sentence one. This arm lives or dies on freshness.*

### app_discovery — "you're charting"
> Subject: `{{app_name}} ranking in {{geos}} — but not {{gap_market}}`
> {{app_name}} is charting in {{n}} markets right now — congrats on the run. You're not on the {{gap_market}} charts yet though, and that's a creator-cheap market to land. We make UGC creator ads for exactly this push. Want the 2-min version?

*Data slots filled from the engine: live geos, gap market, rank.*

### linkedin_hiring — "hire vs. creators"
> Subject: `the {{role}} you're hiring for`
> Noticed you're hiring a {{role}}. While that seat fills (~2 months?), your category is moving — {{category}} apps are surging in {{markets}}. We run creator-ad sprints that do the early growth work a hire would. Useful to compare cost-per-install before the offer letter goes out?

### lookalike / market_pool (D2C + vetted consumer apps) — classic UGC pitch
> Subject: `creator ads for {{company}}`
> {{company}} sells the kind of product people buy off a 15-second video. We produce and run short-form creator ads ({{competitor_or_category}} already leans on them) — typically 10–20 videos/month, performance-priced. Open to seeing examples in {{category}}?

*TR/IN market_pool versions: lead with the local angle — "TR creators, TR audience, billed in a way that makes sense locally."*

### apollo_websearch (scored ICP) — researched angle
> Subject: `{{company}} + short-form`
> {{one-line from the research verdict — why they specifically fit}}. We're 8x — creator-ad production+performance for consumer brands at {{stage}}. If UGC is on your roadmap this quarter, I'll send 3 relevant examples.

## A/B discipline

- One template family per arm; identical skeleton across arms where possible so arm comparisons measure *targeting*, not copy.
- 100 sends/arm before any kill/scale decision (<50% of mean reply rate = flag, evaluated within matched industry buckets — see Strategy page).
- Log every variant in Instantly as `{arm}-{geo}-v{n}` so the Performance page attribution stays clean.
