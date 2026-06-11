/**
 * Google Play ingest via Apify. Skips itself (without failing the night) when
 * APIFY_TOKEN is unset. Apify run ids are stored on every snapshot's source
 * field (apify:<runId>) and in ingest_runs.detail for provenance.
 */
import { COUNTRIES, PLAY_CATEGORIES, CHART_LIMIT } from '../lib/config.ts';
import { fetchJson } from '../lib/http.ts';
import { log } from '../lib/log.ts';
import { getStore } from '../lib/store.ts';

const ACTOR = process.env.APIFY_PLAY_ACTOR ?? 'epctex~google-play-scraper';

type PlayItem = {
  appId?: string; id?: string; title?: string; name?: string;
  developer?: string; developerWebsite?: string;
  genre?: string; category?: string; description?: string; summary?: string;
  score?: number; ratings?: number; reviews?: number;
  installs?: string; minInstalls?: number;
  position?: number; rank?: number;
};

function installsToNumber(installs: string | undefined, minInstalls: number | undefined): number | null {
  if (minInstalls != null) return minInstalls;
  if (!installs) return null;
  const n = Number(installs.replace(/[+,.\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function domainFrom(url: string | undefined): string | null {
  if (!url) return null;
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
}

export async function runPlayIngest() {
  const store = getStore();
  const startedAt = new Date().toISOString();
  const today = startedAt.slice(0, 10);
  const token = process.env.APIFY_TOKEN;
  if (!token) {
    log.warn('play: APIFY_TOKEN not set, skipping Google Play ingest');
    await store.recordRun('play', startedAt, true, { skipped: 'no APIFY_TOKEN' });
    return { skipped: true };
  }

  const runIds: string[] = [];
  let snapshotsTotal = 0;

  for (const geo of COUNTRIES) {
    for (const cat of PLAY_CATEGORIES) {
      const input = {
        // epctex/google-play-scraper top-charts mode; harmless extras ignored by other actors
        mode: 'topcharts',
        country: geo,
        collection: 'topselling_free',
        category: cat.playId ?? undefined,
        maxItems: CHART_LIMIT,
        proxy: { useApifyProxy: true },
      };
      try {
        // run-sync returns dataset items when the run finishes within the HTTP window
        const url = `https://api.apify.com/v2/acts/${ACTOR}/run-sync-get-dataset-items?token=${token}&timeout=300`;
        const items = await fetchJson<PlayItem[]>(url, {
          service: 'apify', minGapMs: 2000, retries: 2,
          init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) },
        });
        // Run id for provenance comes via the last-run endpoint
        const lastRun = await fetchJson<{ data?: { id?: string } }>(
          `https://api.apify.com/v2/acts/${ACTOR}/runs/last?token=${token}`,
          { service: 'apify', minGapMs: 1000 },
        );
        const runId = lastRun.data?.id ?? 'unknown';
        runIds.push(runId);

        const payloads = items.filter((i) => i.appId || i.id).map((i) => ({
          store_id: (i.appId ?? i.id)!,
          store: 'google' as const,
          name: i.title ?? i.name ?? (i.appId ?? i.id)!,
          developer_name: i.developer ?? null,
          developer_domain: domainFrom(i.developerWebsite),
          category: i.genre ?? i.category ?? cat.key,
          description: (i.description ?? i.summary ?? '').slice(0, 2000) || null,
        }));
        const idMap = await store.upsertApps(payloads);

        const snapshots = items.filter((i) => i.appId || i.id).map((i, idx) => ({
          app_id: idMap.get(`google:${i.appId ?? i.id}`)!,
          captured_at: startedAt,
          snapshot_date: today,
          geo,
          chart_rank: i.position ?? i.rank ?? idx + 1,
          chart_type: 'top_free',
          rating: i.score ?? null,
          rating_count: i.ratings ?? i.reviews ?? null,
          installs: installsToNumber(i.installs, i.minInstalls),
          source: `apify:${runId}`,
        })).filter((s) => s.app_id);
        snapshotsTotal += await store.insertSnapshots(snapshots);
        log.info(`play ${geo}/${cat.key}: ${items.length} items`);
      } catch (err) {
        log.error(`play ingest failed: ${geo}/${cat.key}`, { err: String(err) });
      }
    }
  }

  await store.recordRun('play', startedAt, true, { runIds, snapshots: snapshotsTotal });
  return { snapshots: snapshotsTotal, runs: runIds.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runPlayIngest().then((r) => log.info('play ingest done', r));
}
