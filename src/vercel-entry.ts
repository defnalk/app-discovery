/**
 * Source for the Vercel serverless function. This is bundled by esbuild into a
 * single self-contained file at api/index.js (npm run vercel-build) because the
 * codebase imports modules with explicit `.ts` extensions — which only Node's
 * native TypeScript execution resolves, not Vercel's runtime. Bundling inlines
 * every local module (+ @supabase) so there are no unresolved imports at runtime.
 *
 * Serves the same server-rendered routes as the local leads app behind HTTP
 * Basic Auth. The dashboard carries third-party lead PII and must never be
 * world-readable, so auth FAILS CLOSED: missing credentials env -> 401, never
 * an open dashboard. Data is read from Supabase at runtime; the local JSON
 * store under data/ is excluded from the deployment (see .vercelignore).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { registerRoutes } from './leads/routes.ts';

type Handler = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void> | void;

// Build the route table once per warm function instance.
const routes = new Map<string, Handler>();
routes.set('GET /', (_req, res) => {
  res.writeHead(302, { location: '/leads' });
  res.end();
});
registerRoutes(routes);

function unauthorized(res: ServerResponse) {
  res.writeHead(401, {
    'WWW-Authenticate': 'Basic realm="8x Leads", charset="UTF-8"',
    'content-type': 'text/plain; charset=utf-8',
  });
  res.end('Authentication required.');
}

function passwordOk(req: IncomingMessage): boolean {
  const user = process.env.BASIC_AUTH_USER;
  const pass = process.env.BASIC_AUTH_PASS;
  if (!user || !pass) return false; // fail closed: never serve the dashboard unprotected
  const header = req.headers.authorization ?? '';
  const [scheme, encoded] = header.split(' ');
  if (scheme !== 'Basic' || !encoded) return false;
  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  const sep = decoded.indexOf(':');
  if (sep < 0) return false;
  return decoded.slice(0, sep) === user && decoded.slice(sep + 1) === pass;
}

export default async function handler(req: IncomingMessage & { method?: string }, res: ServerResponse) {
  const host = (req.headers.host as string) || 'localhost';
  const url = new URL(req.url ?? '/', `https://${host}`);

  // Token-gated API endpoints: gated by a shared token, NOT the dashboard Basic Auth
  // (an automated tool / external site can't do an interactive login). Fail closed.
  //   POST /leads/clay     — Clay sends enriched contacts IN   (CLAY_WEBHOOK_TOKEN)
  //   GET  /leads/targets  — Clay imports the target list OUT  (CLAY_WEBHOOK_TOKEN)
  //   GET  /leads/export   — external sites (Bulut) pull the lead book (LEADS_READ_TOKEN, or CLAY_WEBHOOK_TOKEN as fallback)
  if (url.pathname === '/leads/clay' || url.pathname === '/leads/targets' || url.pathname === '/leads/export') {
    // CORS preflight for cross-origin browser fetches of the read feed.
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type, x-clay-token, authorization',
        'access-control-max-age': '86400',
      });
      res.end();
      return;
    }
    const writeTok = process.env.CLAY_WEBHOOK_TOKEN;
    const readTok = process.env.LEADS_READ_TOKEN;
    const sent =
      (req.headers['x-clay-token'] as string) ||
      ((req.headers['authorization'] as string) || '').replace(/^Bearer\s+/i, '') ||
      url.searchParams.get('token') ||
      '';
    // The read-only export accepts a dedicated read token OR the Clay token; the
    // write/targets endpoints require the Clay token specifically.
    const ok = url.pathname === '/leads/export'
      ? Boolean((readTok && sent === readTok) || (writeTok && sent === writeTok))
      : Boolean(writeTok && sent === writeTok);
    if (!ok) {
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
      res.end('{"error":"unauthorized"}');
      return;
    }
    const route = routes.get(`${req.method} ${url.pathname}`);
    if (route) { await route(req, res, url); return; }
    // Valid token but no handler for this method on a token-gated path — return a
    // clean 405 and NEVER fall through to the dashboard Basic Auth below.
    const allow = url.pathname === '/leads/clay' ? 'POST, OPTIONS' : 'GET, OPTIONS';
    res.writeHead(405, { 'content-type': 'application/json; charset=utf-8', allow });
    res.end('{"error":"method_not_allowed"}');
    return;
  }

  if (!passwordOk(req)) return unauthorized(res);
  const route = routes.get(`${req.method} ${url.pathname}`);
  if (!route) {
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<p>404 — not found</p>');
    return;
  }
  try {
    await route(req, res, url);
  } catch {
    res.writeHead(500, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<p>Internal error</p>');
  }
}
