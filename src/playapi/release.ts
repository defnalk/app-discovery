/** POST /api/release {subjectType, subjectId} → free a play so it can be re-claimed.
 *  DELETEs the claim row (the UNIQUE constraint means a lingering row would block a new
 *  claim, so release must remove it). Owner can release their own; admins can release any. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getServiceClient, readSession, readJsonBody, json, str, subjType, checkRateLimit } from './_lib.ts';

export default async function handler(req: IncomingMessage & { method?: string }, res: ServerResponse) {
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
  const sess = readSession(req);
  if (!sess) return json(res, 401, { error: 'login required' });
  if (!checkRateLimit(`${sess.name}:release`, 40)) return json(res, 429, { error: 'too many requests, slow down' });

  const b = await readJsonBody<{ subjectType?: string; subjectId?: string }>(req);
  const subjectId = str(b.subjectId, 200);
  if (!subjectId) return json(res, 400, { error: 'subjectId required' });

  const sb = getServiceClient();
  // Only a 'reserved' claim is releasable — never yank a 'started' (in-progress) claim
  // out from under the manager working it (would orphan their work + let someone re-claim).
  let q = sb.from('play_claims').delete()
    .eq('subject_type', subjType(b.subjectType)).eq('subject_id', subjectId)
    .eq('status', 'reserved');
  if (sess.role !== 'admin') q = q.eq('manager_name', sess.name); // non-admins only release their own
  const { data, error } = await q.select();
  if (error) { console.error('release failed:', error.message); return json(res, 500, { error: 'release failed' }); }
  if (!data || !data.length) return json(res, 409, { error: 'nothing to release (or already started / not yours)' });
  return json(res, 200, { released: true });
}
