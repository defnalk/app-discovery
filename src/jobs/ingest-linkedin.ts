/**
 * Idea Radar — LinkedIn source. Scrapes "we just launched our app" style posts via
 * a configurable Apify LinkedIn actor and stores them as raw idea candidates
 * (status 'new') for analyze-ideas to score. LinkedIn scraping is ToS-restricted
 * and actor input shapes vary, so this is intentionally best-effort and fully
 * gated: it does nothing until APIFY_TOKEN is set, and the actor id is overridable
 * via APIFY_LINKEDIN_ACTOR. It never fails the night.
 */
import { LINKEDIN_IDEA_QUERIES } from '../lib/config.ts';
import { fetchJson } from '../lib/http.ts';
import { log } from '../lib/log.ts';
import { getStore, type IdeaRow } from '../lib/store.ts';

const ACTOR = process.env.APIFY_LINKEDIN_ACTOR ?? 'apimaestro~linkedin-posts-search-scraper';
const MAX_ITEMS = 120;

type Post = {
  text?: string; content?: string; postContent?: string;
  url?: string; postUrl?: string; link?: string;
  authorName?: string; author?: { name?: string } | string;
  postedAt?: string; date?: string; publishedAt?: string;
};

const textOf = (p: Post) => (p.text ?? p.content ?? p.postContent ?? '').trim();
const urlOf = (p: Post) => p.url ?? p.postUrl ?? p.link ?? null;
const authorOf = (p: Post): string | null =>
  p.authorName ?? (typeof p.author === 'object' ? p.author?.name ?? null : (typeof p.author === 'string' ? p.author : null));

export async function runLinkedInIngest() {
  const store = getStore();
  const startedAt = new Date().toISOString();
  const token = process.env.APIFY_TOKEN;
  if (!token) {
    log.warn('linkedin: APIFY_TOKEN not set, skipping (set the secret + APIFY_LINKEDIN_ACTOR to activate)');
    await store.recordRun('linkedin', startedAt, true, { skipped: 'no APIFY_TOKEN' });
    return { skipped: true };
  }

  let posts: Post[] = [];
  try {
    const url = `https://api.apify.com/v2/acts/${ACTOR}/run-sync-get-dataset-items?token=${token}&timeout=300`;
    posts = await fetchJson<Post[]>(url, {
      service: 'apify', minGapMs: 2000, retries: 2,
      init: {
        method: 'POST', headers: { 'content-type': 'application/json' },
        // Common LinkedIn actor inputs accept one of these; harmless extras are ignored.
        body: JSON.stringify({ queries: LINKEDIN_IDEA_QUERIES, keywords: LINKEDIN_IDEA_QUERIES, maxItems: MAX_ITEMS, maxPosts: MAX_ITEMS }),
      },
    });
  } catch (err) {
    log.error('linkedin: apify scrape failed', { err: String(err) });
    await store.recordRun('linkedin', startedAt, false, { error: String(err) });
    return { error: String(err) };
  }

  const ideas: IdeaRow[] = [];
  for (const p of posts) {
    const text = textOf(p);
    const link = urlOf(p);
    if (text.length < 30 || !link) continue;
    ideas.push({
      dedup_key: `linkedin:${link}`,
      source: 'linkedin',
      source_url: link,
      author: authorOf(p),
      posted_at: p.postedAt ?? p.publishedAt ?? p.date ?? null,
      app_name: null,
      concept: text.slice(0, 400),
      category: null,
      novelty: null, buildability: null, demand: null, play: null, why: null,
      status: 'new',
      captured_at: startedAt,
    });
  }
  const inserted = await store.upsertIdeas(ideas);
  log.info(`linkedin: ${posts.length} posts, ${inserted} idea candidates stored`);
  await store.recordRun('linkedin', startedAt, true, { posts: posts.length, candidates: inserted });
  return { posts: posts.length, candidates: inserted };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runLinkedInIngest().then((r) => log.info('linkedin ingest done', r));
}
