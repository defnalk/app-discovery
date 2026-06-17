/** POST /api/claim {subjectType, subjectId, subjectName, category} → atomic, race-safe
 *  reserve via the claim_play RPC. Identity comes from the signed cookie, NOT the body. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getServiceClient, readSession, readJsonBody, json, str, subjType } from './_lib.ts';

export default async function handler(req: IncomingMessage & { method?: string }, res: ServerResponse) {
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
  const sess = readSession(req);
  if (!sess) return json(res, 401, { error: 'login required' });

  const b = await readJsonBody<{ subjectType?: string; subjectId?: string; subjectName?: string; category?: string }>(req);
  const subjectId = str(b.subjectId, 200);
  if (!subjectId) return json(res, 400, { error: 'subjectId required' });

  const sb = getServiceClient();
  const { data, error } = await sb.rpc('claim_play', {
    p_subject_type: subjType(b.subjectType),
    p_subject_id: subjectId,
    p_subject_name: str(b.subjectName, 300) || null,
    p_category: b.category ? str(b.category, 100) : null,
    p_manager: sess.name,
  });
  if (error) return json(res, 500, { error: error.message });
  return json(res, 200, data); // { won, claim } | { won:false, claimed_by, claim }
}
