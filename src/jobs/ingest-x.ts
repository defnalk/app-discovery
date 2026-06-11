/**
 * X / Twitter ingest — PHASE 2 STUB.
 * Will monitor traction keywords + a builder watchlist via an Apify twitter
 * scraper, extract claimed metrics from post text, and write app_claims for
 * the factcheck job. The claim parser below is live (Product Hunt reuses it);
 * the fetch path is intentionally not implemented yet.
 */
import { X_KEYWORDS, X_WATCHLIST } from '../lib/config.ts';
import { log } from '../lib/log.ts';
import { getStore } from '../lib/store.ts';

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

export async function runXIngest() {
  const store = getStore();
  const startedAt = new Date().toISOString();
  log.info('x: phase 2 stub — not fetching', { keywords: X_KEYWORDS.length, watchlist: X_WATCHLIST.length });
  // TODO(phase 2): run Apify twitter scraper (e.g. apidojo/tweet-scraper) over
  // X_KEYWORDS + X_WATCHLIST, match posts to apps by name/store link, then:
  //   store.insertClaims(extractClaims(tweet.text).map(c => ({ app_id, claimed_metric: c.metric, ... })))
  await store.recordRun('x', startedAt, true, { stub: true });
  return { stub: true };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runXIngest().then((r) => log.info('x ingest done', r));
}
