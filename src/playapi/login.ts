/** POST /api/login {name} → upsert manager, derive role, set HMAC-signed HttpOnly
 *  cookie. Name-only sign-in (no passcode); identity is still required so claims have
 *  an owner. Fails closed if the session secret is unset. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getServiceClient, signToken, newSession, setSessionCookie, isAdminName, readJsonBody, json, str, type Role } from './_lib.ts';

export default async function handler(req: IncomingMessage & { method?: string }, res: ServerResponse) {
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
  if (!process.env.PLAY_SESSION_SECRET) return json(res, 500, { error: 'server not configured' });

  const body = await readJsonBody<{ name?: string }>(req);
  const name = str(body.name, 60).trim();
  if (!name) return json(res, 400, { error: 'name required' });

  const sb = getServiceClient();
  const { data: existing } = await sb.from('play_managers').select('name, role').eq('name', name).maybeSingle();
  let role: Role = isAdminName(name) ? 'admin' : 'manager';
  if (existing?.role === 'admin') role = 'admin';
  if (!existing) {
    await sb.from('play_managers').insert({ name, role });
  } else if (role === 'admin' && existing.role !== 'admin') {
    await sb.from('play_managers').update({ role: 'admin' }).eq('name', name);
  }

  setSessionCookie(res, signToken(newSession(name, role)));
  return json(res, 200, { name, role });
}
