/**
 * Delta-CRM cross-tab: lead inventory (per industry bucket x geo) crossed with
 * app-market momentum deltas from the discovery engine. Output feeds the
 * outreach strategy: where market heat is rising vs where we hold sendable leads.
 * Writes data/strategy-input.json and prints a readable summary.
 */
import { writeFileSync } from 'node:fs';
import { getStore } from '../lib/store.ts';
import { getLeadsDb } from './db.ts';
import { isQualified } from './jobs.ts';

const BUCKETS: { key: string; re: RegExp }[] = [
  { key: 'fintech', re: /fintech|financ|bank|crypto|invest|payment|tax|insur/i },
  { key: 'health_fitness', re: /health|fitness|wellness|medical|nutrition|sport/i },
  { key: 'education', re: /edu|learn|language|tutor|school|course/i },
  { key: 'photo_video_design', re: /photo|video|design|graphic|camera|edit/i },
  { key: 'social_entertainment', re: /social|entertain|dating|music|stream|chat|character|companion/i },
  { key: 'commerce_d2c', re: /shop|commerce|retail|beauty|cosmetic|fashion|apparel|jewel|consumer goods|marketplace|d2c/i },
  { key: 'food_delivery', re: /food|restaurant|grocery|deliver|beverage/i },
  { key: 'travel', re: /travel|hospitality|hotel|airline|tour/i },
  { key: 'productivity_ai', re: /productiv|\bai\b|software|saas|tool|utilit|tech/i },
  { key: 'gaming', re: /gam(e|ing)/i },
];
const bucketOf = (s: string | null | undefined) =>
  (s && BUCKETS.find((b) => b.re.test(s))?.key) ?? 'other';

const POOLS = ['in', 'br', 'tr', 'id', 'mx'];
const GEOS = [...POOLS, 'us', 'gb', 'de', 'fr', 'unknown'];

export async function computeStrategyData() {
const store = getStore();
const leadsDb = getLeadsDb();
const [apps, rollups, scores, analyses, leads] = await Promise.all([
  store.listApps(), store.listRollups(), store.listScores(), store.listAnalyses(), leadsDb.listLeadsJoined(),
]);

// ---- market side: per bucket x geo
const appById = new Map(apps.map((a) => [a.id, a]));
const rollupById = new Map(rollups.map((r) => [r.app_id, r]));
const analysisById = new Map(analyses.map((a) => [a.app_id, a]));

type MarketCell = { charting: number; hot: number; newEntries: number; momentumTop: number[]; idea: number[]; saturation: number[] };
const market: Record<string, Record<string, MarketCell>> = {};
const cell = (b: string, g: string) =>
  ((market[b] ??= {})[g] ??= { charting: 0, hot: 0, newEntries: 0, momentumTop: [], idea: [], saturation: [] });

for (const s of scores) {
  const app = appById.get(s.app_id);
  const roll = rollupById.get(s.app_id);
  if (!app || !roll || app.status !== 'active' || roll.is_incumbent) continue;
  const b = bucketOf(app.category);
  const c = cell(b, s.geo);
  c.charting++;
  if ((s.momentum_score ?? 0) >= 0.3) c.hot++;
  if (s.rank_prev == null) c.newEntries++;
  c.momentumTop.push(s.momentum_score ?? 0);
  const an = analysisById.get(s.app_id);
  if (an?.idea_score != null) c.idea.push(an.idea_score);
  if (an?.saturation != null) c.saturation.push(an.saturation);
}

// geo-gap apps = expansion candidates INTO each pool market (new_entrant arm fuel)
const gapInto: Record<string, Record<string, number>> = {};
for (const r of rollups) {
  const app = appById.get(r.app_id);
  if (!app || app.status !== 'active' || r.is_incumbent) continue;
  const b = bucketOf(app.category);
  for (const g of r.geo_gap ?? []) ((gapInto[b] ??= {})[g] = ((gapInto[b] ??= {})[g] ?? 0) + 1);
}

// ---- lead side: per bucket x geo
type LeadCell = { total: number; qualified: number; sendable: number; tierA: number; arms: Record<string, number> };
const book: Record<string, Record<string, LeadCell>> = {};
for (const l of leads) {
  const b = bucketOf(l.category);
  const g = GEOS.includes(l.geo ?? '') ? l.geo! : 'unknown';
  const c = ((book[b] ??= {})[g] ??= { total: 0, qualified: 0, sendable: 0, tierA: 0, arms: {} });
  c.total++;
  if (isQualified(l)) c.qualified++;
  if (l.stage === 'sendable') c.sendable++;
  if ((l.jaka_score ?? 0) >= 8) c.tierA++;
  c.arms[l.source_arm] = (c.arms[l.source_arm] ?? 0) + 1;
}

const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const out = {
  generated_at: new Date().toISOString(),
  pools: POOLS,
  market: Object.fromEntries(Object.entries(market).map(([b, geos]) => [b,
    Object.fromEntries(Object.entries(geos).map(([g, c]) => [g, {
      charting: c.charting, hot: c.hot, new_entries: c.newEntries,
      avg_momentum_top20: avg(c.momentumTop.sort((x, y) => y - x).slice(0, 20))?.toFixed(3) ?? null,
      avg_idea: avg(c.idea)?.toFixed(1) ?? null,
      avg_saturation: avg(c.saturation)?.toFixed(2) ?? null,
    }]))])),
  expansion_candidates_into_pool: gapInto,
  lead_book: book,
};
return out;
}

export type StrategyData = Awaited<ReturnType<typeof computeStrategyData>>;

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = await computeStrategyData();
  writeFileSync('data/strategy-input.json', JSON.stringify(out, null, 1));
  console.log('=== LEAD BOOK vs MARKET HEAT (pool markets) ===');
  for (const b of [...BUCKETS.map((x) => x.key), 'other']) {
    const row: string[] = [];
    for (const g of [...POOLS, 'unknown']) {
      const lb = out.lead_book[b]?.[g];
      const mk = out.market[b]?.[g];
      if (!lb && !mk) continue;
      row.push(`${g}: leads=${lb?.total ?? 0}(s${lb?.sendable ?? 0}/q${lb?.qualified ?? 0}) mkt=${mk?.hot ?? 0}hot gap-in=${out.expansion_candidates_into_pool[b]?.[g] ?? 0}`);
    }
    if (row.length) console.log(b.toUpperCase() + '\n  ' + row.join('\n  '));
  }
  console.log('\nwritten -> data/strategy-input.json');
}
