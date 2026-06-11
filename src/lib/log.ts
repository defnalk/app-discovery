import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const LOG_DIR = path.join(process.cwd(), 'logs');
mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = path.join(LOG_DIR, `${new Date().toISOString().slice(0, 10)}.jsonl`);

type Level = 'info' | 'warn' | 'error' | 'external';

function emit(level: Level, msg: string, extra?: Record<string, unknown>) {
  const entry = { ts: new Date().toISOString(), level, msg, ...extra };
  appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
  const line = `[${entry.ts}] ${level.toUpperCase()} ${msg}`;
  if (level === 'error') console.error(line);
  else console.log(line);
}

export const log = {
  info: (msg: string, extra?: Record<string, unknown>) => emit('info', msg, extra),
  warn: (msg: string, extra?: Record<string, unknown>) => emit('warn', msg, extra),
  error: (msg: string, extra?: Record<string, unknown>) => emit('error', msg, extra),
  /** Every external call goes through this: url, status, duration, attempt. */
  external: (service: string, url: string, extra?: Record<string, unknown>) =>
    emit('external', `${service} ${url}`, { service, url, ...extra }),
};
