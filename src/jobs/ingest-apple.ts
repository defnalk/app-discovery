/**
 * Apple App Store ingest.
 * 1. Legacy iTunes RSS per country x category x chart (top free / top grossing), no auth.
 * 2. iTunes Lookup per geo (batched ids) for canonical metadata + per-storefront rating counts.
 * Upserts apps, appends snapshots. Idempotent per day.
 */
import { COUNTRIES, APPLE_CATEGORIES, CHART_LIMIT } from '../lib/config.ts';
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

const RSS_CHARTS: { chartType: 'top_free' | 'top_grossing'; feed: string }[] = [
  { chartType: 'top_free', feed: 'topfreeapplications' },
  { chartType: 'top_grossing', feed: 'topgrossingapplications' },
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

export async function runAppleIngest() {
  const store = getStore();
  const startedAt = new Date().toISOString();
  const today = startedAt.slice(0, 10);

  // geo -> appId -> { bestRank per chartType, category }
  const charted = new Map<string, Map<string, { ranks: Record<string, number>; category: string | null; name: string; artist: string }>>();

  let feedsOk = 0, feedsFailed = 0;
  for (const geo of COUNTRIES) {
    const perGeo = new Map<string, { ranks: Record<string, number>; category: string | null; name: string; artist: string }>();
    charted.set(geo, perGeo);
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

  // Canonical metadata per geo via iTunes Lookup (rating counts are per-storefront).
  const lookups = new Map<string, Map<string, LookupResult>>(); // geo -> id -> result
  for (const geo of COUNTRIES) {
    const ids = [...charted.get(geo)!.keys()];
    const found = new Map<string, LookupResult>();
    lookups.set(geo, found);
    for (let i = 0; i < ids.length; i += 100) {
      const batch = ids.slice(i, i + 100);
      const url = `https://itunes.apple.com/lookup?id=${batch.join(',')}&country=${geo}&entity=software`;
      try {
        const json = await fetchJson<{ results: LookupResult[] }>(url, { service: 'itunes-lookup', minGapMs: 3500 });
        for (const r of json.results ?? []) found.set(String(r.trackId), r);
      } catch (err) {
        log.error(`itunes lookup failed: ${geo} batch ${i}`, { err: String(err) });
      }
    }
  }

  // Upsert apps. Use US lookup (then any geo) as the canonical record.
  const appPayloads = new Map<string, Parameters<typeof store.upsertApps>[0][number]>();
  for (const geo of COUNTRIES) {
    for (const [id, info] of charted.get(geo)!) {
      const lk = lookups.get('us')!.get(id) ?? lookups.get(geo)!.get(id);
      const prev = appPayloads.get(id);
      if (prev && lookups.get('us')!.get(id) == null) continue; // keep first unless US data arrives
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
      const lk = lookups.get(geo)!.get(id);
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

  await store.recordRun('apple', startedAt, feedsFailed === 0, {
    feedsOk, feedsFailed, apps: appPayloads.size, snapshots: inserted,
  });
  return { apps: appPayloads.size, snapshots: inserted, feedsOk, feedsFailed };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runAppleIngest().then((r) => log.info('apple ingest done', r));
}
