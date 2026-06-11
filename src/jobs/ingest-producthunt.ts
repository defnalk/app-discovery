/**
 * Product Hunt ingest: daily top posts filtered to consumer-app topics.
 * Posts that match an existing app by normalized name become app_claims rows
 * (claimed_metric=ph_upvotes + any user/download claims parsed from the tagline),
 * which the factcheck job then verifies against store data.
 * Skips itself when PRODUCT_HUNT_TOKEN is unset.
 */
import { PH_CONSUMER_TOPICS } from '../lib/config.ts';
import { fetchJson } from '../lib/http.ts';
import { log } from '../lib/log.ts';
import { getStore } from '../lib/store.ts';
import { extractClaims } from './ingest-x.ts';

const PH_API = 'https://api.producthunt.com/v2/api/graphql';

type PhPost = {
  name: string; tagline: string; url: string; votesCount: number;
  topics: { nodes: { slug: string }[] };
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export async function runProductHuntIngest() {
  const store = getStore();
  const startedAt = new Date().toISOString();
  const token = process.env.PRODUCT_HUNT_TOKEN;
  if (!token) {
    log.warn('producthunt: PRODUCT_HUNT_TOKEN not set, skipping');
    await store.recordRun('producthunt', startedAt, true, { skipped: 'no PRODUCT_HUNT_TOKEN' });
    return { skipped: true };
  }

  const query = `query { posts(order: VOTES, postedAfter: "${new Date(Date.now() - 86_400_000).toISOString()}", first: 50) {
    nodes { name tagline url votesCount topics(first: 6) { nodes { slug } } } } }`;

  const json = await fetchJson<{ data: { posts: { nodes: PhPost[] } } }>(PH_API, {
    service: 'producthunt', minGapMs: 2000,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ query }),
    },
  });

  const consumer = (json.data?.posts?.nodes ?? []).filter((p) =>
    p.topics.nodes.some((t) => PH_CONSUMER_TOPICS.includes(t.slug)),
  );

  // Match posts to known apps by normalized name; record claims for matches.
  const apps = await store.listApps();
  const byName = new Map(apps.map((a) => [norm(a.name.split(/[-–—:|]/)[0]), a]));
  const claims = [];
  for (const post of consumer) {
    const app = byName.get(norm(post.name));
    if (!app) continue;
    claims.push({
      app_id: app.id, claimed_metric: 'ph_upvotes', claimed_value: post.votesCount,
      claim_source_url: post.url, verified_value: null, discrepancy_ratio: null, captured_at: startedAt,
    });
    for (const c of extractClaims(post.tagline)) {
      claims.push({
        app_id: app.id, claimed_metric: c.metric, claimed_value: c.value,
        claim_source_url: post.url, verified_value: null, discrepancy_ratio: null, captured_at: startedAt,
      });
    }
  }
  const inserted = await store.insertClaims(claims);
  log.info(`producthunt: ${consumer.length} consumer posts, ${inserted} claims recorded`);
  await store.recordRun('producthunt', startedAt, true, { posts: consumer.length, claims: inserted });
  return { posts: consumer.length, claims: inserted };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runProductHuntIngest().then((r) => log.info('producthunt ingest done', r));
}
