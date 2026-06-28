/**
 * Persistence for competitive analyses so a manager's past runs stay available
 * as a browsable list. Supabase-backed in production (table `compete_analyses`,
 * migration 0004) via the store's raw client; falls back to data/compete-analyses.json
 * for local dev. Tolerates a missing table, persistence no-ops with a warning
 * rather than failing the run, so the feature still works before the migration
 * is applied (the current result just won't survive a reload until then).
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { getStore } from '../lib/store.ts';
import { log } from '../lib/log.ts';
import type { CompetitiveAnalysis } from './competitive.ts';

export type AnalysisRecord = CompetitiveAnalysis & { id: string };
export type AnalysisSummary = {
  id: string;
  app: string;
  category: string;
  generated_at: string;
  competitors: number;
  web_search: boolean;
};

const TABLE = 'compete_analyses';
const LOCAL_FILE = path.join(process.cwd(), 'data', 'compete-analyses.json');
const missingTable = (e: unknown) => /compete_analyses|does not exist|find the table|schema cache/i.test(String(e));

function readLocal(): AnalysisRecord[] {
  try { return existsSync(LOCAL_FILE) ? (JSON.parse(readFileSync(LOCAL_FILE, 'utf8')) as AnalysisRecord[]) : []; }
  catch { return []; }
}
function writeLocal(recs: AnalysisRecord[]) {
  mkdirSync(path.dirname(LOCAL_FILE), { recursive: true });
  writeFileSync(LOCAL_FILE, JSON.stringify(recs));
}
const toSummary = (r: AnalysisRecord): AnalysisSummary => ({
  id: r.id, app: r.app, category: r.category,
  generated_at: r.meta?.generated_at ?? '', competitors: r.competitors?.length ?? 0,
  web_search: !!r.meta?.web_search,
});

/** Persist a completed analysis; returns its id (assigned if not already set). */
export async function saveAnalysis(a: CompetitiveAnalysis): Promise<string> {
  const id = a.id || randomUUID();
  const rec: AnalysisRecord = { ...a, id };
  const sb = getStore().raw();
  if (sb) {
    try {
      const { error } = await sb.from(TABLE).insert({
        id, app: a.app, category: a.category, generated_at: a.meta.generated_at, payload: rec,
      });
      if (error) throw new Error(error.message);
    } catch (err) {
      if (missingTable(err)) { log.warn('compete: compete_analyses table missing, not persisted (apply migration 0004)'); return id; }
      throw err;
    }
    return id;
  }
  const recs = readLocal();
  recs.unshift(rec);
  writeLocal(recs.slice(0, 200));
  return id;
}

/** Most-recent-first summaries for the history list. */
export async function listAnalyses(limit = 50): Promise<AnalysisSummary[]> {
  const sb = getStore().raw();
  if (sb) {
    try {
      const { data, error } = await sb.from(TABLE)
        .select('payload').order('generated_at', { ascending: false }).limit(limit);
      if (error) throw new Error(error.message);
      return ((data ?? []) as { payload: AnalysisRecord }[]).map((r) => toSummary(r.payload));
    } catch (err) {
      if (missingTable(err)) return [];
      throw err;
    }
  }
  return readLocal().slice(0, limit).map(toSummary);
}

/** Full saved analysis by id, or null if not found. */
export async function getAnalysis(id: string): Promise<AnalysisRecord | null> {
  const sb = getStore().raw();
  if (sb) {
    try {
      const { data, error } = await sb.from(TABLE).select('payload').eq('id', id).maybeSingle();
      if (error) throw new Error(error.message);
      return ((data as { payload: AnalysisRecord } | null)?.payload) ?? null;
    } catch (err) {
      if (missingTable(err)) return null;
      throw err;
    }
  }
  return readLocal().find((r) => r.id === id) ?? null;
}
