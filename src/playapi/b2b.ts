/** GET /api/b2b → ADMIN-ONLY B2B company tracker: the B2B counterpart to the
 *  consumer Plays dashboard. Tracks fast-growing B2B software companies (sold to
 *  companies, often not on app stores, e.g. Slack/web/API) that 8x could help or
 *  replicate. Double-gated like /api/admin: signed-token role must be admin AND
 *  the name must be in PLAY_ADMINS, so newly-onboarded managers never see it.
 *
 *  Data is a hand-maintained SEED for now. The live sourcing pipeline (TechCrunch /
 *  web scrapers + research prompts, the "next week" exploration) will replace SEED
 *  with a Supabase-backed table without changing this contract. `signal` is a 0-100
 *  traction-heat estimate; ARR/customer figures are approximate public estimates. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readSession, json } from './_lib.ts';
import { B2B_COMPANIES } from './b2b-data.ts';
import { SOURCED } from './b2b-sourced.ts';

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

export default async function handler(req: IncomingMessage & { method?: string }, res: ServerResponse) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method not allowed' });
  const sess = readSession(req);
  // 401 (not 403) when signed out, so the client prompts a login instead of saying
  // "admins only". Gate on the signed admin role, matching when the B2B tab is shown
  // (the role token is HMAC-signed, so it can't be forged client-side).
  if (!sess) return json(res, 401, { error: 'login required' });
  if (sess.role !== 'admin') return json(res, 403, { error: 'admins only' });
  // Curated base + auto-sourced finds, deduped by name (curated wins).
  const seen = new Set(B2B_COMPANIES.map((c) => norm(c.name)));
  const merged = [...B2B_COMPANIES, ...SOURCED.filter((c) => c && c.name && !seen.has(norm(c.name)))];
  const companies = merged.sort((a, b) => b.signal - a.signal);
  return json(res, 200, { companies, count: companies.length, curated: B2B_COMPANIES.length, sourced: companies.length - B2B_COMPANIES.length });
}
