/** POST /api/submit {appName, category, market, pitch, details} → store a play idea
 *  and (best-effort) ping a Slack channel so the team sees it immediately.
 *  `details` is free-form jsonb so the form can change without a migration.
 *  Slack notify is gated on PLAY_SLACK_WEBHOOK and never blocks/fails the submit. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getServiceClient, readSession, readJsonBody, json, str, checkRateLimit } from './_lib.ts';

/** Post the submission to Slack via an Incoming Webhook. No-op if unset; swallows errors. */
async function notifySlack(s: { by: string; appName: string; category: string | null; market: string | null; pitch: string | null; why: string | null }) {
  const url = process.env.PLAY_SLACK_WEBHOOK;
  if (!url) return;
  const meta = [s.category, s.market].filter(Boolean).join(' · ');
  const lines = [
    `:dart: *New play submitted* by ${s.by}`,
    `*${s.appName}*${meta ? `  _(${meta})_` : ''}`,
    s.pitch ? `> ${s.pitch}` : '',
    s.why ? `*Why:* ${s.why}` : '',
  ].filter(Boolean);
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: lines.join('\n') }),
      signal: ctrl.signal,
    }).finally(() => clearTimeout(timer));
  } catch (err) {
    console.error('submit: slack notify failed (non-fatal):', String(err));
  }
}

export default async function handler(req: IncomingMessage & { method?: string }, res: ServerResponse) {
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
  const sess = readSession(req);
  if (!sess) return json(res, 401, { error: 'login required' });
  if (!checkRateLimit(`${sess.name}:submit`, 20)) return json(res, 429, { error: 'too many submissions, slow down' });

  const b = await readJsonBody<{ appName?: string; category?: string; market?: string; pitch?: string; details?: unknown }>(req);
  const appName = str(b.appName, 200).trim();
  if (!appName) return json(res, 400, { error: 'app name required' });
  if (b.details !== undefined && JSON.stringify(b.details).length > 8000) return json(res, 400, { error: 'details field too large (max 8000 chars)' });

  const category = b.category ? str(b.category, 100) : null;
  const market = b.market ? str(b.market, 100) : null;
  const pitch = b.pitch ? str(b.pitch, 4000) : null;
  const details = b.details && typeof b.details === 'object' ? (b.details as Record<string, unknown>) : {};

  const sb = getServiceClient();
  const { data, error } = await sb.from('play_submissions').insert({
    manager_name: sess.name,
    app_name: appName,
    category,
    market,
    pitch,
    details,
    status: 'submitted',
  }).select('id');
  if (error) { console.error('submit failed:', error.message); return json(res, 500, { error: 'submission failed' }); }

  await notifySlack({ by: sess.name, appName, category, market, pitch, why: typeof details.why === 'string' ? str(details.why, 1000) : null });
  return json(res, 200, { id: data?.[0]?.id });
}
