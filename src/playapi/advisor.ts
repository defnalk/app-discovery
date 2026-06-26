/** POST /api/advisor {appName, category, freeFeatures, paidFeatures, competitors?, notes?}
 *  → Claude compares the manager's app against competitors and returns a structured
 *  recommendations report (positioning, feature gaps, differentiation, pricing, quick wins).
 *
 *  Grounding: best-effort, pulls same-category apps from the tracked catalog (apps +
 *  app_rollups + app_analysis) so the model reasons about the real market, not just its
 *  own memory of the named competitors. Catalog lookup never blocks the report.
 *
 *  Fails CLOSED on missing secrets: 503 when ANTHROPIC_API_KEY is unset (so the tab
 *  degrades gracefully instead of 500-ing). LLM call is rate-limited per manager. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getServiceClient, readSession, readJsonBody, json, str, checkRateLimit } from './_lib.ts';

const ADVISOR_SCHEMA = {
  type: 'object',
  properties: {
    positioning: { type: 'string' },
    feature_gaps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          feature: { type: 'string' },
          why_it_matters: { type: 'string' },
          seen_in: { type: 'string' },
        },
        required: ['feature', 'why_it_matters', 'seen_in'],
        additionalProperties: false,
      },
    },
    differentiation: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          idea: { type: 'string' },
          rationale: { type: 'string' },
        },
        required: ['idea', 'rationale'],
        additionalProperties: false,
      },
    },
    pricing: {
      type: 'object',
      properties: {
        assessment: { type: 'string' },
        recommendations: { type: 'array', items: { type: 'string' } },
      },
      required: ['assessment', 'recommendations'],
      additionalProperties: false,
    },
    quick_wins: { type: 'array', items: { type: 'string' } },
  },
  required: ['positioning', 'feature_gaps', 'differentiation', 'pricing', 'quick_wins'],
  additionalProperties: false,
} as const;

type Competitor = { name: string; developer: string | null; rating_count: number | null; saturation_note: string | null };

/** Best-effort same-category competitors from the tracked catalog. Never throws. */
async function catalogCompetitors(category: string, ownName: string): Promise<Competitor[]> {
  if (!category) return [];
  try {
    const sb = getServiceClient();
    const { data: apps } = await sb.from('apps')
      .select('id, name, developer_name, category')
      .ilike('category', `%${category}%`).eq('status', 'active').limit(80);
    if (!apps?.length) return [];
    const ids = apps.map((a) => a.id);
    const [{ data: rollups }, { data: analyses }] = await Promise.all([
      sb.from('app_rollups').select('app_id, rating_count, is_incumbent').in('app_id', ids),
      sb.from('app_analysis').select('app_id, saturation_note').in('app_id', ids),
    ]);
    const rollupBy = new Map((rollups ?? []).map((r) => [r.app_id, r]));
    const noteBy = new Map((analyses ?? []).map((a) => [a.app_id, a.saturation_note as string | null]));
    const own = ownName.trim().toLowerCase();
    return apps
      .filter((a) => a.name.trim().toLowerCase() !== own && !rollupBy.get(a.id)?.is_incumbent)
      .map((a) => ({
        name: a.name,
        developer: a.developer_name as string | null,
        rating_count: (rollupBy.get(a.id)?.rating_count ?? null) as number | null,
        saturation_note: noteBy.get(a.id) ?? null,
      }))
      .sort((x, y) => (y.rating_count ?? 0) - (x.rating_count ?? 0))
      .slice(0, 8);
  } catch (err) {
    console.error('advisor: catalog lookup failed (continuing without it):', String(err));
    return [];
  }
}

function advisorPrompt(input: {
  appName: string; category: string; freeFeatures: string; paidFeatures: string;
  competitors: string; notes: string; catalog: Competitor[];
}): string {
  const catalogBlock = input.catalog.length
    ? `\nSame-category apps we track (real market context — use these as competitors too):\n${JSON.stringify(input.catalog, null, 1)}`
    : '';
  return `You are a product strategy advisor for a consumer mobile app. A manager wants a concrete, opinionated competitive report comparing their app against competitors — what to add, how to differentiate, and how to price.

THEIR APP: ${input.appName}${input.category ? ` (category: ${input.category})` : ''}
Free / main features:
${input.freeFeatures || '(none provided)'}
Paid / premium features:
${input.paidFeatures || '(none provided)'}
${input.competitors ? `Competitors the manager named: ${input.competitors}` : ''}${input.notes ? `\nManager notes: ${input.notes}` : ''}${catalogBlock}

Use your own knowledge of the named competitors AND the tracked apps above. Be specific and decisive — name real competitor features, not generic advice. Return one report object:
- positioning: 2-3 sentences on where this app stands vs the field today.
- feature_gaps: features competitors have that this app lacks. For each: feature, why_it_matters (impact on retention/conversion/growth), seen_in (which competitor(s) ship it). 3-6 items, highest-impact first.
- differentiation: ways this app could stand out / win a niche competitors underserve. For each: idea, rationale. 2-4 items.
- pricing: assessment of their free/paid split (is too much free? is the paywall in the right place?) plus recommendations — concrete paywall/pricing moves (what to gate, price points, trial/subscription structure). 2-5 recommendations.
- quick_wins: prioritized, concrete next steps the team could ship soon. 3-6 short imperative bullets.

Be honest about weaknesses. Don't pad. Ground every claim in a real competitor or market dynamic.`;
}

export default async function handler(req: IncomingMessage & { method?: string }, res: ServerResponse) {
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
  const sess = readSession(req);
  if (!sess) return json(res, 401, { error: 'login required' });
  if (!checkRateLimit(`${sess.name}:advisor`, 12)) return json(res, 429, { error: 'too many advisor runs this hour, slow down' });
  if (!process.env.ANTHROPIC_API_KEY) return json(res, 503, { error: 'advisor is not configured yet (no ANTHROPIC_API_KEY)' });

  const b = await readJsonBody<{ appName?: string; category?: string; freeFeatures?: string; paidFeatures?: string; competitors?: string; notes?: string }>(req);
  const appName = str(b.appName, 200).trim();
  const freeFeatures = str(b.freeFeatures, 4000).trim();
  const paidFeatures = str(b.paidFeatures, 4000).trim();
  if (!appName) return json(res, 400, { error: 'app name required' });
  if (!freeFeatures && !paidFeatures) return json(res, 400, { error: 'enter at least your main or paid features' });

  const category = str(b.category, 100).trim();
  const competitors = str(b.competitors, 600).trim();
  const notes = str(b.notes, 1500).trim();
  const catalog = await catalogCompetitors(category, appName);

  const model = process.env.ADVISOR_MODEL ?? 'claude-opus-4-8';
  try {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic();
    const response = await client.messages.create({
      model,
      max_tokens: 3000,
      messages: [{ role: 'user', content: advisorPrompt({ appName, category, freeFeatures, paidFeatures, competitors, notes, catalog }) }],
      output_config: { format: { type: 'json_schema', schema: ADVISOR_SCHEMA as unknown as Record<string, unknown> } },
    });
    const text = response.content.find((c) => c.type === 'text');
    if (!text || text.type !== 'text') return json(res, 502, { error: 'no report produced, try again' });
    const report = JSON.parse(text.text);
    return json(res, 200, { report, model, grounded_on: catalog.map((c) => c.name) });
  } catch (err) {
    console.error('advisor failed:', String(err));
    return json(res, 502, { error: 'advisor request failed, try again in a moment' });
  }
}
