/** POST /api/submit {appName, category, market, pitch, details} → store a play idea.
 *  `details` is free-form jsonb so Defne can change the form without a migration. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getServiceClient, readSession, readJsonBody, json, str, checkRateLimit } from './_lib.ts';

export default async function handler(req: IncomingMessage & { method?: string }, res: ServerResponse) {
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
  const sess = readSession(req);
  if (!sess) return json(res, 401, { error: 'login required' });
  if (!checkRateLimit(`${sess.name}:submit`, 20)) return json(res, 429, { error: 'too many submissions, slow down' });

  const b = await readJsonBody<{ appName?: string; category?: string; market?: string; pitch?: string; details?: unknown }>(req);
  const appName = str(b.appName, 200).trim();
  if (!appName) return json(res, 400, { error: 'app name required' });
  if (b.details !== undefined && JSON.stringify(b.details).length > 8000) return json(res, 400, { error: 'details field too large (max 8000 chars)' });

  const sb = getServiceClient();
  const { data, error } = await sb.from('play_submissions').insert({
    manager_name: sess.name,
    app_name: appName,
    category: b.category ? str(b.category, 100) : null,
    market: b.market ? str(b.market, 100) : null,
    pitch: b.pitch ? str(b.pitch, 4000) : null,
    details: b.details && typeof b.details === 'object' ? b.details : {},
    status: 'submitted',
  }).select('id');
  if (error) { console.error('submit failed:', error.message); return json(res, 500, { error: 'submission failed' }); }
  return json(res, 200, { id: data?.[0]?.id });
}
