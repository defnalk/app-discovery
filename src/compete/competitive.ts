/**
 * Product-side competitive analysis: the product equivalent of the campaign
 * social-listening tool. A Play manager gives an app + category; the workflow
 *   1. discovers the competitor set (Apify Google Play search + the local app
 *      store DB, the same fetching layer the nightly ingest uses), then
 *   2. hands the seed app + candidates to Claude, which curates the set and
 *      returns a structured breakdown (pricing, markets, features, feature→ICP).
 *
 * Store metadata never covers pricing tiers or ICP mapping, Claude enriches
 * those from its own knowledge, and from live web context when ANTHROPIC_WEB_SEARCH
 * is enabled (the Anthropic web_search server tool). The model is the high-value,
 * interactive opus-tier (override with COMPETE_MODEL); like the nightly analyzer
 * this skips politely when ANTHROPIC_API_KEY is unset.
 */
import { fetchJson } from '../lib/http.ts';
import { log } from '../lib/log.ts';
import { getStore, type AppRow, type RollupRow } from '../lib/store.ts';

// ---------------------------------------------------------------- types
export type CompetitorCandidate = {
  store_id: string | null;
  name: string;
  developer: string | null;
  category: string | null;
  description: string | null;
  rating: number | null;
  rating_count: number | null;
  installs: number | null;
  markets_charting: string[];
  source: 'play_search' | 'store_db';
};

export type PricingTier = { name: string; price: string; billing: string; highlights: string[] };
export type FeatureIcp = { feature: string; icp: string; rationale: string };

export type Competitor = {
  name: string;
  store_id: string;
  developer: string;
  positioning: string;
  pricing: { model: string; tiers: PricingTier[] };
  markets: string[];
  features: string[];
  feature_icp_map: FeatureIcp[];
  notes: string;
};

export type CompetitiveAnalysis = {
  id?: string; // assigned when persisted to the history store
  app: string;
  category: string;
  summary: string;
  icps: string[];
  competitors: Competitor[];
  meta: {
    model: string;
    web_search: boolean;
    candidates_found: number;
    sources: string[];
    generated_at: string;
  };
};

export type ProgressEvent =
  | { step: 'discover' | 'fetch' | 'analyze'; status: 'start' | 'done'; detail: string; count?: number };

// ---------------------------------------------------------------- discovery
const PLAY_ACTOR = process.env.APIFY_PLAY_ACTOR ?? 'epctex~google-play-scraper';

type PlayItem = {
  appId?: string; id?: string; title?: string; name?: string;
  developer?: string; genre?: string; category?: string;
  description?: string; summary?: string;
  score?: number; ratings?: number; reviews?: number;
  installs?: string; minInstalls?: number;
};

function installsToNumber(installs: string | undefined, minInstalls: number | undefined): number | null {
  if (minInstalls != null) return minInstalls;
  if (!installs) return null;
  const n = Number(installs.replace(/[+,.\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * Live Google Play search via the same Apify actor the nightly ingest uses.
 * Best-effort: returns [] (never throws) when APIFY_TOKEN is unset or the run
 * fails, so the workflow falls back to the store DB and Claude's own knowledge.
 */
async function searchGooglePlay(query: string, limit: number): Promise<CompetitorCandidate[]> {
  const token = process.env.APIFY_TOKEN;
  if (!token) return [];
  try {
    const url = `https://api.apify.com/v2/acts/${PLAY_ACTOR}/run-sync-get-dataset-items?token=${token}&timeout=120`;
    const items = await fetchJson<PlayItem[]>(url, {
      service: 'apify', minGapMs: 1000, retries: 1, timeoutMs: 120_000,
      init: {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // epctex/google-play-scraper search mode; harmless extras ignored by other actors
        body: JSON.stringify({ mode: 'search', search: query, country: 'us', maxItems: limit, proxy: { useApifyProxy: true } }),
      },
    });
    return (items ?? []).filter((i) => i.appId || i.id).slice(0, limit).map((i) => ({
      store_id: (i.appId ?? i.id) ?? null,
      name: i.title ?? i.name ?? (i.appId ?? i.id) ?? 'unknown',
      developer: i.developer ?? null,
      category: i.genre ?? i.category ?? null,
      description: (i.description ?? i.summary ?? '').slice(0, 600) || null,
      rating: i.score ?? null,
      rating_count: i.ratings ?? i.reviews ?? null,
      installs: installsToNumber(i.installs, i.minInstalls),
      markets_charting: [],
      source: 'play_search' as const,
    }));
  } catch (err) {
    log.warn('compete: Google Play search failed, falling back to store DB', { err: String(err), query });
    return [];
  }
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Pull candidates from the already-ingested app store DB by fuzzy-matching the
 * seed app name and category tokens against name/category/description. Reuses
 * the live traction signal (rollups) already computed by the nightly pipeline.
 */
async function searchStoreDb(app: string, category: string, limit: number): Promise<CompetitorCandidate[]> {
  const store = getStore();
  let apps: AppRow[];
  let rollups: RollupRow[];
  try {
    [apps, rollups] = await Promise.all([store.listApps(), store.listRollups()]);
  } catch (err) {
    log.warn('compete: store DB unavailable for discovery', { err: String(err) });
    return [];
  }
  const rollupByApp = new Map(rollups.map((r) => [r.app_id, r]));
  const tokens = [...new Set([...norm(app).split(' '), ...norm(category).split(' ')])].filter((t) => t.length > 2);
  if (!tokens.length) return [];

  const scored = apps
    .filter((a) => a.status === 'active')
    .map((a) => {
      const hay = norm([a.name, a.category, a.description].filter(Boolean).join(' '));
      const nameHay = norm(a.name);
      let score = 0;
      for (const t of tokens) {
        if (nameHay.includes(t)) score += 3;
        else if (hay.includes(t)) score += 1;
      }
      return { a, score };
    })
    .filter((x) => x.score > 0)
    .sort((x, y) => y.score - x.score)
    .slice(0, limit);

  return scored.map(({ a }) => {
    const r = rollupByApp.get(a.id);
    return {
      store_id: a.store_id,
      name: a.name,
      developer: a.developer_name,
      category: a.category,
      description: (a.description ?? '').slice(0, 600) || null,
      rating: r?.rating ?? null,
      rating_count: r?.rating_count ?? null,
      installs: null,
      markets_charting: r?.geos_live ?? [],
      source: 'store_db' as const,
    };
  });
}

/** Merge Play-search + store-DB candidates, de-duping by store_id then name. */
export async function discoverCompetitors(app: string, category: string, limit = 8): Promise<CompetitorCandidate[]> {
  const [fromPlay, fromDb] = await Promise.all([
    searchGooglePlay(`${app} ${category}`.trim(), limit),
    searchStoreDb(app, category, limit),
  ]);
  const seen = new Set<string>();
  const seedKey = norm(app);
  const out: CompetitorCandidate[] = [];
  for (const c of [...fromPlay, ...fromDb]) {
    const key = (c.store_id || norm(c.name));
    if (seen.has(key)) continue;
    if (norm(c.name) === seedKey) continue; // don't list the seed app as its own competitor
    seen.add(key);
    out.push(c);
  }
  return out.slice(0, limit);
}

// ---------------------------------------------------------------- analysis
export const COMPETITIVE_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    icps: { type: 'array', items: { type: 'string' } },
    competitors: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          store_id: { type: 'string' },
          developer: { type: 'string' },
          positioning: { type: 'string' },
          pricing: {
            type: 'object',
            properties: {
              model: { type: 'string' },
              tiers: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    price: { type: 'string' },
                    billing: { type: 'string' },
                    highlights: { type: 'array', items: { type: 'string' } },
                  },
                  required: ['name', 'price', 'billing', 'highlights'],
                  additionalProperties: false,
                },
              },
            },
            required: ['model', 'tiers'],
            additionalProperties: false,
          },
          markets: { type: 'array', items: { type: 'string' } },
          features: { type: 'array', items: { type: 'string' } },
          feature_icp_map: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                feature: { type: 'string' },
                icp: { type: 'string' },
                rationale: { type: 'string' },
              },
              required: ['feature', 'icp', 'rationale'],
              additionalProperties: false,
            },
          },
          notes: { type: 'string' },
        },
        required: ['name', 'store_id', 'developer', 'positioning', 'pricing', 'markets', 'features', 'feature_icp_map', 'notes'],
        additionalProperties: false,
      },
    },
  },
  required: ['summary', 'icps', 'competitors'],
  additionalProperties: false,
} as const;

export function competitivePrompt(app: string, category: string, candidates: CompetitorCandidate[]): string {
  return `You are a product strategist briefing a Google Play product manager on the COMPETITIVE LANDSCAPE for an app before and around its launch.

TARGET APP: ${app}
CATEGORY / POSITIONING: ${category}

The product manager needs to understand who they are really competing with and how those competitors are positioned, not a generic market overview.

Below are candidate apps discovered from the Google Play store and our internal app database. Store metadata is incomplete (it does NOT include pricing tiers, the markets a company actually operates in, or which features map to which ideal-customer-profile). Treat these as SEEDS:
- Keep the candidates that are genuine competitors of ${app} in the "${category}" space.
- Drop candidates that are off-target (wrong category, a tool/SDK, an obvious mismatch).
- ADD the well-known direct competitors you know of that are missing from the list, do not limit yourself to the candidates.
- Aim for the 5-8 most relevant competitors.

For EACH competitor return:
- name, store_id (use the candidate's store_id if known, else ""), developer (else "")
- positioning: one sentence on how they position themselves
- pricing: { model (e.g. "freemium + subscription", "one-time", "usage-based"), tiers: [{ name, price (e.g. "$12.99/mo" or "Free"), billing (e.g. "monthly", "annual", "one-time", "free"), highlights: [short strings of what the tier unlocks] }] }
- markets: the countries/regions they actually operate in or target
- features: the notable product features / capabilities
- feature_icp_map: for the features that matter most, map each to the ideal customer profile it serves, [{ feature, icp (the specific user segment, e.g. "anxiety sufferers seeking 3am support", not "everyone"), rationale (one line: why that feature wins that ICP) }]
- notes: anything else a PM should know (recent moves, weaknesses, moats)

Also return:
- icps: the distinct ideal-customer-profiles that exist across this category
- summary: a few sentences on the overall competitive landscape and where ${app} can win

Enrich pricing tiers, markets, and ICP mapping from your own knowledge${
    process.env.ANTHROPIC_WEB_SEARCH ? ' and from current web search (verify pricing and markets against live sources where you can)' : ''
  }, the store metadata will not contain them.

CANDIDATES (JSON):
${JSON.stringify(candidates, null, 1)}

Return ONLY a JSON object of the form:
{"summary": "...", "icps": ["..."], "competitors": [{"name","store_id","developer","positioning","pricing":{"model","tiers":[{"name","price","billing","highlights":[]}]},"markets":[],"features":[],"feature_icp_map":[{"feature","icp","rationale"}],"notes"}]}`;
}

/** Tolerant JSON extraction: handles a stray code fence or leading prose. */
function extractJson<T>(text: string): T {
  const trimmed = text.trim();
  try { return JSON.parse(trimmed) as T; } catch { /* fall through */ }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try { return JSON.parse(fenced[1].trim()) as T; } catch { /* fall through */ }
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) return JSON.parse(trimmed.slice(start, end + 1)) as T;
  throw new Error('Model did not return parseable JSON');
}

const str = (v: unknown, fallback = '') => (typeof v === 'string' ? v : v == null ? fallback : String(v));
const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => str(x)).filter(Boolean) : []);

/** Coerce the model's JSON into the strict Competitor shape so rendering never crashes. */
function normalizeCompetitor(raw: Record<string, unknown>): Competitor {
  const pricing = (raw.pricing as Record<string, unknown> | undefined) ?? {};
  const tiersRaw = Array.isArray(pricing.tiers) ? (pricing.tiers as Record<string, unknown>[]) : [];
  const mapRaw = Array.isArray(raw.feature_icp_map) ? (raw.feature_icp_map as Record<string, unknown>[]) : [];
  return {
    name: str(raw.name, 'Unknown'),
    store_id: str(raw.store_id),
    developer: str(raw.developer),
    positioning: str(raw.positioning),
    pricing: {
      model: str(pricing.model, 'unknown'),
      tiers: tiersRaw.map((t) => ({
        name: str(t.name),
        price: str(t.price),
        billing: str(t.billing),
        highlights: strArr(t.highlights),
      })),
    },
    markets: strArr(raw.markets),
    features: strArr(raw.features),
    feature_icp_map: mapRaw.map((m) => ({
      feature: str(m.feature),
      icp: str(m.icp),
      rationale: str(m.rationale),
    })).filter((m) => m.feature || m.icp),
    notes: str(raw.notes),
  };
}

export async function analyzeCompetitors(
  app: string,
  category: string,
  candidates: CompetitorCandidate[],
): Promise<{ summary: string; icps: string[]; competitors: Competitor[]; model: string; webSearch: boolean }> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set, set it to run the competitive analysis.');
  }
  // Sonnet, not Opus: this runs inside Vercel's 60s function cap, and Opus generating
  // ~8-12k tokens over the competitor set reliably blows past it. Sonnet finishes the
  // structured analysis in ~20s at equivalent quality. Override via COMPETE_MODEL only
  // on a plan with a longer function timeout.
  const model = process.env.COMPETE_MODEL ?? 'claude-sonnet-4-6';
  const webSearch = ['1', 'true', 'yes'].includes((process.env.ANTHROPIC_WEB_SEARCH ?? '').toLowerCase());
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic();
  const prompt = competitivePrompt(app, category, candidates);

  // Base request. With web_search we run the server-tool loop and ask for JSON in
  // the prompt (forced json_schema output is reserved for the no-tool path, where
  // there is no tool loop to interleave with). Without it we pin output_config so
  // the structure is guaranteed every run, the convention from jobs/analyze.ts.
  const base: Record<string, unknown> = { model, max_tokens: 8_000 };
  if (webSearch) {
    base.tools = [{ type: 'web_search_20260209', name: 'web_search', max_uses: 5 }];
  } else {
    base.output_config = { format: { type: 'json_schema', schema: COMPETITIVE_SCHEMA as unknown as Record<string, unknown> } };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Msg = { role: 'user' | 'assistant'; content: unknown };
  let messages: Msg[] = [{ role: 'user', content: prompt }];
  let response = await client.messages.create({ ...base, messages } as never);
  let guard = 0;
  // Server tools (web_search) run a server-side loop; on pause_turn re-send with
  // the assistant content appended so the server resumes where it left off.
  while ((response as { stop_reason?: string }).stop_reason === 'pause_turn' && guard++ < 6) {
    messages = [...messages, { role: 'assistant', content: (response as { content: unknown }).content }];
    response = await client.messages.create({ ...base, messages } as never);
  }

  const usage = (response as { usage?: { input_tokens?: number; output_tokens?: number } }).usage ?? {};
  log.external('anthropic', `messages.create ${model}`, {
    input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, web_search: webSearch,
  });

  const blocks = (response as { content: { type: string; text?: string }[] }).content ?? [];
  const text = blocks.filter((b) => b.type === 'text' && b.text).map((b) => b.text).join('');
  if (!text.trim()) throw new Error('Claude returned no text output to parse.');

  const parsed = extractJson<Record<string, unknown>>(text);
  const competitorsRaw = Array.isArray(parsed.competitors) ? (parsed.competitors as Record<string, unknown>[]) : [];
  const competitors = competitorsRaw.map(normalizeCompetitor);
  if (!competitors.length) throw new Error('Analysis returned no competitors.');

  return {
    summary: str(parsed.summary),
    icps: strArr(parsed.icps),
    competitors,
    model,
    webSearch,
  };
}

// ---------------------------------------------------------------- orchestrator
export async function runCompetitiveAnalysis(
  app: string,
  category: string,
  onProgress: (e: ProgressEvent) => void = () => {},
): Promise<CompetitiveAnalysis> {
  app = app.trim();
  category = category.trim();
  if (!app || !category) throw new Error('Both an app and a category are required.');

  onProgress({ step: 'discover', status: 'start', detail: `Finding competitors of ${app} in "${category}"…` });
  const candidates = await discoverCompetitors(app, category);
  const sources = [...new Set(candidates.map((c) => c.source))];
  onProgress({ step: 'discover', status: 'done', detail: `Found ${candidates.length} candidate apps`, count: candidates.length });

  onProgress({ step: 'fetch', status: 'start', detail: 'Gathering store metadata…' });
  // Metadata is already attached to each candidate by the discovery layer; this
  // step is the explicit point where it is assembled for the model.
  onProgress({ step: 'fetch', status: 'done', detail: `Assembled metadata for ${candidates.length} apps`, count: candidates.length });

  onProgress({ step: 'analyze', status: 'start', detail: 'Analyzing pricing, markets, features & ICP fit with Claude…' });
  const result = await analyzeCompetitors(app, category, candidates);
  onProgress({ step: 'analyze', status: 'done', detail: `Analyzed ${result.competitors.length} competitors`, count: result.competitors.length });

  return {
    app,
    category,
    summary: result.summary,
    icps: result.icps,
    competitors: result.competitors,
    meta: {
      model: result.model,
      web_search: result.webSearch,
      candidates_found: candidates.length,
      sources,
      generated_at: new Date().toISOString(),
    },
  };
}

// ---------------------------------------------------------------- CLI (parity with other jobs)
if (import.meta.url === `file://${process.argv[1]}`) {
  const app = process.argv[2];
  const category = process.argv.slice(3).join(' ');
  if (!app || !category) {
    console.error('usage: node src/compete/competitive.ts "<app>" "<category>"');
    process.exit(1);
  }
  runCompetitiveAnalysis(app, category, (e) => log.info(`compete:${e.step} ${e.status}`, { detail: e.detail }))
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((err) => { log.error('compete: analysis failed', { err: String(err) }); process.exit(1); });
}
