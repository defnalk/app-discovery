/**
 * Play Database serverless function for the Competitive Analysis tool, bundled by
 * esbuild into public/api/compete.mjs and served by the `defne-ertugrul-apps`
 * Vercel project. One function handles both the page and the SSE run:
 *   GET /api/compete            → the form + results page (pretty URL: /compete)
 *   GET /api/compete?run=1&…    → SSE stream (progress steps + structured result)
 *
 * The run endpoint is open (no login) by request. Since it calls the paid
 * Anthropic API, a best-effort per-IP rate limit bounds runaway cost/abuse
 * without adding any login friction.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { competePage, competeRun } from './routes.ts';
import { checkRateLimit } from '../playapi/_lib.ts';

const RUNS_PER_HOUR = Number(process.env.COMPETE_RUNS_PER_HOUR ?? 30);

export default async function handler(req: IncomingMessage & { method?: string }, res: ServerResponse) {
  const host = (req.headers.host as string) || 'localhost';
  const url = new URL(req.url ?? '/', `https://${host}`);
  const isRun = url.searchParams.get('run') === '1' || url.pathname.endsWith('/run');

  if (!isRun) {
    // The page's EventSource calls back into this same function with ?run=1.
    return competePage(req, res, url, { app: 'apps', runBase: '/api/compete?run=1' });
  }

  // Open (no login). Best-effort per-IP throttle so the paid Claude call can't
  // be hammered. In-memory, so it resets per warm instance — a soft guard, not
  // a hard quota.
  const ip = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || 'anon';
  if (!checkRateLimit('compete:' + ip, RUNS_PER_HOUR)) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
    });
    res.write(`event: error\ndata: ${JSON.stringify({ message: 'Too many analyses from your network in the last hour — give it a few minutes.' })}\n\n`);
    res.write('event: done\ndata: {}\n\n');
    res.end();
    return;
  }
  return competeRun(req, res, url);
}
