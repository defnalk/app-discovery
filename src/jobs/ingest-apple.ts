/**
 * Apple App Store ingest.
 * 1. Legacy iTunes RSS per country x category x chart (top free / top grossing), no auth.
 * 2. iTunes Lookup per geo (batched ids) for canonical metadata + per-storefront rating counts.
 * Upserts apps, appends snapshots. Idempotent per day.
 */
import { COUNTRIES, APPLE_CATEGORIES, CHART_LIMIT, AI_SEARCH_TERMS, AI_SEARCH_MAX_AGE_DAYS } from '../lib/config.ts';
import { fetchJson } from '../lib/http.ts';
import { log } from '../lib/log.ts';
import { getStore } from '../lib/store.ts';

type RssEntry = {
  'im:name': { label: string };
  'im:artist': { label: string };
  category?: { attributes?: { label?: string } };
  summary?: { label?: string };
  id: { attributes: { 'im:id': string } };
};

type LookupResult = {
  trackId: number;
  trackName: string;
  sellerName?: string;
  sellerUrl?: string;
  description?: string;
  averageUserRating?: number;
  userRatingCount?: number;
  releaseDate?: string;
  languageCodesISO2A?: string[];
  primaryGenreName?: string;
};

const RSS_CHARTS: { chartType: string; feed: string }[] = [
  { chartType: 'top_free', feed: 'topfreeapplications' },
  { chartType: 'top_grossing', feed: 'topgrossingapplications' },
  { chartType: 'top_paid', feed: 'toppaidapplications' }, // paid-app developers — strong ICP, can afford UA
  { chartType: 'new_free', feed: 'newfreeapplications' }, // catches apps before they hit top charts
];

export function domainFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    // app-store/social hosts are not company domains
    if (/apple\.com$|facebook\.com$|instagram\.com$|twitter\.com$|x\.com$|linktr\.ee$/.test(host)) return null;
    return host;
  } catch {
    return null;
  }
}

// At 26 countries a full per-geo Apple ingest runs ~90min and blows the
// nightly per-job watchdog *before* writing a single snapshot, freezing the
// charts. Two structural rules keep chart data flowing every night:
//   1. A gather deadline: RSS/search/lookup stop starting new work once the
//      budget is spent, leaving headroom for the write under the watchdog.
//   2. The write at the end ALWAYS runs with whatever was gathered — chart
//      ranks are never held hostage to optional enrichment.
const GATHER_BUDGET_MS = 30 * 60 * 1000;

export async function runAppleIngest() {
  const store = getStore();
  const startedAt = new Date().toISOString();
  const today = startedAt.slice(0, 10);
  const deadline = Date.now() + GATHER_BUDGET_MS;
  const overBudget = () => Date.now() > deadline;

  // geo -> appId -> { bestRank per chartType, category }
  const charted = new Map<string, Map<string, { ranks: Record<string, number>; category: string | null; name: string; artist: string }>>();
  // Pre-init every geo so a truncated RSS phase can't leave a missing key that
  // crashes the later lookup/build loops.
  for (const geo of COUNTRIES) charted.set(geo, new Map());

  let feedsOk = 0, feedsFailed = 0;
  for (const geo of COUNTRIES) {
    if (overBudget()) { log.warn(`apple rss: gather budget spent, truncating at ${geo}`, { feedsOk, feedsFailed }); break; }
    const perGeo = charted.get(geo)!;
    for (const cat of APPLE_CATEGORIES) {
      for (const { chartType, feed } of RSS_CHARTS) {
        const genre = cat.genreId ? `/genre=${cat.genreId}` : '';
        const url = `https://itunes.apple.com/${geo}/rss/${feed}/limit=${CHART_LIMIT}${genre}/json`;
        try {
          const json = await fetchJson<{ feed: { entry?: RssEntry[] } }>(url, { service: 'apple-rss', minGapMs: 300 });
          const entries = json.feed.entry ?? [];
          entries.forEach((e, i) => {
            const id = e.id.attributes['im:id'];
            const cur = perGeo.get(id) ?? {
              ranks: {},
              category: e.category?.attributes?.label ?? null,
              name: e['im:name'].label,
              artist: e['im:artist'].label,
            };
            // keep best (lowest) rank seen for this chart type across category feeds
            cur.ranks[chartType] = Math.min(cur.ranks[chartType] ?? Infinity, i + 1);
            perGeo.set(id, cur);
          });
          feedsOk++;
        } catch (err) {
          feedsFailed++;
          log.error(`apple rss failed: ${geo}/${cat.key}/${chartType}`, { err: String(err) });
        }
      }
    }
    log.info(`apple rss ${geo}: ${perGeo.size} unique charting apps`);
  }

  // New AI apps via iTunes Search — surfaces recent releases before they chart.
  const cutoff = Date.now() - AI_SEARCH_MAX_AGE_DAYS * 86_400_000;
  let aiFound = 0;
  for (const geo of COUNTRIES) {
    if (overBudget()) { log.warn(`apple ai-search: gather budget spent, stopping at ${geo}`, { aiFound }); break; }
    const perGeo = charted.get(geo)!;
    for (const term of AI_SEARCH_TERMS) {
      const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&country=${geo}&entity=software&limit=50`;
      try {
        const json = await fetchJson<{ results: (LookupResult & { releaseDate?: string })[] }>(url, { service: 'itunes-lookup', minGapMs: 2500 });
        (json.results ?? []).forEach((r, i) => {
          if (!r.trackId || !r.releaseDate || new Date(r.releaseDate).getTime() < cutoff) return;
          const id = String(r.trackId);
          const cur = perGeo.get(id) ?? {
            ranks: {}, category: r.primaryGenreName ?? null, name: r.trackName, artist: r.sellerName ?? '',
          };
          cur.ranks['ai_search'] = Math.min(cur.ranks['ai_search'] ?? Infinity, i + 1);
          perGeo.set(id, cur);
          aiFound++;
        });
      } catch (err) {
        log.error(`itunes search failed: ${geo}/${term}`, { err: String(err) });
      }
    }
  }
  log.info(`apple ai-search: ${aiFound} recent AI app hits across geos`);

  // Canonical metadata via ONE global lookup over the union of every charted id
  // (US storefront). The lookup endpoint returns canonical metadata for any app
  // id regardless of the country param, so a single pass covers apps that chart
  // only outside the US too — at ~1/26th the cost of the old per-geo loop that
  // blew the watchdog. Ratings are US-canonical for every geo (the per-storefront
  // nuance isn't worth ~60min; a consistent source is actually better for the
  // rating-growth signal scoring derives from snapshots over time).
  const canonical = new Map<string, LookupResult>(); // id -> result
  const allIds = new Set<string>();
  for (const geo of COUNTRIES) for (const id of charted.get(geo)!.keys()) allIds.add(id);
  const idList = [...allIds];
  let lookupTruncated = false;
  for (let i = 0; i < idList.length; i += 100) {
    if (overBudget()) { lookupTruncated = true; log.warn(`apple lookup: gather budget spent at ${i}/${idList.length}`); break; }
    const batch = idList.slice(i, i + 100);
    const url = `https://itunes.apple.com/lookup?id=${batch.join(',')}&country=us&entity=software`;
    try {
      const json = await fetchJson<{ results: LookupResult[] }>(url, { service: 'itunes-lookup', minGapMs: 2500 });
      for (const r of json.results ?? []) canonical.set(String(r.trackId), r);
    } catch (err) {
      log.error(`itunes lookup failed: batch ${i}`, { err: String(err) });
    }
  }
  log.info(`apple lookup: ${canonical.size}/${idList.length} ids enriched${lookupTruncated ? ' (truncated)' : ''}`);

  // Upsert apps. Canonical lookup is the source of truth; fall back to RSS data.
  const appPayloads = new Map<string, Parameters<typeof store.upsertApps>[0][number]>();
  for (const geo of COUNTRIES) {
    for (const [id, info] of charted.get(geo)!) {
      const lk = canonical.get(id);
      if (appPayloads.has(id)) continue; // canonical record is geo-independent — first write wins
      appPayloads.set(id, {
        store_id: id,
        store: 'apple',
        name: lk?.trackName ?? info.name,
        developer_name: lk?.sellerName ?? info.artist,
        developer_domain: domainFromUrl(lk?.sellerUrl),
        category: lk?.primaryGenreName ?? info.category,
        description: (lk?.description ?? '').slice(0, 2000) || null,
      });
    }
  }
  const idMap = await store.upsertApps([...appPayloads.values()]);
  log.info(`apple: upserted ${appPayloads.size} apps`);

  // Append snapshots: one per app/geo/chart_type/day.
  const snapshots = [];
  for (const geo of COUNTRIES) {
    for (const [id, info] of charted.get(geo)!) {
      const appId = idMap.get(`apple:${id}`);
      if (!appId) continue;
      const lk = canonical.get(id);
      for (const [chartType, rank] of Object.entries(info.ranks)) {
        snapshots.push({
          app_id: appId,
          captured_at: startedAt,
          snapshot_date: today,
          geo,
          chart_rank: rank,
          chart_type: chartType,
          rating: lk?.averageUserRating ?? null,
          rating_count: lk?.userRatingCount ?? null,
          installs: null,
          source: 'apple_rss',
        });
      }
    }
  }
  const inserted = await store.insertSnapshots(snapshots);
  log.info(`apple: ${inserted} snapshots appended`);

  await store.recordRun('apple', startedAt, feedsFailed === 0 && !lookupTruncated, {
    feedsOk, feedsFailed, apps: appPayloads.size, snapshots: inserted,
    enriched: canonical.size, lookupTruncated,
  });
  return { apps: appPayloads.size, snapshots: inserted, feedsOk, feedsFailed, enriched: canonical.size };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runAppleIngest().then((r) => log.info('apple ingest done', r));
}
