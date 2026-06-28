/** POST /api/login {email} → require an allowed 8x.social address, upsert manager
 *  keyed by email, set HMAC-signed HttpOnly cookie. Domain is env-configurable
 *  (PLAY_EMAIL_DOMAIN, default 8x.social); admins (PLAY_ADMINS, matched by full
 *  email or local-part) may sign in from any domain so the owner can't be locked
 *  out. NOTE: this is a domain gate, not verified email auth — there's no OTP, so
 *  anyone who knows an @8x.social address can sign in as it. Fails closed if the
 *  session secret is unset. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getServiceClient, signToken, newSession, setSessionCookie, isAdminName, readJsonBody, json, str, type Role } from './_lib.ts';

const ALLOWED_DOMAIN = (process.env.PLAY_EMAIL_DOMAIN ?? '8x.social').toLowerCase();
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export default async function handler(req: IncomingMessage & { method?: string }, res: ServerResponse) {
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
  if (!process.env.PLAY_SESSION_SECRET) return json(res, 500, { error: 'server not configured' });

  // Accept {email}; tolerate {name} for older clients during rollout.
  const body = await readJsonBody<{ email?: string; name?: string }>(req);
  const email = str(body.email ?? body.name, 120).trim().toLowerCase();
  if (!email || !EMAIL_RE.test(email)) return json(res, 400, { error: 'enter a valid email' });

  const domain = email.slice(email.lastIndexOf('@') + 1);
  const localPart = email.slice(0, email.indexOf('@'));
  const isAdmin = isAdminName(email) || isAdminName(localPart);
  if (domain !== ALLOWED_DOMAIN && !isAdmin) return json(res, 403, { error: `sign in with your @${ALLOWED_DOMAIN} email` });

  const sb = getServiceClient();
  const { data: existing } = await sb.from('play_managers').select('name, role').eq('name', email).maybeSingle();
  let role: Role = isAdmin ? 'admin' : 'manager';
  if (existing?.role === 'admin') role = 'admin';
  if (!existing) {
    await sb.from('play_managers').insert({ name: email, role });
  } else if (role === 'admin' && existing.role !== 'admin') {
    await sb.from('play_managers').update({ role: 'admin' }).eq('name', email);
  }

  setSessionCookie(res, signToken(newSession(email, role)));
  return json(res, 200, { name: email, role });
}
