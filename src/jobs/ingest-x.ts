/**
 * X / Twitter ingest via Apify tweet scraper. Monitors traction keywords plus
 * the builder watchlist, extracts claimed metrics ("10k downloads", "1M users")
 * from post text, matches posts to known apps (store links first, then name
 * match), and writes app_claims for the factcheck job to verify.
 * Runs automatically in the nightly cron once APIFY_TOKEN is set; until then
 * it skips politely without failing the night.
 */
import { X_KEYWORDS, X_WATCHLIST } from '../lib/config.ts';
import { fetchJson } from '../lib/http.ts';
import { log } from '../lib/log.ts';
import { getStore, type AppRow } from '../lib/store.ts';

const ACTOR = process.env.APIFY_X_ACTOR ?? 'apidojo~tweet-scraper';
const MAX_ITEMS_PER_TERM = 40;

export type ExtractedClaim = { metric: 'users' | 'downloads' | 'reviews'; value: number };

/** Parse claimed metrics from post text, e.g. "10k downloads", "crossed 1M users". */
export function extractClaims(text: string): ExtractedClaim[] {
  const out: ExtractedClaim[] = [];
  const re = /([\d][\d,.]*)\s*(k|m|million|thousand)?\s*\+?\s*(users|downloads|installs|reviews|ratings)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const base = Number(m[1].replace(/,/g, ''));
    if (!Number.isFinite(base)) continue;
    const mult = /^m|million/i.test(m[2] ?? '') ? 1e6 : /^k|thousand/i.test(m[2] ?? '') ? 1e3 : 1;
    const word = m[3].toLowerCase();
    const metric: ExtractedClaim['metric'] =
      word === 'users' ? 'users' : word === 'reviews' || word === 'ratings' ? 'reviews' : 'downloads';
    out.push({ metric, value: base * mult });
  }
  return out;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Match a post to a known app: app-store links are authoritative, name match is fallback. */
export function matchApp(text: string, apps: AppRow[]): AppRow | null {
  const apple = text.match(/apps\.apple\.com\/[^\s)]*id(\d+)/i);
  if (apple) return apps.find((a) => a.store === 'apple' && a.store_id === apple[1]) ?? null;
  const play = text.match(/play\.google\.com\/store\/apps\/details\?id=([\w.]+)/i);
  if (play) return apps.find((a) => a.store === 'google' && a.store_id === play[1]) ?? null;

  const normText = ` ${norm(text)} `;
  let best: AppRow | null = null;
  for (const app of apps) {
    const name = norm(app.name.split(/[-–—:|(]/)[0]);
    if (name.length < 4) continue; // short names match everything
    if (normText.includes(` ${name} `) && (!best || name.length > norm(best.name).length)) best = app;
  }
  return best;
}

type Tweet = { text?: string; full_text?: string; url?: string; twitterUrl?: string; createdAt?: string };

export async function runXIngest() {
  const store = getStore();
  const startedAt = new Date().toISOString();
  const token = process.env.APIFY_TOKEN;
  if (!token) {
    log.warn('x: APIFY_TOKEN not set, skipping X ingest (set the secret to activate)');
    await store.recordRun('x', startedAt, true, { skipped: 'no APIFY_TOKEN' });
    return { skipped: true };
  }

  const searchTerms = [
    ...X_KEYWORDS.map((k) => `"${k}"`),
    ...X_WATCHLIST.map((h) => `from:${h}`),
  ];

  let tweets: Tweet[] = [];
  const runIds: string[] = [];
  try {
    const url = `https://api.apify.com/v2/acts/${ACTOR}/run-sync-get-dataset-items?token=${token}&timeout=300`;
    tweets = await fetchJson<Tweet[]>(url, {
      service: 'apify', minGapMs: 2000, retries: 2,
      init: {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ searchTerms, maxItems: MAX_ITEMS_PER_TERM * searchTerms.length, sort: 'Latest' }),
      },
    });
    const lastRun = await fetchJson<{ data?: { id?: string } }>(
      `https://api.apify.com/v2/acts/${ACTOR}/runs/last?token=${token}`,
      { service: 'apify', minGapMs: 1000 },
    );
    if (lastRun.data?.id) runIds.push(lastRun.data.id);
  } catch (err) {
    log.error('x: apify tweet scrape failed', { err: String(err) });
    await store.recordRun('x', startedAt, false, { error: String(err) });
    return { error: String(err) };
  }

  const apps = await store.listApps();
  const claims = [];
  let matched = 0;
  for (const t of tweets) {
    const text = t.full_text ?? t.text ?? '';
    if (!text) continue;
    const app = matchApp(text, apps);
    if (!app) continue;
    matched++;
    for (const c of extractClaims(text)) {
      claims.push({
        app_id: app.id, claimed_metric: c.metric, claimed_value: c.value,
        claim_source_url: t.twitterUrl ?? t.url ?? null,
        verified_value: null, discrepancy_ratio: null, captured_at: startedAt,
      });
    }
  }
  const inserted = await store.insertClaims(claims);
  log.info(`x: ${tweets.length} posts, ${matched} matched to apps, ${inserted} claims recorded`);
  await store.recordRun('x', startedAt, true, { posts: tweets.length, matched, claims: inserted, runIds });
  return { posts: tweets.length, matched, claims: inserted };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runXIngest().then((r) => log.info('x ingest done', r));
}
