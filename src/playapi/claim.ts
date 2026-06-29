/** POST /api/claim {subjectType, subjectId, subjectName, category} → atomic, race-safe
 *  reserve via the claim_play RPC. Identity comes from the signed cookie, NOT the body. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getServiceClient, readSession, readJsonBody, json, str, subjType, checkRateLimit } from './_lib.ts';

/** Best-effort Slack ping when a play is claimed. No-op if PLAY_SLACK_WEBHOOK unset. */
async function notifyClaimSlack(manager: string, appName: string): Promise<boolean> {
  const url = process.env.PLAY_SLACK_WEBHOOK;
  if (!url) return false;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: `:hammer_and_wrench: *${manager}* claimed *${appName || 'a play'}*` }),
      signal: ctrl.signal,
    }).finally(() => clearTimeout(timer));
    return true;
  } catch (err) { console.error('claim: slack notify failed (non-fatal):', String(err)); return false; }
}

export default async function handler(req: IncomingMessage & { method?: string }, res: ServerResponse) {
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
  const sess = readSession(req);
  if (!sess) return json(res, 401, { error: 'login required' });
  if (!checkRateLimit(`${sess.name}:claim`, 60)) return json(res, 429, { error: 'too many requests, slow down' });

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
  if (error) { console.error('claim_play RPC failed:', error.message); return json(res, 500, { error: 'claim failed' }); }
  const notified = (data && (data as { won?: boolean }).won) ? await notifyClaimSlack(sess.name, str(b.subjectName, 300)) : false;
  return json(res, 200, { ...(data as Record<string, unknown>), notified }); // { won, claim, notified } | { won:false, claimed_by, claim, notified:false }
}
