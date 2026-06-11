/**
 * Minimal dashboard server. Serves the static apps page and (later) the leads
 * pages. If DASHBOARD_TOKEN is set, the first request must carry ?token=…;
 * a cookie keeps the session. No other auth complexity in v1.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { log } from './lib/log.ts';
import { pageShell } from './lib/html.ts';

const PORT = Number(process.env.PORT ?? 8787);
const TOKEN = process.env.DASHBOARD_TOKEN || null;

type Handler = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void> | void;
export const routes = new Map<string, Handler>();

function send(res: ServerResponse, status: number, body: string, type = 'text/html; charset=utf-8') {
  res.writeHead(status, { 'content-type': type });
  res.end(body);
}

function authorized(req: IncomingMessage, url: URL, res: ServerResponse): boolean {
  if (!TOKEN) return true;
  const cookie = req.headers.cookie ?? '';
  if (cookie.includes(`dash_token=${TOKEN}`)) return true;
  if (url.searchParams.get('token') === TOKEN) {
    res.setHeader('set-cookie', `dash_token=${TOKEN}; HttpOnly; Path=/; Max-Age=2592000`);
    return true;
  }
  send(res, 401, pageShell({ title: 'Unauthorized', active: '', body: '<div class="panel">Add ?token=… to the URL.</div>' }));
  return false;
}

routes.set('GET /', (_req, res) => {
  const file = path.join(process.cwd(), 'public', 'index.html');
  if (!existsSync(file)) {
    return send(res, 200, pageShell({ title: 'App discovery', active: 'apps', body: '<div class="panel">No dashboard built yet — run <code>npm run dashboard</code>.</div>' }));
  }
  send(res, 200, readFileSync(file, 'utf8'));
});

async function main() {
  // Leads routes register themselves when the module is present.
  try {
    const leads = await import('./leads/routes.ts');
    leads.registerRoutes(routes);
  } catch {
    log.warn('leads routes not available yet');
  }

  createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
    if (!authorized(req, url, res)) return;
    const handler = routes.get(`${req.method} ${url.pathname}`);
    if (!handler) return send(res, 404, pageShell({ title: 'Not found', active: '', body: '<div class="panel">404</div>' }));
    try {
      await handler(req, res, url);
    } catch (err) {
      log.error(`route ${req.method} ${url.pathname} failed`, { err: String(err) });
      send(res, 500, pageShell({ title: 'Error', active: '', body: `<div class="panel">Internal error</div>` }));
    }
  }).listen(PORT, () => log.info(`dashboard serving on http://localhost:${PORT}${TOKEN ? ' (token required)' : ''}`));
}

main();
