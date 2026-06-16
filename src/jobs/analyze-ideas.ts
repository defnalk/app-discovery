/**
 * Idea Radar — scoring. Takes raw idea candidates (status 'new') from the X /
 * LinkedIn ingest, and uses Claude Haiku to extract the app concept and score it
 * on the same lens the store-app analyzer uses: is it a groundbreaking idea, is it
 * SIMPLE to build, and is there real demand. Writes back novelty / buildability /
 * demand / play / why and flips status to 'scored'. Gated on ANTHROPIC_API_KEY;
 * idempotent (only 'new' rows are processed).
 */
import { log } from '../lib/log.ts';
import { getStore, type IdeaRow } from '../lib/store.ts';
import { ideaPlayScore } from '../lib/config.ts';

const NIGHTLY_CAP = 40; // bounds token spend
const BATCH = 10;

type Scored = {
  dedup_key: string;
  app_name: string;
  concept: string;
  category: string;
  novelty: number;
  buildability: 'weekend' | 'few_days' | 'week_or_two' | 'months' | 'too_complex';
  demand: number;
  why: string;
};

export function ideaPrompt(batch: IdeaRow[]): string {
  const items = batch.map((i) => ({ dedup_key: i.dedup_key, source: i.source, post: i.concept }));
  return `You scout NEW consumer-app opportunities for a studio that ships polished apps in days. Each item below is a social post (X / LinkedIn) about an app someone is building or just launched. For each, identify the underlying app concept and score it as a "play" the studio could build fast.

Return one object per item (same dedup_key):
- app_name: the product's name if stated, else a short descriptive name you coin.
- concept: one crisp sentence — what the app does.
- category: e.g. Productivity, Photo & Video, Health & Fitness, Finance, Social, Utilities, Education, Entertainment.
- novelty (0-10): how groundbreaking / fresh the angle is. High = a genuinely new twist or underserved niche; low = a clone of something ubiquitous.
- buildability: can a strong small team rebuild the CORE with AI-assisted coding? one of "weekend" | "few_days" | "week_or_two" | "months" | "too_complex". Single-feature utilities and AI-API wrappers are fast; anything needing network effects / cold-start, heavy custom ML, bank/health regulation, or hardware is slow.
- demand (0-10): evidence of real pull — traction claims, engagement, a painful/popular niche. Low = no signal / vanity.
- why: one sentence on why it's an attractive fast play (or the main risk).

Be decisive. Favor simple, buildable, monetizable consumer apps. Ignore big-tech / AI-lab flagships.

ITEMS (JSON):
${JSON.stringify(items, null, 1)}

Return JSON: {"ideas": [{dedup_key, app_name, concept, category, novelty, buildability, demand, why}, ...]}.`;
}

export const IDEA_SCHEMA = {
  type: 'object',
  properties: {
    ideas: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          dedup_key: { type: 'string' },
          app_name: { type: 'string' },
          concept: { type: 'string' },
          category: { type: 'string' },
          novelty: { type: 'number' },
          buildability: { type: 'string', enum: ['weekend', 'few_days', 'week_or_two', 'months', 'too_complex'] },
          demand: { type: 'number' },
          why: { type: 'string' },
        },
        required: ['dedup_key', 'app_name', 'concept', 'category', 'novelty', 'buildability', 'demand', 'why'],
        additionalProperties: false,
      },
    },
  },
  required: ['ideas'],
  additionalProperties: false,
} as const;

export async function runIdeaAnalysis() {
  const store = getStore();
  const startedAt = new Date().toISOString();
  if (!process.env.ANTHROPIC_API_KEY) {
    log.warn('analyze-ideas: ANTHROPIC_API_KEY not set, skipping');
    await store.recordRun('analyze-ideas', startedAt, true, { skipped: 'no ANTHROPIC_API_KEY' });
    return { skipped: true };
  }
  const all = await store.listIdeas();
  const targets = all.filter((i) => i.status === 'new').slice(0, NIGHTLY_CAP);
  if (!targets.length) {
    await store.recordRun('analyze-ideas', startedAt, true, { scored: 0 });
    return { scored: 0 };
  }

  const model = process.env.HAIKU_MODEL ?? 'claude-haiku-4-5';
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic();
  const byKey = new Map(targets.map((i) => [i.dedup_key, i]));

  const updates: IdeaRow[] = [];
  let errors = 0;
  for (let i = 0; i < targets.length; i += BATCH) {
    const batch = targets.slice(i, i + BATCH);
    try {
      const response = await client.messages.create({
        model, max_tokens: 4000,
        messages: [{ role: 'user', content: ideaPrompt(batch) }],
        output_config: { format: { type: 'json_schema', schema: IDEA_SCHEMA as unknown as Record<string, unknown> } },
      });
      log.external('anthropic', `messages.create ${model}`, {
        input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens,
      });
      const text = response.content.find((b) => b.type === 'text');
      if (text && text.type === 'text') {
        for (const s of (JSON.parse(text.text) as { ideas: Scored[] }).ideas) {
          const orig = byKey.get(s.dedup_key);
          if (!orig) continue;
          updates.push({
            ...orig,
            app_name: s.app_name, concept: s.concept, category: s.category,
            novelty: s.novelty, buildability: s.buildability, demand: s.demand,
            play: ideaPlayScore(s.novelty, s.demand, s.buildability),
            why: s.why, status: 'scored',
          });
        }
      }
    } catch (err) {
      errors++;
      log.error(`analyze-ideas: batch ${i / BATCH} failed`, { err: String(err) });
    }
  }

  const scored = await store.upsertIdeas(updates);
  log.info(`analyze-ideas: ${scored} ideas scored (${errors} batch errors)`);
  await store.recordRun('analyze-ideas', startedAt, errors === 0, { scored, errors });
  return { scored, errors };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runIdeaAnalysis().then((r) => log.info('analyze-ideas done', r));
}
