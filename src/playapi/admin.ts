/** GET /api/admin → admin-only view: every manager's claims + submitted forms +
 *  profiles. Double-gated: signed-token role must be admin AND name in PLAY_ADMINS. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getServiceClient, readSession, json } from './_lib.ts';

export default async function handler(req: IncomingMessage & { method?: string }, res: ServerResponse) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method not allowed' });
  const sess = readSession(req);
  // Gate on the signed admin role (set at login from PLAY_ADMINS or the DB record),
  // matching when the Admin tab is shown. Was double-gated on PLAY_ADMINS too, which
  // is empty, so real admins (Defne, Nil) got 403 even though their role is admin.
  if (!sess) return json(res, 401, { error: 'login required' });
  if (sess.role !== 'admin') return json(res, 403, { error: 'admins only' });
  const sb = getServiceClient();
  const [claims, subs, mgrs] = await Promise.all([
    sb.from('play_claims').select('subject_type, subject_id, subject_name, category, manager_name, status, claimed_at, start_by, started_at').order('claimed_at', { ascending: false }),
    sb.from('play_submissions').select('id, manager_name, app_name, category, market, pitch, details, status, submitted_at').order('submitted_at', { ascending: false }),
    sb.from('play_managers').select('name, role, created_at').order('created_at', { ascending: true }),
  ]);
  return json(res, 200, { claims: claims.data ?? [], submissions: subs.data ?? [], managers: mgrs.data ?? [] });
}
