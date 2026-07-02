/** POST /api/start {subjectType, subjectId, status?} → claim status transitions.
 *  Default (no status): mark a reservation started (owner, while 'reserved', within the
 *  24h window). With an explicit pipeline `status` (reserved|started|shipped|growing):
 *  move the claim to that stage, owner or admin, no time window. Merged here to stay
 *  under the Hobby-plan 12-function cap. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getServiceClient, readSession, readJsonBody, json, str, subjType, checkRateLimit } from './_lib.ts';

const STAGES = ['reserved', 'started', 'shipped', 'growing'];

export default async function handler(req: IncomingMessage & { method?: string }, res: ServerResponse) {
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
  const sess = readSession(req);
  if (!sess) return json(res, 401, { error: 'login required' });
  if (!checkRateLimit(`${sess.name}:start`, 60)) return json(res, 429, { error: 'too many requests, slow down' });

  const b = await readJsonBody<{ subjectType?: string; subjectId?: string; status?: string }>(req);
  const subjectId = str(b.subjectId, 200);
  if (!subjectId) return json(res, 400, { error: 'subjectId required' });
  const subjectType = subjType(b.subjectType);
  const status = str(b.status, 20);
  const sb = getServiceClient();

  // Explicit pipeline move (Claimed → Building → Shipped → Growing): owner moves their
  // own, admins move anyone's. No 24h constraint.
  if (status && STAGES.includes(status)) {
    let q = sb.from('play_claims').update({ status, ...(status === 'started' ? { started_at: new Date().toISOString() } : {}) })
      .eq('subject_type', subjectType).eq('subject_id', subjectId);
    if (sess.role !== 'admin') q = q.eq('manager_name', sess.name);
    const { data, error } = await q.select();
    if (error) { console.error('pipeline move failed:', error.message); return json(res, 500, { error: 'update failed' }); }
    if (!data || !data.length) return json(res, 409, { error: 'not your claim, or claim not found' });
    return json(res, 200, { claim: data[0] });
  }

  // Default: reserved → started within the 24h window (the "start" button).
  const { data, error } = await sb.from('play_claims')
    .update({ status: 'started', started_at: new Date().toISOString() })
    .eq('subject_type', subjType(b.subjectType)).eq('subject_id', subjectId)
    .eq('manager_name', sess.name).eq('status', 'reserved')
    .gte('start_by', new Date().toISOString()) // server-enforced 24h window (valid while start_by is still future)
    .select();
  if (error) { console.error('start failed:', error.message); return json(res, 500, { error: 'start failed' }); }
  if (!data || !data.length) return json(res, 409, { error: 'not your reservation, already started, or 24h window elapsed' });
  return json(res, 200, { started: data[0] });
}
