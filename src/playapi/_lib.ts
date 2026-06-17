/**
 * Shared helpers for the Play Database serverless functions (bundled by esbuild
 * into public/api/*.mjs). Lives under src/ so imports resolve repo-root node_modules
 * at bundle time. NEVER imported by the client or build-dashboard — it touches the
 * service_role key and the session secret, which must stay server-side.
 *
 * Auth model (lightweight, agreed for the rough draft): name + a shared team
 * passcode, verified server-side; identity is then carried in an HMAC-signed,
 * HttpOnly cookie. Everything fails CLOSED when secrets are missing.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createHmac, timingSafeEqual } from 'node:crypto';

export type Role = 'manager' | 'admin';
export type Session = { name: string; role: Role; exp: number };

export const COOKIE = 'play_session';
const SESSION_MS = 16 * 60 * 60 * 1000; // 16h

/** Service-role Supabase client (bypasses RLS). Throws (fail closed) if env missing. */
export function getServiceClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing');
  return createClient(url, key, { auth: { persistSession: false } });
}

const b64url = (buf: Buffer) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

export function signToken(payload: Session): string {
  const secret = process.env.PLAY_SESSION_SECRET;
  if (!secret) throw new Error('PLAY_SESSION_SECRET missing');
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  const sig = b64url(createHmac('sha256', secret).update(body).digest());
  return `${body}.${sig}`;
}

export function verifyToken(token: string | undefined | null): Session | null {
  if (!token) return null;
  const secret = process.env.PLAY_SESSION_SECRET;
  if (!secret) return null; // fail closed
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = b64url(createHmac('sha256', secret).update(body).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(fromB64url(body).toString('utf8')) as Session;
    if (!p || typeof p.name !== 'string' || (p.role !== 'manager' && p.role !== 'admin')) return null;
    if (typeof p.exp !== 'number' || p.exp < Date.now()) return null;
    return p;
  } catch {
    return null;
  }
}

export function constantTimeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function parseCookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function setSessionCookie(res: ServerResponse, token: string) {
  res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_MS / 1000)}`);
}

export function newSession(name: string, role: Role): Session {
  return { name, role, exp: Date.now() + SESSION_MS };
}

export function readSession(req: IncomingMessage): Session | null {
  return verifyToken(parseCookies(req)[COOKIE]);
}

export function isAdminName(name: string): boolean {
  const admins = (process.env.PLAY_ADMINS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return admins.includes(name.trim().toLowerCase());
}

export async function readJsonBody<T = Record<string, unknown>>(req: IncomingMessage): Promise<T> {
  const anyReq = req as unknown as { body?: unknown };
  if (anyReq.body !== undefined && anyReq.body !== null) {
    if (typeof anyReq.body === 'string') { try { return JSON.parse(anyReq.body) as T; } catch { return {} as T; } }
    if (typeof anyReq.body === 'object') return anyReq.body as T;
  }
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {} as T;
  try { return JSON.parse(raw) as T; } catch { return {} as T; }
}

export function json(res: ServerResponse, status: number, obj: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

export const str = (v: unknown, max: number): string => String(v ?? '').slice(0, max);
export const subjType = (v: unknown): 'app' | 'idea' => (v === 'idea' ? 'idea' : 'app');
