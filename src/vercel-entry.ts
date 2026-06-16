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
  if (!passwordOk(req)) return unauthorized(res);
  const host = (req.headers.host as string) || 'localhost';
  const url = new URL(req.url ?? '/', `https://${host}`);
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
