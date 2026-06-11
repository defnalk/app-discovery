/**
 * App analysis: market saturation, idea quality, vibecoding buildability.
 * Three modes:
 *   --prep            select unanalyzed shortlist apps + category stats -> data/analysis/batches.json
 *   --apply <file>    write analysis results to the store, mark too_complex apps
 *   (no flag)         nightly: analyze new shortlist apps with Claude Haiku
 *                     (HAIKU_MODEL env, per the 8x_lead_intel classifier convention);
 *                     skips politely when ANTHROPIC_API_KEY is unset.
 * Saturation has a deterministic base computed from chart data; the model adds
 * a bounded adjustment plus notes. Idempotent: analyzed apps are never re-run.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { log } from '../lib/log.ts';
import { getStore, type AppRow, type RollupRow, type AnalysisRow } from '../lib/store.ts';

export type AppForAnalysis = {
  store_id: string;
  name: string;
  developer: string | null;
  category: string | null;
  description: string | null;
  rating: number | null;
  rating_count: number | null;
  best_rank: number | null;
  momentum: number | null;
  geos: string[];
  saturation_base: number;
  category_stats: string;
};

export type AnalysisResult = {
  store_id: string;
  idea_score: number;
  idea_note: string;
  buildability: 'weekend' | 'few_days' | 'week_or_two' | 'months' | 'too_complex';
  buildability_note: string;
  saturation_adjust: number;
  saturation_note: string;
  too_complex: boolean;
};

export const ANALYSIS_DIR = path.join(process.cwd(), 'data', 'analysis');
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** Deterministic per-category saturation base from chart data. */
function categoryStats(apps: AppRow[], rollups: RollupRow[]) {
  const byId = new Map(rollups.map((r) => [r.app_id, r]));
  const cats = new Map<string, { count: number; incumbents: number; ratingCounts: number[] }>();
  for (const a of apps) {
    const cat = a.category ?? 'Unknown';
    const r = byId.get(a.id);
    if (!r) continue;
    const c = cats.get(cat) ?? { count: 0, incumbents: 0, ratingCounts: [] };
    c.count++;
    if (r.is_incumbent) c.incumbents++;
    if (r.rating_count != null) c.ratingCounts.push(r.rating_count);
    cats.set(cat, c);
  }
  const out = new Map<string, { base: number; summary: string }>();
  for (const [cat, c] of cats) {
    const median = c.ratingCounts.sort((a, b) => a - b)[Math.floor(c.ratingCounts.length / 2)] ?? 0;
    const incumbentShare = c.count ? c.incumbents / c.count : 0;
    const base = clamp01(0.4 * Math.min(c.count / 60, 1) + 0.3 * incumbentShare + 0.3 * Math.min(median / 200_000, 1));
    out.set(cat, {
      base: Number(base.toFixed(2)),
      summary: `${c.count} apps charting in "${cat}", ${(incumbentShare * 100).toFixed(0)}% incumbents, median rating_count ${median.toLocaleString()}`,
    });
  }
  return out;
}

export async function selectForAnalysis(cap: number): Promise<AppForAnalysis[]> {
  const store = getStore();
  const [apps, rollups, analyses] = await Promise.all([store.listApps(), store.listRollups(), store.listAnalyses()]);
  const done = new Set(analyses.map((a) => a.app_id));
  const appById = new Map(apps.map((a) => [a.id, a]));
  const stats = categoryStats(apps, rollups);

  return rollups
    .filter((r) => r.shortlisted && !r.is_incumbent && !done.has(r.app_id))
    .map((r) => ({ r, app: appById.get(r.app_id)! }))
    .filter(({ app }) => app && app.status === 'active')
    .sort((a, b) => (b.r.momentum_score ?? 0) - (a.r.momentum_score ?? 0))
    .slice(0, cap)
    .map(({ r, app }) => {
      const st = stats.get(app.category ?? 'Unknown') ?? { base: 0.5, summary: 'no category data' };
      return {
        store_id: app.store_id,
        name: app.name,
        developer: app.developer_name,
        category: app.category,
        description: (app.description ?? '').slice(0, 350) || null,
        rating: r.rating,
        rating_count: r.rating_count,
        best_rank: r.best_rank,
        momentum: r.momentum_score,
        geos: r.geos_live,
        saturation_base: st.base,
        category_stats: st.summary,
      };
    });
}

export function analysisPrompt(batch: AppForAnalysis[]): string {
  return `You are analyzing trending consumer mobile apps for a team that scouts app OPPORTUNITIES: which trending app concepts are good ideas, how crowded their market is, and whether a competent small team could rebuild the core experience fast with AI-assisted "vibecoding".

For each app below, return one analysis object:
- idea_score (0-10): how good an opportunity the underlying concept is. High = proven demand (chart momentum), simple core loop, clear monetization, room for differentiation. Low = fad, gimmick, or demand tied entirely to a brand/IP.
- idea_note: 1-2 sentences of reasoning.
- buildability: could a strong solo dev / tiny team rebuild the CORE experience with AI coding tools? One of: "weekend" | "few_days" | "week_or_two" | "months" | "too_complex". Consider backend complexity, network effects / cold-start, content licensing, regulation (fintech/health), hardware deps, custom ML infra. Examples: habit tracker = few_days; photo filter app = week_or_two (model APIs exist); UGC social network = months (cold start); a bank or telco app = too_complex.
- buildability_note: 1 sentence on the main constraint or accelerant.
- too_complex: true ONLY for months/too_complex builds with no realistic simplified angle. These get dropped from the shortlist.
- saturation_adjust (-0.2 to +0.2): adjustment to the computed saturation base for its category (provided per app), based on what you know about that specific niche.
- saturation_note: 1 sentence on market crowdedness.

Be decisive and concrete. Do NOT include big-tech/AI-lab apps in high idea scores — the point is buildable opportunities, not ChatGPT.

APPS (JSON):
${JSON.stringify(batch, null, 1)}

Return JSON: {"analyses": [{store_id, idea_score, idea_note, buildability, buildability_note, saturation_adjust, saturation_note, too_complex}, ...]} — one entry per app, same store_id values.`;
}

export const ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    analyses: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          store_id: { type: 'string' },
          idea_score: { type: 'number' },
          idea_note: { type: 'string' },
          buildability: { type: 'string', enum: ['weekend', 'few_days', 'week_or_two', 'months', 'too_complex'] },
          buildability_note: { type: 'string' },
          saturation_adjust: { type: 'number' },
          saturation_note: { type: 'string' },
          too_complex: { type: 'boolean' },
        },
        required: ['store_id', 'idea_score', 'idea_note', 'buildability', 'buildability_note', 'saturation_adjust', 'saturation_note', 'too_complex'],
        additionalProperties: false,
      },
    },
  },
  required: ['analyses'],
  additionalProperties: false,
} as const;

export async function applyResults(results: AnalysisResult[], modelVersion: string) {
  const store = getStore();
  const apps = await store.listApps();
  const byStoreId = new Map(apps.map((a) => [a.store_id, a]));
  const selected = new Map((await selectForAnalysis(100_000)).map((a) => [a.store_id, a]));

  const now = new Date().toISOString();
  const rows: AnalysisRow[] = [];
  const tooComplex: string[] = [];
  for (const r of results) {
    const app = byStoreId.get(r.store_id);
    if (!app) continue;
    const base = selected.get(r.store_id)?.saturation_base ?? 0.5;
    rows.push({
      app_id: app.id,
      analyzed_at: now,
      model_version: modelVersion,
      idea_score: r.idea_score,
      idea_note: r.idea_note,
      buildability: r.buildability,
      buildability_note: r.buildability_note,
      saturation: Number(clamp01(base + (r.saturation_adjust ?? 0)).toFixed(2)),
      saturation_note: r.saturation_note,
      too_complex: r.too_complex,
    });
    if (r.too_complex) tooComplex.push(app.id);
  }
  await store.upsertAnalyses(rows);
  await store.markTooComplex(tooComplex);
  log.info(`analyze: ${rows.length} analyses applied, ${tooComplex.length} marked too_complex`);
  return { applied: rows.length, tooComplex: tooComplex.length };
}

// ---------------------------------------------------------------- nightly (Haiku)
export async function runAnalyze() {
  const store = getStore();
  const startedAt = new Date().toISOString();
  if (!process.env.ANTHROPIC_API_KEY) {
    log.warn('analyze: ANTHROPIC_API_KEY not set, skipping nightly analysis');
    await store.recordRun('analyze', startedAt, true, { skipped: 'no ANTHROPIC_API_KEY' });
    return { skipped: true };
  }
  const model = process.env.HAIKU_MODEL ?? 'claude-haiku-4-5';
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic();

  const targets = await selectForAnalysis(60); // nightly cap bounds token spend
  if (!targets.length) {
    await store.recordRun('analyze', startedAt, true, { analyzed: 0 });
    return { analyzed: 0 };
  }

  const results: AnalysisResult[] = [];
  let errors = 0;
  for (let i = 0; i < targets.length; i += 10) {
    const batch = targets.slice(i, i + 10);
    try {
      const response = await client.messages.create({
        model,
        max_tokens: 4000,
        messages: [{ role: 'user', content: analysisPrompt(batch) }],
        output_config: { format: { type: 'json_schema', schema: ANALYSIS_SCHEMA as unknown as Record<string, unknown> } },
      });
      log.external('anthropic', `messages.create ${model}`, {
        input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens,
      });
      const text = response.content.find((b) => b.type === 'text');
      if (text && text.type === 'text') results.push(...(JSON.parse(text.text) as { analyses: AnalysisResult[] }).analyses);
    } catch (err) {
      errors++;
      log.error(`analyze: batch ${i / 10} failed`, { err: String(err) });
    }
  }

  const summary = await applyResults(results, `nightly:${model}`);
  await store.recordRun('analyze', startedAt, errors === 0, { ...summary, errors });
  return { ...summary, errors };
}

// ---------------------------------------------------------------- CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const mode = process.argv[2];
  if (mode === '--prep') {
    const cap = Number(process.argv[3] ?? 240);
    const targets = await selectForAnalysis(cap);
    mkdirSync(ANALYSIS_DIR, { recursive: true });
    const batches: AppForAnalysis[][] = [];
    for (let i = 0; i < targets.length; i += 15) batches.push(targets.slice(i, i + 15));
    writeFileSync(path.join(ANALYSIS_DIR, 'batches.json'), JSON.stringify(batches));
    log.info(`analyze --prep: ${targets.length} apps in ${batches.length} batches -> data/analysis/batches.json`);
  } else if (mode === '--apply') {
    const file = process.argv[3] ?? path.join(ANALYSIS_DIR, 'results.json');
    const results = JSON.parse(readFileSync(file, 'utf8')) as AnalysisResult[];
    await applyResults(results, process.argv[4] ?? 'workflow:fable-5');
  } else {
    await runAnalyze().then((r) => log.info('analyze done', r));
  }
}
