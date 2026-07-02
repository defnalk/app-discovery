/** POST /api/advance {subjectType, subjectId, status} → move a claim through the build
 *  pipeline: reserved (Claimed) → started (Building) → shipped → growing. The claim
 *  owner may move their own; an admin may move anyone's (for Neil's oversight). status
 *  is a free-text column on play_claims, so new stages need no migration. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getServiceClient, readSession, readJsonBody, json, str, subjType, checkRateLimit } from './_lib.ts';

const STAGES = ['reserved', 'started', 'shipped', 'growing'];

export default async function handler(req: IncomingMessage & { method?: string }, res: ServerResponse) {
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
  const sess = readSession(req);
  if (!sess) return json(res, 401, { error: 'login required' });
  if (!checkRateLimit(`${sess.name}:advance`, 60)) return json(res, 429, { error: 'too many updates, slow down' });

  const b = await readJsonBody<{ subjectType?: string; subjectId?: string; status?: string }>(req);
  const subjectId = str(b.subjectId, 200);
  const status = str(b.status, 20);
  if (!subjectId || !STAGES.includes(status)) return json(res, 400, { error: 'subjectId and a valid status required' });

  const sb = getServiceClient();
  const patch: Record<string, string> = { status };
  if (status === 'started') patch.started_at = new Date().toISOString();
  let q = sb.from('play_claims').update(patch).eq('subject_type', subjType(b.subjectType)).eq('subject_id', subjectId);
  if (sess.role !== 'admin') q = q.eq('manager_name', sess.name); // owners move their own; admins move anyone's
  const { data, error } = await q.select();
  if (error) { console.error('advance failed:', error.message); return json(res, 500, { error: 'advance failed' }); }
  if (!data || !data.length) return json(res, 409, { error: 'not your claim, or claim not found' });
  return json(res, 200, { claim: data[0] });
}
