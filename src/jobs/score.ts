/**
 * Momentum scoring. Per app per geo:
 *  - rank velocity: chart position delta over the lookback window (entering the chart counts)
 *  - rating_count growth rate over the same window
 *  - new geo appearances: app newly charting in a country it wasn't in
 * Composite momentum_score; newness adds a decaying bonus (ranks, never gates).
 * Incumbents (rating_count > 500k or known major developer) are kept but excluded
 * from the shortlist. Geo-arbitrage: strong in 2+ markets, absent from large markets.
 */
import { SCORING, KNOWN_MAJORS, LARGE_MARKETS, CHART_LIMIT, SHORTLIST_MOMENTUM_MIN } from '../lib/config.ts';
import { log } from '../lib/log.ts';
import { getStore, type SnapshotRow } from '../lib/store.ts';

const DAY = 86_400_000;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export async function runScoring() {
  const store = getStore();
  const startedAt = new Date().toISOString();
  const now = Date.now();
  const lookbackStart = new Date(now - 2 * SCORING.lookbackDays * DAY).toISOString();
  const midpoint = now - SCORING.lookbackDays * DAY;

  const [apps, snaps] = await Promise.all([store.listApps(), store.listSnapshotsSince(lookbackStart)]);
  if (!snaps.length) {
    log.warn('score: no snapshots in window, nothing to do');
    await store.recordRun('score', startedAt, true, { scored: 0 });
    return { scored: 0 };
  }

  // Bucket snapshots per app+geo into "recent" (last 7d) and "previous" (7-14d ago).
  const byAppGeo = new Map<string, { recent: SnapshotRow[]; prev: SnapshotRow[] }>();
  const geosByApp = new Map<string, Set<string>>();
  for (const s of snaps) {
    const k = `${s.app_id}|${s.geo}`;
    const b = byAppGeo.get(k) ?? { recent: [], prev: [] };
    (new Date(s.captured_at).getTime() >= midpoint ? b.recent : b.prev).push(s);
    byAppGeo.set(k, b);
    (geosByApp.get(s.app_id) ?? geosByApp.set(s.app_id, new Set()).get(s.app_id)!).add(s.geo);
  }

  const bestRank = (rows: SnapshotRow[]) => {
    const ranked = rows.filter((r) => r.chart_rank != null);
    return ranked.length ? Math.min(...ranked.map((r) => r.chart_rank!)) : null;
  };
  const latestRatingCount = (rows: SnapshotRow[]) => {
    const withRc = rows.filter((r) => r.rating_count != null).sort((a, b) => b.captured_at.localeCompare(a.captured_at));
    return withRc[0]?.rating_count ?? null;
  };

  const appById = new Map(apps.map((a) => [a.id, a]));
  const scores = [];
  const perApp = new Map<string, { geoScores: number[]; geos: string[]; newGeos: string[]; bestRank: number | null; rating: number | null; ratingCount: number | null }>();

  for (const [key, b] of byAppGeo) {
    const [appId, geo] = key.split('|');
    const app = appById.get(appId);
    if (!app) continue;

    const rankNow = bestRank(b.recent);
    if (rankNow == null) continue; // not currently charting in this geo
    // Entering the chart scores as coming from just off it (limit + 1) — but
    // rank_prev is stored as null so the dashboard shows "new entry", not a
    // fake historical rank.
    const prevRank = bestRank(b.prev);
    const rankPrev = prevRank ?? CHART_LIMIT + 1;
    const rankVelocity = rankPrev - rankNow;

    const rcNow = latestRatingCount(b.recent);
    const rcPrev = latestRatingCount(b.prev);
    const ratingGrowth = rcNow != null && rcPrev != null && rcPrev > 0 ? (rcNow - rcPrev) / Math.max(rcPrev, 100) : 0;

    // New geo: charting now, no snapshot here in the previous window, app itself is older than the window.
    const appAgeDays = (now - new Date(app.first_seen_at).getTime()) / DAY;
    const isNewGeo = b.prev.length === 0 && appAgeDays > SCORING.lookbackDays;

    const score =
      SCORING.wRankVelocity * clamp(rankVelocity / CHART_LIMIT, -1, 1) +
      SCORING.wRatingGrowth * clamp(ratingGrowth, 0, 1) +
      SCORING.wNewGeo * (isNewGeo ? 1 : 0) +
      SCORING.newnessMaxBonus * clamp(1 - appAgeDays / SCORING.newnessWindowDays, 0, 1);

    scores.push({
      app_id: appId, geo, computed_at: startedAt,
      rank_now: rankNow, rank_prev: prevRank,
      rank_velocity: rankVelocity, rating_growth: Number(ratingGrowth.toFixed(4)),
      momentum_score: Number(score.toFixed(4)),
    });

    const agg = perApp.get(appId) ?? { geoScores: [], geos: [], newGeos: [], bestRank: null, rating: null, ratingCount: null };
    agg.geoScores.push(score);
    agg.geos.push(geo);
    if (isNewGeo) agg.newGeos.push(geo);
    if (rankNow != null && (agg.bestRank == null || rankNow < agg.bestRank)) agg.bestRank = rankNow;
    const rating = b.recent.find((r) => r.rating != null)?.rating ?? null;
    if (rating != null) agg.rating = rating;
    if (rcNow != null) agg.ratingCount = Math.max(agg.ratingCount ?? 0, rcNow);
    perApp.set(appId, agg);
  }

  // Per-app rollups: composite = best geo score + small breadth bonus.
  const strongByApp = new Map<string, string[]>();
  for (const [key, b] of byAppGeo) {
    const [appId, geo] = key.split('|');
    const r = bestRank(b.recent);
    if (r != null && r <= SCORING.strongRank) {
      (strongByApp.get(appId) ?? strongByApp.set(appId, []).get(appId)!).push(geo);
    }
  }

  const rollups = [];
  for (const [appId, agg] of perApp) {
    const app = appById.get(appId)!;
    const dev = (app.developer_name ?? '').toLowerCase();
    const isIncumbent =
      (agg.ratingCount ?? 0) > SCORING.incumbentRatingCount ||
      KNOWN_MAJORS.some((m) => dev.includes(m));

    const composite = Math.max(...agg.geoScores) + 0.05 * Math.log2(1 + agg.geos.length);

    const strong = strongByApp.get(appId) ?? [];
    const geoGap = strong.length >= SCORING.strongGeoMin
      ? LARGE_MARKETS.filter((m) => !agg.geos.includes(m))
      : [];

    rollups.push({
      app_id: appId, computed_at: startedAt,
      momentum_score: Number(composite.toFixed(4)),
      geos_live: agg.geos.sort(),
      new_geos: agg.newGeos.sort(),
      geo_gap: geoGap,
      is_incumbent: isIncumbent,
      shortlisted: !isIncumbent && composite >= SHORTLIST_MOMENTUM_MIN,
      best_rank: agg.bestRank,
      rating: agg.rating,
      rating_count: agg.ratingCount,
      fact_check_flag: false,
    });
  }

  await store.upsertScores(scores);
  await store.upsertRollups(rollups);
  await store.recordRun('score', startedAt, true, { scores: scores.length, rollups: rollups.length });
  log.info(`score: ${scores.length} app-geo scores, ${rollups.length} rollups, ${rollups.filter((r) => r.shortlisted).length} shortlisted`);
  return { scored: scores.length, rollups: rollups.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runScoring().then((r) => log.info('scoring done', r));
}
