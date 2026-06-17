/**
 * Ground lead signals in REAL, checkable evidence instead of placeholder text.
 *
 * Every lead whose company owns an app we actually track gets its live App
 * Store / Play traction stitched on as the signal: current chart rank, the
 * markets it's charting in right now, and the large markets it's absent from
 * (the genuine geo-arbitrage opening). Source is the app-discovery engine's own
 * nightly snapshots, so it's verifiable — the signal_source_url links straight
 * to the store listing. Nothing is invented: leads with no matching tracked app
 * are left untouched (no fabricated signal).
 *
 * Idempotent; safe to run nightly after scoring. Run standalone for a one-off.
 */
import { log } from '../lib/log.ts';
import { getStore } from '../lib/store.ts';
import { getLeadsDb } from './db.ts';

const norm = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/^www\./, '').trim();

// Strip legal/common company suffixes so "Cyberghost SRL" matches developer "CyberGhost".
const SUFFIXES = /\b(inc|llc|ltd|limited|corp|corporation|co|company|gmbh|srl|sa|sas|bv|oy|ab|plc|pvt|private|technologies|technology|tech|labs|lab|software|solutions|studios|studio|games|game|interactive|app|apps|mobile|digital|media|group|holdings|ventures|the|and)\b/g;
const canonical = (s: string | null | undefined) =>
  (s ?? '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' ').replace(SUFFIXES, ' ').replace(/\s+/g, ' ').trim();

function storeUrl(store: string, storeId: string): string {
  return store === 'apple'
    ? `https://apps.apple.com/app/id${storeId}`
    : `https://play.google.com/store/apps/details?id=${storeId}`;
}

/** Human-readable, fact-only signal from the rollup. */
function signalText(appName: string, r: { best_rank: number | null; geos_live: string[]; geo_gap: string[]; new_geos: string[]; rating_count: number | null }): string {
  const geos = r.geos_live ?? [];
  const rank = r.best_rank != null ? `#${r.best_rank}` : 'on the charts';
  const head = geos.length > 1
    ? `${appName} is charting ${rank} across ${geos.length} markets (${geos.slice(0, 6).join(', ')}${geos.length > 6 ? '…' : ''})`
    : `${appName} is charting ${rank} in ${geos[0] ?? 'one market'}`;
  const gap = (r.geo_gap ?? []).length ? ` — absent from ${r.geo_gap.slice(0, 4).join(', ')}, a creator-cheap geo-arbitrage entry` : '';
  const newGeo = (r.new_geos ?? []).length ? ` Newly entered ${r.new_geos.slice(0, 3).join(', ')}.` : '';
  const ratings = r.rating_count != null ? ` ${Number(r.rating_count).toLocaleString()} ratings.` : '';
  return `${head}${gap}.${newGeo}${ratings}`.trim();
}

export async function runSignalRefresh() {
  const store = getStore();
  const db = getLeadsDb();
  const startedAt = new Date().toISOString();

  const [apps, rollups, leads] = await Promise.all([store.listApps(), store.listRollups(), db.listLeadsJoined()]);
  const rollupByApp = new Map(rollups.map((r) => [r.app_id, r]));

  // Index apps that have a usable rollup, by developer domain and canonical name.
  // A canonical name shared by two DIFFERENT developers is ambiguous → never matched
  // (a wrong match would just be a new fake signal, which defeats the point).
  const byDomain = new Map<string, typeof apps[number]>();
  const byCanon = new Map<string, typeof apps[number]>();
  const ambiguousCanon = new Set<string>();
  for (const a of apps) {
    if (!rollupByApp.has(a.id)) continue;
    const dom = norm(a.developer_domain);
    if (dom && !byDomain.has(dom)) byDomain.set(dom, a);
    const c = canonical(a.developer_name);
    if (c.length >= 3) {
      const existing = byCanon.get(c);
      if (existing && norm(existing.developer_domain) !== norm(a.developer_domain)) ambiguousCanon.add(c);
      else if (!existing) byCanon.set(c, a);
    }
  }

  const updates: { id: string; signal_source_url: string | null; raw_payload: Record<string, unknown> | null }[] = [];
  let viaDomain = 0, viaName = 0, withGap = 0;
  for (const l of leads) {
    // Domain match first (precise), then unambiguous canonical-name match.
    let app = byDomain.get(norm(l.domain));
    let how: 'developer_domain' | 'developer_name' | null = app ? 'developer_domain' : null;
    if (!app && l.company) {
      const c = canonical(l.company);
      if (c.length >= 3 && !ambiguousCanon.has(c)) { app = byCanon.get(c); if (app) how = 'developer_name'; }
    }
    if (!app) continue;
    if (how === 'developer_domain') viaDomain++; else viaName++;

    const r = rollupByApp.get(app.id)!;
    if (!(r.geos_live ?? []).length) continue; // only assert a signal when it's actually charting
    if ((r.geo_gap ?? []).length) withGap++;

    const text = signalText(app.name, r);
    const evidence = {
      verified: true,
      source: 'app_discovery_engine',
      matched_by: how,
      app_name: app.name, store: app.store, store_id: app.store_id,
      best_rank: r.best_rank, geos_live: r.geos_live, geo_gap: r.geo_gap, new_geos: r.new_geos,
      rating_count: r.rating_count, momentum_score: r.momentum_score, is_incumbent: r.is_incumbent,
      verified_at: startedAt,
    };
    const raw = { ...(l.raw_payload ?? {}), expansion_signal: text, signal_verified: true, signal: evidence };
    updates.push({ id: l.id, signal_source_url: storeUrl(app.store, app.store_id), raw_payload: raw });
  }

  const written = updates.length ? await db.updateLeadSignals(updates) : 0;
  await db.recordRun('signal_refresh', startedAt, { input: leads.length, output: written });
  log.info(`signal_refresh: ${written} leads given verified live-traction signals (${viaDomain} by domain, ${viaName} by name, ${withGap} with a real geo-gap)`);
  return { verified: written, viaDomain, viaName, withGap };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runSignalRefresh();
}
