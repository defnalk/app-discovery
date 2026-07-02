/** POST /api/brief {appName, category} → Claude generates a BUILD BRIEF for a tracked
 *  play: whether and how 8x could build its own app inspired by it. Returns a synthesized
 *  MVP wedge (week-1 scope), competitive gap, organic growth motion, and risks, grounded
 *  on same-category tracked apps. Login-gated, rate-limited, fails closed on missing key. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getServiceClient, readSession, readJsonBody, json, str, checkRateLimit } from './_lib.ts';

const BRIEF_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    mvp_wedge: {
      type: 'object',
      properties: {
        build_time: { type: 'string' },
        plan: { type: 'string' },
        core_features: { type: 'array', items: { type: 'string' } },
      },
      required: ['build_time', 'plan', 'core_features'],
      additionalProperties: false,
    },
    competitive_gap: {
      type: 'array',
      items: {
        type: 'object',
        properties: { gap: { type: 'string' }, why: { type: 'string' } },
        required: ['gap', 'why'],
        additionalProperties: false,
      },
    },
    growth_motion: {
      type: 'array',
      items: {
        type: 'object',
        properties: { channel: { type: 'string' }, tactic: { type: 'string' } },
        required: ['channel', 'tactic'],
        additionalProperties: false,
      },
    },
    risks: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'mvp_wedge', 'competitive_gap', 'growth_motion', 'risks'],
  additionalProperties: false,
} as const;

/** Best-effort same-category peers from the tracked catalog, for real market grounding. */
async function sameCategory(category: string, ownName: string): Promise<string[]> {
  if (!category) return [];
  try {
    const sb = getServiceClient();
    const { data } = await sb.from('apps').select('name').ilike('category', `%${category}%`).eq('status', 'active').limit(40);
    const own = ownName.trim().toLowerCase();
    return (data ?? []).map((a) => a.name as string).filter((n) => n.trim().toLowerCase() !== own).slice(0, 12);
  } catch (err) {
    console.error('brief: catalog lookup failed (continuing):', String(err));
    return [];
  }
}

function briefPrompt(appName: string, category: string, peers: string[]): string {
  const peerBlock = peers.length ? `\nSame-category apps we already track: ${peers.join(', ')}.` : '';
  return `You advise a venture studio (8x) that ships consumer apps fast. They are deciding whether to build their own app inspired by a fast-growing one, and how to get an MVP out quickly. Give a concrete, opinionated BUILD BRIEF, not generic advice.

APP TO LEARN FROM: ${appName}${category ? ` (category: ${category})` : ''}${peerBlock}

Return exactly one brief:
- summary: 1-2 sentences, is this worth building and the single sharpest reason why or why not.
- mvp_wedge: the smallest credible version to ship first. build_time (e.g. "~1 week", "2-3 weeks"), plan (1-2 sentences on the wedge to build first), core_features (3-5 short must-have MVP features).
- competitive_gap: where a new entrant can win, what the leader underdoes. 2-4 items of {gap, why}.
- growth_motion: how apps like this actually grow organically. 2-4 items of {channel (e.g. TikTok, Reels, SEO, referral, ManyChat), tactic (one sentence)}.
- risks: 2-3 real risks or reasons it could fail.

Be specific and decisive, name real features and tactics. Keep every item to 1-2 sentences, no padding, the whole brief must fit the response budget.`;
}

export default async function handler(req: IncomingMessage & { method?: string }, res: ServerResponse) {
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
  const sess = readSession(req);
  if (!sess) return json(res, 401, { error: 'login required' });
  if (!checkRateLimit(`${sess.name}:brief`, 20)) return json(res, 429, { error: 'too many briefs this hour, slow down' });
  if (!process.env.ANTHROPIC_API_KEY) return json(res, 503, { error: 'build brief is not configured yet (no ANTHROPIC_API_KEY)' });

  const b = await readJsonBody<{ appName?: string; category?: string }>(req);
  const appName = str(b.appName, 200).trim();
  if (!appName) return json(res, 400, { error: 'app name required' });
  const category = str(b.category, 100).trim();
  const peers = await sameCategory(category, appName);

  const model = process.env.BRIEF_MODEL ?? 'claude-sonnet-4-6';
  try {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic();
    const response = await client.messages.create({
      model,
      max_tokens: 3000,
      messages: [{ role: 'user', content: briefPrompt(appName, category, peers) }],
      output_config: { format: { type: 'json_schema', schema: BRIEF_SCHEMA as unknown as Record<string, unknown> } },
    });
    if (response.stop_reason === 'max_tokens') return json(res, 502, { error: 'brief was too long, try again' });
    const text = response.content.find((c) => c.type === 'text');
    if (!text || text.type !== 'text') return json(res, 502, { error: 'no brief produced, try again' });
    return json(res, 200, { brief: JSON.parse(text.text), model, grounded_on: peers.slice(0, 6) });
  } catch (err) {
    console.error('brief failed:', String(err));
    return json(res, 502, { error: 'brief request failed, try again in a moment' });
  }
}
