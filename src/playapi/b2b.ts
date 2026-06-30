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
import { readSession, isAdminName, json } from './_lib.ts';
import { B2B_COMPANIES } from './b2b-data.ts';

export default async function handler(req: IncomingMessage & { method?: string }, res: ServerResponse) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method not allowed' });
  const sess = readSession(req);
  if (!sess || sess.role !== 'admin' || !isAdminName(sess.name)) return json(res, 403, { error: 'admins only' });
  const companies = [...B2B_COMPANIES].sort((a, b) => b.signal - a.signal);
  return json(res, 200, { companies, count: companies.length, source: 'curated' });
}
