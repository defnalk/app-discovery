import { log } from './log.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Simple per-service rate limiter: minimum gap between calls. */
const lastCall = new Map<string, number>();
async function throttle(service: string, minGapMs: number) {
  const prev = lastCall.get(service) ?? 0;
  const wait = prev + minGapMs - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall.set(service, Date.now());
}

export type FetchOpts = {
  service: string;
  minGapMs?: number; // rate limit between calls to this service
  retries?: number;
  init?: RequestInit;
};

/** Fetch JSON with throttling, retries with backoff, and external-call logging. */
export async function fetchJson<T = unknown>(url: string, opts: FetchOpts): Promise<T> {
  const { service, minGapMs = 250, retries = 3, init } = opts;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    await throttle(service, minGapMs);
    const started = Date.now();
    try {
      const res = await fetch(url, init);
      log.external(service, url, { status: res.status, ms: Date.now() - started, attempt });
      if (res.status === 429 || res.status >= 500) {
        throw new Error(`HTTP ${res.status}`);
      }
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} ${url}`), { fatal: true });
      return (await res.json()) as T;
    } catch (err) {
      lastErr = err;
      if ((err as { fatal?: boolean }).fatal || attempt > retries) break;
      const backoff = 1000 * 2 ** (attempt - 1);
      log.warn(`retrying ${service} in ${backoff}ms`, { url, attempt, err: String(err) });
      await sleep(backoff);
    }
  }
  throw lastErr;
}

export { sleep };
