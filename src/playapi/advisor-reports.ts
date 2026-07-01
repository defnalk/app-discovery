/** GET/POST /api/advisor-reports — cross-device store for a manager's saved Advisor
 *  reports, backed by Supabase Storage (bucket "advisor-reports", one JSON blob per
 *  manager). Identity from the signed cookie; a manager only ever touches their own
 *  blob. Degrades gracefully (returns []) if the bucket/blob is missing, so the client
 *  falls back to its localStorage copy. No new DB table needed.
 *
 *    GET                              -> { reports: [...] }
 *    POST { appName, category, fields, report, grounded }  -> save, returns { reports }
 *    POST { action: 'delete', id }    -> delete, returns { reports }
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getServiceClient, readSession, readJsonBody, json, str } from './_lib.ts';

const BUCKET = 'advisor-reports';
const MAX = 40;
const blobFor = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 90) + '.json';

type Report = { id: string; appName: string; category: string; fields: unknown; report: unknown; grounded: unknown; savedAt: string };

async function readReports(sb: ReturnType<typeof getServiceClient>, name: string): Promise<Report[]> {
  try {
    const { data, error } = await sb.storage.from(BUCKET).download(blobFor(name));
    if (error || !data) return [];
    const parsed = JSON.parse(await data.text());
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

async function writeReports(sb: ReturnType<typeof getServiceClient>, name: string, reports: Report[]): Promise<boolean> {
  try {
    const { error } = await sb.storage.from(BUCKET).upload(blobFor(name), JSON.stringify(reports.slice(0, MAX)), {
      upsert: true, contentType: 'application/json',
    });
    return !error;
  } catch { return false; }
}

export default async function handler(req: IncomingMessage & { method?: string }, res: ServerResponse) {
  const sess = readSession(req);
  if (!sess) return json(res, 401, { error: 'login required' });
  const sb = getServiceClient();

  if (req.method === 'GET' || req.method === 'HEAD') {
    return json(res, 200, { reports: await readReports(sb, sess.name) });
  }
  if (req.method === 'POST') {
    const b = await readJsonBody<Record<string, unknown>>(req);
    const current = await readReports(sb, sess.name);
    if (b.action === 'delete') {
      const next = current.filter((r) => r.id !== str(b.id, 40));
      await writeReports(sb, sess.name, next);
      return json(res, 200, { reports: next });
    }
    const entry: Report = {
      id: str(b.id, 40) || ('r' + Date.now().toString(36)),
      appName: str(b.appName, 80) || '(untitled)', category: str(b.category, 60),
      fields: b.fields ?? {}, report: b.report ?? {}, grounded: Array.isArray(b.grounded) ? b.grounded : [],
      savedAt: new Date().toISOString(),
    };
    const next = [entry, ...current].slice(0, MAX);
    const ok = await writeReports(sb, sess.name, next);
    return json(res, ok ? 200 : 200, { reports: next, saved: entry.id, persisted: ok });
  }
  return json(res, 405, { error: 'method not allowed' });
}
