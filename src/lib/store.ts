/**
 * Storage layer. Default backend is Supabase (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY).
 * With LOCAL_STORE=1 (or missing Supabase env) it falls back to data/local-store.json —
 * same semantics, used for local dev and testing without a Supabase project.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { log } from './log.ts';

export type AppRow = {
  id: string;
  store_id: string;
  store: 'apple' | 'google';
  name: string;
  developer_name: string | null;
  developer_domain: string | null;
  category: string | null;
  description: string | null;
  first_seen_at: string;
  last_seen_at: string;
  status: string;
};

export type SnapshotRow = {
  app_id: string;
  captured_at: string;
  snapshot_date: string;
  geo: string;
  chart_rank: number | null;
  chart_type: string;
  rating: number | null;
  rating_count: number | null;
  installs: number | null;
  source: string;
};

export type ClaimRow = {
  id?: number;
  app_id: string;
  claimed_metric: string;
  claimed_value: number | null;
  claim_source_url: string | null;
  verified_value: number | null;
  discrepancy_ratio: number | null;
  captured_at: string;
};

export type ScoreRow = {
  app_id: string;
  geo: string;
  computed_at: string;
  rank_now: number | null;
  rank_prev: number | null;
  rank_velocity: number | null;
  rating_growth: number | null;
  momentum_score: number | null;
};

export type RollupRow = {
  app_id: string;
  computed_at: string;
  momentum_score: number | null;
  geos_live: string[];
  new_geos: string[];
  geo_gap: string[];
  is_incumbent: boolean;
  shortlisted: boolean;
  best_rank: number | null;
  rating: number | null;
  rating_count: number | null;
  fact_check_flag: boolean;
};

export type AnalysisRow = {
  app_id: string;
  analyzed_at: string;
  model_version: string | null;
  idea_score: number | null;
  idea_note: string | null;
  buildability: string | null;
  buildability_note: string | null;
  saturation: number | null;
  saturation_note: string | null;
  too_complex: boolean;
};

export type CompanyRow = {
  app_id: string;
  apollo_org_id: string | null;
  hq: string | null;
  stage: string | null;
  employee_count: number | null;
  contact_name: string | null;
  contact_email: string | null;
  enriched_at: string | null;
};

export type IdeaRow = {
  dedup_key: string;
  source: string;                 // x | linkedin | producthunt | hackernews | web
  source_url: string | null;
  author: string | null;
  posted_at: string | null;
  app_name: string | null;        // null until analyzed
  concept: string | null;
  category: string | null;
  novelty: number | null;         // 0-10
  buildability: string | null;    // weekend | few_days | week_or_two | months | too_complex
  demand: number | null;          // 0-10
  play: number | null;            // 0-100
  why: string | null;
  status: string;                 // new | scored
  captured_at: string;
};

export interface Store {
  backend: 'supabase' | 'local';
  /** Upsert apps by (store_id, store); preserves first_seen_at, bumps last_seen_at. Returns store_id->id map. */
  upsertApps(rows: Omit<AppRow, 'id' | 'first_seen_at' | 'last_seen_at' | 'status'>[]): Promise<Map<string, string>>;
  /** Insert snapshots, ignoring duplicates on (app_id, geo, chart_type, source, snapshot_date). */
  insertSnapshots(rows: SnapshotRow[]): Promise<number>;
  listApps(): Promise<AppRow[]>;
  listSnapshotsSince(isoDate: string): Promise<SnapshotRow[]>;
  upsertScores(rows: ScoreRow[]): Promise<void>;
  listScores(): Promise<ScoreRow[]>;
  upsertRollups(rows: RollupRow[]): Promise<void>;
  listRollups(): Promise<RollupRow[]>;
  upsertAnalyses(rows: AnalysisRow[]): Promise<void>;
  listAnalyses(): Promise<AnalysisRow[]>;
  /** "Delete" too-complex apps: status flag + dropped from shortlist; rows stay. */
  markTooComplex(appIds: string[]): Promise<void>;
  insertClaims(rows: Omit<ClaimRow, 'id'>[]): Promise<number>;
  listUnverifiedClaims(): Promise<ClaimRow[]>;
  updateClaim(id: number, patch: Partial<ClaimRow>): Promise<void>;
  setFactCheckFlag(appIds: string[]): Promise<void>;
  upsertCompany(row: CompanyRow): Promise<void>;
  listCompanies(): Promise<CompanyRow[]>;
  /** Idea Radar candidates. Tolerate a missing table (migration 0005 not applied yet). */
  upsertIdeas(rows: IdeaRow[]): Promise<number>;
  listIdeas(): Promise<IdeaRow[]>;
  recordRun(source: string, startedAt: string, ok: boolean, detail: Record<string, unknown>): Promise<void>;
  /** Escape hatch: raw Supabase client (null on local backend). Leads jobs use it. */
  raw(): SupabaseClient | null;
}

const CHUNK = 500;
function chunks<T>(arr: T[], n = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// ---------------------------------------------------------------- Supabase
class SupabaseStore implements Store {
  backend = 'supabase' as const;
  sb: SupabaseClient;
  constructor(url: string, key: string) {
    this.sb = createClient(url, key, { auth: { persistSession: false } });
  }
  raw() { return this.sb; }

  private async must<T>(p: PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T> {
    const { data, error } = await p;
    if (error) throw new Error(error.message);
    return data as T;
  }

  /** PostgREST caps responses at 1000 rows — page through with .range(). */
  private async paged<T>(query: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
    const out: T[] = [];
    for (let from = 0; ; from += 1000) {
      // Retry each page: Supabase intermittently cancels a page with "statement
      // timeout" under load, and one transient failure should not kill the build.
      let page: T[] | undefined;
      for (let attempt = 1; ; attempt++) {
        try { page = await this.must<T[]>(query(from, from + 999)); break; }
        catch (err) {
          if (attempt >= 4) throw err;
          await new Promise((r) => setTimeout(r, 1500 * attempt));
        }
      }
      out.push(...page);
      if (page.length < 1000) break;
    }
    return out;
  }

  async upsertApps(rows: Omit<AppRow, 'id' | 'first_seen_at' | 'last_seen_at' | 'status'>[]) {
    const ids = new Map<string, string>();
    const now = new Date().toISOString();
    for (const batch of chunks(rows)) {
      const keys = batch.map((r) => r.store_id);
      // Fetch first_seen_at/status so the upsert can write them back unchanged —
      // a single batched upsert (insert + update in one call) replaces what used
      // to be one sequential UPDATE round-trip per existing app. At ~35k apps the
      // old per-row loop couldn't finish inside the nightly watchdog and the
      // snapshot write never happened; this is ~1 round-trip per 500 apps.
      const existing = await this.must<Pick<AppRow, 'id' | 'store_id' | 'store' | 'first_seen_at' | 'status'>[]>(
        this.sb.from('apps').select('id, store_id, store, first_seen_at, status').in('store_id', keys),
      );
      const have = new Map(existing.map((e) => [`${e.store}:${e.store_id}`, e]));
      const payload = batch.map((r) => {
        const ex = have.get(`${r.store}:${r.store_id}`);
        return {
          ...r,
          first_seen_at: ex?.first_seen_at ?? now, // preserve original on update
          last_seen_at: now,
          status: ex?.status ?? 'active',          // don't clobber too_complex etc.
        };
      });
      const upserted = await this.must<Pick<AppRow, 'id' | 'store_id' | 'store'>[]>(
        this.sb.from('apps').upsert(payload, { onConflict: 'store_id,store' }).select('id, store_id, store'),
      );
      for (const c of upserted) ids.set(`${c.store}:${c.store_id}`, c.id);
    }
    return ids;
  }

  async insertSnapshots(rows: SnapshotRow[]) {
    let n = 0;
    for (const batch of chunks(rows)) {
      await this.must(this.sb.from('app_snapshots').upsert(batch, {
        onConflict: 'app_id,geo,chart_type,source,snapshot_date', ignoreDuplicates: true,
      }));
      n += batch.length;
    }
    return n;
  }

  async listApps() {
    return this.paged<AppRow>((from, to) => this.sb.from('apps').select('*').order('id').range(from, to));
  }

  async listSnapshotsSince(isoDate: string) {
    return this.paged<SnapshotRow>((from, to) =>
      this.sb.from('app_snapshots').select('*').gte('captured_at', isoDate).order('id').range(from, to),
    );
  }

  async upsertScores(rows: ScoreRow[]) {
    for (const batch of chunks(rows)) {
      await this.must(this.sb.from('app_scores').upsert(batch, { onConflict: 'app_id,geo' }));
    }
  }

  async listScores() {
    return this.paged<ScoreRow>((from, to) => this.sb.from('app_scores').select('*').order('app_id').range(from, to));
  }

  async upsertRollups(rows: RollupRow[]) {
    for (const batch of chunks(rows)) {
      await this.must(this.sb.from('app_rollups').upsert(batch, { onConflict: 'app_id' }));
    }
  }

  async listRollups() {
    return this.paged<RollupRow>((from, to) => this.sb.from('app_rollups').select('*').order('app_id').range(from, to));
  }

  async upsertAnalyses(rows: AnalysisRow[]) {
    for (const batch of chunks(rows)) {
      await this.must(this.sb.from('app_analysis').upsert(batch, { onConflict: 'app_id' }));
    }
  }

  async listAnalyses() {
    return this.paged<AnalysisRow>((from, to) => this.sb.from('app_analysis').select('*').order('app_id').range(from, to));
  }

  async markTooComplex(appIds: string[]) {
    for (let i = 0; i < appIds.length; i += 500) {
      const batch = appIds.slice(i, i + 500);
      await this.must(this.sb.from('apps').update({ status: 'too_complex' }).in('id', batch));
      await this.must(this.sb.from('app_rollups').update({ shortlisted: false }).in('app_id', batch));
    }
  }

  async insertClaims(rows: Omit<ClaimRow, 'id'>[]) {
    for (const batch of chunks(rows)) {
      await this.must(this.sb.from('app_claims').upsert(batch, {
        onConflict: 'app_id,claimed_metric,claim_source_url', ignoreDuplicates: true,
      }));
    }
    return rows.length;
  }

  async listUnverifiedClaims() {
    return this.paged<ClaimRow>((from, to) => this.sb.from('app_claims').select('*').is('verified_value', null).order('id').range(from, to));
  }

  async updateClaim(id: number, patch: Partial<ClaimRow>) {
    await this.must(this.sb.from('app_claims').update(patch).eq('id', id));
  }

  async setFactCheckFlag(appIds: string[]) {
    if (!appIds.length) return;
    await this.must(this.sb.from('app_rollups').update({ fact_check_flag: true }).in('app_id', appIds));
  }

  async upsertCompany(row: CompanyRow) {
    await this.must(this.sb.from('app_companies').upsert(row, { onConflict: 'app_id' }));
  }

  async listCompanies() {
    return this.paged<CompanyRow>((from, to) => this.sb.from('app_companies').select('*').order('app_id').range(from, to));
  }

  async upsertIdeas(rows: IdeaRow[]) {
    if (!rows.length) return 0;
    try {
      for (const batch of chunks(rows)) {
        await this.must(this.sb.from('idea_radar').upsert(batch, { onConflict: 'dedup_key' }));
      }
      return rows.length;
    } catch (err) {
      if (/idea_radar|does not exist|find the table|schema cache/i.test(String(err))) {
        log.warn('idea_radar table missing — apply migration 0005_idea_radar.sql to persist ideas');
        return 0;
      }
      throw err;
    }
  }

  async listIdeas() {
    try {
      return await this.paged<IdeaRow>((from, to) =>
        this.sb.from('idea_radar').select('*').order('play', { ascending: false, nullsFirst: false }).range(from, to));
    } catch (err) {
      if (/idea_radar|does not exist|find the table|schema cache/i.test(String(err))) return [];
      throw err;
    }
  }

  async recordRun(source: string, startedAt: string, ok: boolean, detail: Record<string, unknown>) {
    await this.must(this.sb.from('ingest_runs').insert({
      source, started_at: startedAt, finished_at: new Date().toISOString(), ok, detail,
    }));
  }
}

// ---------------------------------------------------------------- Local JSON
type LocalData = {
  apps: AppRow[];
  app_snapshots: SnapshotRow[];
  app_claims: ClaimRow[];
  app_scores: ScoreRow[];
  app_rollups: RollupRow[];
  app_companies: CompanyRow[];
  app_analysis?: AnalysisRow[];
  idea_radar?: IdeaRow[];
  ingest_runs: unknown[];
  _claimSeq: number;
};

class LocalStore implements Store {
  backend = 'local' as const;
  file = path.join(process.cwd(), 'data', 'local-store.json');
  d: LocalData;

  constructor() {
    mkdirSync(path.dirname(this.file), { recursive: true });
    this.d = existsSync(this.file)
      ? JSON.parse(readFileSync(this.file, 'utf8'))
      : { apps: [], app_snapshots: [], app_claims: [], app_scores: [], app_rollups: [], app_companies: [], ingest_runs: [], _claimSeq: 1 };
  }
  raw() { return null; }
  private save() { writeFileSync(this.file, JSON.stringify(this.d)); }

  async upsertApps(rows: Omit<AppRow, 'id' | 'first_seen_at' | 'last_seen_at' | 'status'>[]) {
    const ids = new Map<string, string>();
    const now = new Date().toISOString();
    const byKey = new Map(this.d.apps.map((a) => [`${a.store}:${a.store_id}`, a]));
    for (const r of rows) {
      const k = `${r.store}:${r.store_id}`;
      const ex = byKey.get(k);
      if (ex) {
        Object.assign(ex, { name: r.name, developer_name: r.developer_name, developer_domain: r.developer_domain, category: r.category, description: r.description, last_seen_at: now });
        ids.set(k, ex.id);
      } else {
        const row: AppRow = { ...r, id: randomUUID(), first_seen_at: now, last_seen_at: now, status: 'active' };
        this.d.apps.push(row);
        byKey.set(k, row);
        ids.set(k, row.id);
      }
    }
    this.save();
    return ids;
  }

  async insertSnapshots(rows: SnapshotRow[]) {
    const seen = new Set(this.d.app_snapshots.map((s) => `${s.app_id}|${s.geo}|${s.chart_type}|${s.source}|${s.snapshot_date}`));
    let n = 0;
    for (const r of rows) {
      const k = `${r.app_id}|${r.geo}|${r.chart_type}|${r.source}|${r.snapshot_date}`;
      if (seen.has(k)) continue;
      seen.add(k);
      this.d.app_snapshots.push(r);
      n++;
    }
    this.save();
    return n;
  }

  async listApps() { return this.d.apps; }
  async listSnapshotsSince(isoDate: string) { return this.d.app_snapshots.filter((s) => s.captured_at >= isoDate); }

  async upsertScores(rows: ScoreRow[]) {
    const byKey = new Map(this.d.app_scores.map((s) => [`${s.app_id}|${s.geo}`, s]));
    for (const r of rows) {
      const ex = byKey.get(`${r.app_id}|${r.geo}`);
      if (ex) Object.assign(ex, r);
      else { this.d.app_scores.push(r); byKey.set(`${r.app_id}|${r.geo}`, r); }
    }
    this.save();
  }

  async upsertRollups(rows: RollupRow[]) {
    const byKey = new Map(this.d.app_rollups.map((s) => [s.app_id, s]));
    for (const r of rows) {
      const ex = byKey.get(r.app_id);
      if (ex) Object.assign(ex, r);
      else { this.d.app_rollups.push(r); byKey.set(r.app_id, r); }
    }
    this.save();
  }

  async listRollups() { return this.d.app_rollups; }
  async listScores() { return this.d.app_scores; }

  async upsertAnalyses(rows: AnalysisRow[]) {
    this.d.app_analysis ??= [];
    const byKey = new Map(this.d.app_analysis.map((a) => [a.app_id, a]));
    for (const r of rows) {
      const ex = byKey.get(r.app_id);
      if (ex) Object.assign(ex, r);
      else { this.d.app_analysis.push(r); byKey.set(r.app_id, r); }
    }
    this.save();
  }

  async listAnalyses() { return this.d.app_analysis ?? []; }

  async markTooComplex(appIds: string[]) {
    const set = new Set(appIds);
    for (const a of this.d.apps) if (set.has(a.id)) a.status = 'too_complex';
    for (const r of this.d.app_rollups) if (set.has(r.app_id)) r.shortlisted = false;
    this.save();
  }

  async insertClaims(rows: Omit<ClaimRow, 'id'>[]) {
    const seen = new Set(this.d.app_claims.map((c) => `${c.app_id}|${c.claimed_metric}|${c.claim_source_url}`));
    let n = 0;
    for (const r of rows) {
      const k = `${r.app_id}|${r.claimed_metric}|${r.claim_source_url}`;
      if (seen.has(k)) continue;
      seen.add(k);
      this.d.app_claims.push({ ...r, id: this.d._claimSeq++ });
      n++;
    }
    this.save();
    return n;
  }

  async listUnverifiedClaims() { return this.d.app_claims.filter((c) => c.verified_value == null); }

  async updateClaim(id: number, patch: Partial<ClaimRow>) {
    const c = this.d.app_claims.find((c) => c.id === id);
    if (c) Object.assign(c, patch);
    this.save();
  }

  async setFactCheckFlag(appIds: string[]) {
    const set = new Set(appIds);
    for (const r of this.d.app_rollups) if (set.has(r.app_id)) r.fact_check_flag = true;
    this.save();
  }

  async upsertCompany(row: CompanyRow) {
    const ex = this.d.app_companies.find((c) => c.app_id === row.app_id);
    if (ex) Object.assign(ex, row);
    else this.d.app_companies.push(row);
    this.save();
  }

  async listCompanies() { return this.d.app_companies; }

  async upsertIdeas(rows: IdeaRow[]) {
    this.d.idea_radar ??= [];
    const byKey = new Map(this.d.idea_radar.map((i) => [i.dedup_key, i]));
    for (const r of rows) {
      const ex = byKey.get(r.dedup_key);
      if (ex) Object.assign(ex, r);
      else { this.d.idea_radar.push(r); byKey.set(r.dedup_key, r); }
    }
    this.save();
    return rows.length;
  }

  async listIdeas() { return this.d.idea_radar ?? []; }

  async recordRun(source: string, startedAt: string, ok: boolean, detail: Record<string, unknown>) {
    this.d.ingest_runs.push({ source, started_at: startedAt, finished_at: new Date().toISOString(), ok, detail });
    this.save();
  }
}

let _store: Store | null = null;
export function getStore(): Store {
  if (_store) return _store;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (process.env.LOCAL_STORE === '1' || !url || !key) {
    if (!url || !key) log.warn('SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set — using local JSON store (data/local-store.json)');
    _store = new LocalStore();
  } else {
    _store = new SupabaseStore(url, key);
  }
  return _store;
}
