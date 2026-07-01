/**
 * B2B sourcing job: use Claude (with web search for freshness) to find fast-growing
 * B2B software companies that aren't already tracked, structured with the same schema
 * as the curated list, and append them to src/playapi/b2b-sourced.ts (deduped).
 *
 * The curated base (b2b-data.ts) is never touched — this only grows the auto layer,
 * which /api/b2b merges in. Runs in CI (needs ANTHROPIC_API_KEY); "run every now and
 * then" per the team. Idempotent-ish: re-runs accumulate net-new companies.
 *
 *   node src/jobs/source-b2b.ts            # ~12 new
 *   B2B_SOURCE_COUNT=20 node src/jobs/source-b2b.ts
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { log } from '../lib/log.ts';
import { B2B_COMPANIES, type B2BCompany } from '../playapi/b2b-data.ts';
import { SOURCED, type SourcedCompany } from '../playapi/b2b-sourced.ts';

const BUILDS = ['weekend', 'few_days', 'week', 'weeks', 'complex'];
const norm = (s: string) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function extractJson<T>(text: string): T {
  const t = text.trim();
  const s = Math.min(...['[', '{'].map((c) => (t.indexOf(c) < 0 ? Infinity : t.indexOf(c))));
  const e = Math.max(t.lastIndexOf(']'), t.lastIndexOf('}'));
  if (!Number.isFinite(s) || e < 0) throw new Error('no JSON found in model output');
  return JSON.parse(t.slice(s, e + 1)) as T;
}

/** Coerce a raw model object into a valid B2BCompany, or null if unusable. */
function clean(o: Record<string, unknown>): B2BCompany | null {
  const str = (v: unknown, max = 200) => String(v ?? '').slice(0, max).trim();
  const arr = (v: unknown) => (Array.isArray(v) ? v.map((x) => str(x, 80)).filter(Boolean).slice(0, 6) : []);
  const name = str(o.name, 80);
  if (!name) return null;
  const build = BUILDS.includes(String(o.build)) ? (o.build as B2BCompany['build']) : 'weeks';
  let signal = Math.round(Number(o.signal));
  if (!Number.isFinite(signal)) signal = 60;
  signal = Math.max(0, Math.min(100, signal));
  let url = str(o.url, 120);
  if (url && !/^https?:\/\//.test(url)) url = 'https://' + url.replace(/^\/+/, '');
  return {
    name, category: str(o.category, 60) || 'B2B software', channel: str(o.channel, 40) || 'Web app',
    arr: str(o.arr, 40) || 'Fast-growing', customers: str(o.customers, 60) || 'Businesses',
    signal, build, url, note: str(o.note, 200),
    features: arr(o.features), wedge: str(o.wedge, 300), competitors: arr(o.competitors),
  };
}

async function research(existingNames: string[], count: number): Promise<B2BCompany[]> {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
  const model = process.env.B2B_SOURCE_MODEL ?? 'claude-opus-4-8';
  const webSearch = process.env.B2B_SOURCE_WEB !== '0'; // on by default
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic();

  const prompt = `You are a venture-studio analyst finding fast-growing B2B software companies for a "what should we build" tracker.

Find ${count} B2B software companies (sold to businesses, usually NOT on app stores — web/Slack/API/IDE) that are growing FAST right now: recently funded (Series A-C in the last ~12 months) and/or rapid ARR/customer growth. Prefer AI-era companies. ${webSearch ? 'Use web search to find genuinely recent, real companies and their latest funding/traction.' : 'Use your knowledge of real companies (do not invent any).'}

Do NOT include any of these already-tracked companies:
${existingNames.join(', ')}

For EACH company return an object with EXACTLY these fields:
- name (string)
- category (short, e.g. "AI support agents")
- channel (how it's delivered: "Web app" | "Slack" | "API" | "Desktop IDE" | etc.)
- arr (short traction descriptor, approx, e.g. "~$20M ARR" or "Series B, fast")
- customers (who buys, short)
- signal (integer 0-100 traction heat, higher = hotter)
- build (one of: "weekend","few_days","week","weeks","complex" = time for a small team to ship a credible MVP of the CORE WEDGE, not a full clone)
- features (array of 3-4 short product capabilities)
- wedge (ONE sentence: the week-1 MVP build plan, or why it's not a week play)
- competitors (array of 3-4 competitor names)
- url (homepage)
- note (one short line: why it's notable)

Only real companies. Return ONLY a JSON array of these objects, no prose.`;

  const base: Record<string, unknown> = { model, max_tokens: 8000 };
  if (webSearch) base.tools = [{ type: 'web_search_20260209', name: 'web_search', max_uses: 6 }];
  let messages: { role: 'user' | 'assistant'; content: unknown }[] = [{ role: 'user', content: prompt }];
  let response = await client.messages.create({ ...base, messages } as never);
  let guard = 0;
  while ((response as { stop_reason?: string }).stop_reason === 'pause_turn' && guard++ < 8) {
    messages = [...messages, { role: 'assistant', content: (response as { content: unknown }).content }];
    response = await client.messages.create({ ...base, messages } as never);
  }
  const blocks = (response as { content: { type: string; text?: string }[] }).content ?? [];
  const text = blocks.filter((b) => b.type === 'text' && b.text).map((b) => b.text).join('');
  const raw = extractJson<Record<string, unknown>[]>(text);
  return (Array.isArray(raw) ? raw : []).map(clean).filter((c): c is B2BCompany => c !== null);
}

function writeSourced(companies: SourcedCompany[]) {
  const header = `/** Auto-sourced B2B companies — REGENERATED by src/jobs/source-b2b.ts (Claude
 *  web-search research). Do not hand-edit; the curated base lives in b2b-data.ts.
 *  Each entry additionally carries \`sourced_at\` (ISO date) and \`source: 'auto'\`.
 *  Starts empty; the sourcing job appends fresh finds (deduped against the base). */
import type { B2BCompany } from './b2b-data.ts';

export type SourcedCompany = B2BCompany & { sourced_at?: string; source?: 'auto' };

export const SOURCED: SourcedCompany[] = `;
  const out = path.join(process.cwd(), 'src', 'playapi', 'b2b-sourced.ts');
  writeFileSync(out, header + JSON.stringify(companies, null, 2) + ';\n');
  return out;
}

async function main() {
  const count = Number(process.env.B2B_SOURCE_COUNT ?? 12);
  const existing = new Set([...B2B_COMPANIES, ...SOURCED].map((c) => norm(c.name)));
  const existingNames = [...B2B_COMPANIES, ...SOURCED].map((c) => c.name);
  log.info('source-b2b: researching', { asking: count, alreadyTracked: existingNames.length });

  const found = await research(existingNames, count);
  const fresh = found.filter((c) => !existing.has(norm(c.name)));
  const stamp = new Date().toISOString().slice(0, 10);
  const additions: SourcedCompany[] = fresh.map((c) => ({ ...c, sourced_at: stamp, source: 'auto' }));

  const merged = [...SOURCED, ...additions];
  const out = writeSourced(merged);
  log.info('source-b2b: done', { returned: found.length, netNew: additions.length, totalSourced: merged.length, wrote: out });
  for (const c of additions) log.info('  + ' + c.name, { category: c.category, build: c.build, signal: c.signal });
}

main().catch((err) => { log.error('source-b2b failed', { err: String(err) }); process.exit(1); });
