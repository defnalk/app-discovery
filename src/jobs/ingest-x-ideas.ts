/**
 * Idea Radar — X / Twitter source. Scrapes launch + build-in-public posts via the
 * Apify tweet scraper and stores them as raw idea candidates (status 'new') for
 * analyze-ideas to extract the concept and score. This is the UPSTREAM cousin of
 * ingest-x.ts: that one fact-checks traction claims about apps already in the DB;
 * this one catches brand-new apps still being talked about, before they chart.
 * Runs in the nightly cron once APIFY_TOKEN is set; skips politely otherwise.
 */
import { X_IDEA_KEYWORDS } from '../lib/config.ts';
import { fetchJson } from '../lib/http.ts';
import { log } from '../lib/log.ts';
import { getStore, type IdeaRow } from '../lib/store.ts';

const ACTOR = process.env.APIFY_X_ACTOR ?? 'apidojo~tweet-scraper';
const MAX_ITEMS_PER_TERM = 25;

type Tweet = {
  text?: string; full_text?: string; url?: string; twitterUrl?: string; createdAt?: string;
  author?: { userName?: string } | string; username?: string;
};

const handleOf = (t: Tweet): string | null =>
  typeof t.author === 'object' ? t.author?.userName ?? null : (t.username ?? (typeof t.author === 'string' ? t.author : null));

export async function runXIdeaIngest() {
  const store = getStore();
  const startedAt = new Date().toISOString();
  const token = process.env.APIFY_TOKEN;
  if (!token) {
    log.warn('x-ideas: APIFY_TOKEN not set, skipping (set the secret to activate the X idea radar)');
    await store.recordRun('x-ideas', startedAt, true, { skipped: 'no APIFY_TOKEN' });
    return { skipped: true };
  }

  let tweets: Tweet[] = [];
  try {
    const url = `https://api.apify.com/v2/acts/${ACTOR}/run-sync-get-dataset-items?token=${token}&timeout=300`;
    tweets = await fetchJson<Tweet[]>(url, {
      service: 'apify', minGapMs: 2000, retries: 2,
      init: {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ searchTerms: X_IDEA_KEYWORDS, maxItems: MAX_ITEMS_PER_TERM * X_IDEA_KEYWORDS.length, sort: 'Latest' }),
      },
    });
  } catch (err) {
    log.error('x-ideas: apify scrape failed', { err: String(err) });
    await store.recordRun('x-ideas', startedAt, false, { error: String(err) });
    return { error: String(err) };
  }

  const ideas: IdeaRow[] = [];
  for (const t of tweets) {
    const text = (t.full_text ?? t.text ?? '').trim();
    const link = t.twitterUrl ?? t.url ?? null;
    if (text.length < 30 || !link) continue; // need a substantive post we can cite
    ideas.push({
      dedup_key: `x:${link}`,
      source: 'x',
      source_url: link,
      author: handleOf(t),
      posted_at: t.createdAt ?? null,
      app_name: null,
      concept: text.slice(0, 400),
      category: null,
      novelty: null, buildability: null, demand: null, play: null, why: null,
      status: 'new',
      captured_at: startedAt,
    });
  }
  const inserted = await store.upsertIdeas(ideas);
  log.info(`x-ideas: ${tweets.length} posts, ${inserted} idea candidates stored`);
  await store.recordRun('x-ideas', startedAt, true, { posts: tweets.length, candidates: inserted });
  return { posts: tweets.length, candidates: inserted };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runXIdeaIngest().then((r) => log.info('x-ideas ingest done', r));
}
