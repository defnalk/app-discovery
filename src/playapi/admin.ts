/** GET /api/admin → admin-only view: every manager's claims + submitted forms +
 *  profiles. Double-gated: signed-token role must be admin AND name in PLAY_ADMINS. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getServiceClient, readSession, isAdminName, json } from './_lib.ts';

export default async function handler(req: IncomingMessage & { method?: string }, res: ServerResponse) {
  const sess = readSession(req);
  if (!sess || sess.role !== 'admin' || !isAdminName(sess.name)) return json(res, 403, { error: 'admins only' });
  const sb = getServiceClient();
  const [claims, subs, mgrs] = await Promise.all([
    sb.from('play_claims').select('subject_type, subject_id, subject_name, category, manager_name, status, claimed_at, start_by, started_at').order('claimed_at', { ascending: false }),
    sb.from('play_submissions').select('id, manager_name, app_name, category, market, pitch, details, status, submitted_at').order('submitted_at', { ascending: false }),
    sb.from('play_managers').select('name, role, created_at').order('created_at', { ascending: true }),
  ]);
  return json(res, 200, { claims: claims.data ?? [], submissions: subs.data ?? [], managers: mgrs.data ?? [] });
}
