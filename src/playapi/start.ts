/** POST /api/start {subjectType, subjectId} → mark a reservation as started (only the
 *  owner, only while still 'reserved'). Stops the 24h start-or-lose timer. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getServiceClient, readSession, readJsonBody, json, str, subjType } from './_lib.ts';

export default async function handler(req: IncomingMessage & { method?: string }, res: ServerResponse) {
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
  const sess = readSession(req);
  if (!sess) return json(res, 401, { error: 'login required' });

  const b = await readJsonBody<{ subjectType?: string; subjectId?: string }>(req);
  const subjectId = str(b.subjectId, 200);
  if (!subjectId) return json(res, 400, { error: 'subjectId required' });

  const sb = getServiceClient();
  const { data, error } = await sb.from('play_claims')
    .update({ status: 'started', started_at: new Date().toISOString() })
    .eq('subject_type', subjType(b.subjectType)).eq('subject_id', subjectId)
    .eq('manager_name', sess.name).eq('status', 'reserved')
    .select();
  if (error) return json(res, 500, { error: error.message });
  if (!data || !data.length) return json(res, 409, { error: 'not your reservation, or not in reserved state' });
  return json(res, 200, { started: data[0] });
}
