/**
 * Two separate dashboard apps from one repo:
 *   apps discovery  -> http://localhost:8787  (static rebuild of public/index.html)
 *   leads           -> http://localhost:8788  (server-rendered, approval/settings gates)
 * APP_MODE=apps|leads serves just one; default starts both. If DASHBOARD_TOKEN
 * is set, the first request to either must carry ?token=…; a cookie keeps it.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { log } from './lib/log.ts';
import { pageShell } from './lib/html.ts';

const APPS_PORT = Number(process.env.APPS_PORT ?? 8787);
const LEADS_PORT = Number(process.env.LEADS_PORT ?? 8788);
const MODE = process.env.APP_MODE ?? 'both'; // apps | leads | both
const TOKEN = process.env.DASHBOARD_TOKEN || null;

type Handler = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void> | void;

function send(res: ServerResponse, status: number, body: string, type = 'text/html; charset=utf-8') {
  res.writeHead(status, { 'content-type': type });
  res.end(body);
}

function authorized(req: IncomingMessage, url: URL, res: ServerResponse, app: 'apps' | 'leads'): boolean {
  if (!TOKEN) return true;
  const cookie = req.headers.cookie ?? '';
  if (cookie.includes(`dash_token=${TOKEN}`)) return true;
  if (url.searchParams.get('token') === TOKEN) {
    res.setHeader('set-cookie', `dash_token=${TOKEN}; HttpOnly; Path=/; Max-Age=2592000`);
    return true;
  }
  send(res, 401, pageShell({ title: 'Unauthorized', active: '', app, body: '<div class="panel">Add ?token=… to the URL.</div>' }));
  return false;
}

function makeServer(app: 'apps' | 'leads', routes: Map<string, Handler>, port: number) {
  createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);
    if (!authorized(req, url, res, app)) return;
    const handler = routes.get(`${req.method} ${url.pathname}`);
    if (!handler) return send(res, 404, pageShell({ title: 'Not found', active: '', app, body: '<div class="panel">404</div>' }));
    try {
      await handler(req, res, url);
    } catch (err) {
      log.error(`[${app}] ${req.method} ${url.pathname} failed`, { err: String(err) });
      send(res, 500, pageShell({ title: 'Error', active: '', app, body: '<div class="panel">Internal error</div>' }));
    }
  }).listen(port, () => log.info(`${app} app serving on http://localhost:${port}${TOKEN ? ' (token required)' : ''}`));
}

async function main() {
  if (MODE === 'apps' || MODE === 'both') {
    const appsRoutes = new Map<string, Handler>();
    appsRoutes.set('GET /', (_req, res) => {
      const file = path.join(process.cwd(), 'public', 'index.html');
      if (!existsSync(file)) {
        return send(res, 200, pageShell({ title: 'App discovery', active: 'apps', app: 'apps', body: '<div class="panel">No dashboard built yet — run <code>npm run dashboard</code>.</div>' }));
      }
      send(res, 200, readFileSync(file, 'utf8'));
    });
    makeServer('apps', appsRoutes, APPS_PORT);
  }

  if (MODE === 'leads' || MODE === 'both') {
    const leadsRoutes = new Map<string, Handler>();
    leadsRoutes.set('GET /', (_req, res) => {
      res.writeHead(302, { location: '/leads' });
      res.end();
    });
    const leads = await import('./leads/routes.ts');
    leads.registerRoutes(leadsRoutes);
    makeServer('leads', leadsRoutes, LEADS_PORT);
  }
}

main();
