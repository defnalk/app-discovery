/** GET /api/plays-state → the live claim overlay the SPA merges into the embedded
 *  ROWS to compute availability + "claimed by X". Requires a valid session; returns
 *  manager NAMES only (no email / PII). */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getServiceClient, readSession, json } from './_lib.ts';

export default async function handler(req: IncomingMessage & { method?: string }, res: ServerResponse) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method not allowed' });
  const sess = readSession(req);
  if (!sess) return json(res, 401, { error: 'login required' });
  const sb = getServiceClient();
  const { data, error } = await sb.from('play_claims')
    .select('subject_type, subject_id, manager_name, status, start_by, started_at');
  if (error) { console.error('plays-state failed:', error.message); return json(res, 500, { error: 'failed to load state' }); }
  return json(res, 200, { claims: data ?? [], me: { name: sess.name, role: sess.role } });
}
