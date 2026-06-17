/** POST /api/login {name, passcode} → verify passcode server-side, upsert manager,
 *  derive role, set HMAC-signed HttpOnly cookie. Fails closed if secrets unset. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getServiceClient, signToken, newSession, constantTimeEqual, setSessionCookie, isAdminName, readJsonBody, json, str, type Role } from './_lib.ts';

export default async function handler(req: IncomingMessage & { method?: string }, res: ServerResponse) {
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
  const passcode = process.env.PLAY_TEAM_PASSCODE;
  if (!passcode || !process.env.PLAY_SESSION_SECRET) return json(res, 500, { error: 'server not configured' });

  const body = await readJsonBody<{ name?: string; passcode?: string }>(req);
  const name = str(body.name, 60).trim();
  if (!name) return json(res, 400, { error: 'name required' });
  if (!constantTimeEqual(str(body.passcode, 200), passcode)) return json(res, 401, { error: 'wrong passcode' });

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
