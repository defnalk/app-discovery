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

export interface Store {
  backend: 'supabase' | 'local';
  /** Upsert apps by (store_id, store); preserves first_seen_at, bumps last_seen_at. Returns store_id->id map. */
  upsertApps(rows: Omit<AppRow, 'id' | 'first_seen_at' | 'last_seen_at' | 'status'>[]): Promise<Map<string, string>>;
  /** Insert snapshots, ignoring duplicates on (app_id, geo, chart_type, source, snapshot_date). */
  insertSnapshots(rows: SnapshotRow[]): Promise<number>;
  listApps(): Promise<AppRow[]>;
  listSnapshotsSince(isoDate: string): Promise<SnapshotRow[]>;
  upsertScores(rows: ScoreRow[]): Promise<void>;
  upsertRollups(rows: RollupRow[]): Promise<void>;
  listRollups(): Promise<RollupRow[]>;
  insertClaims(rows: Omit<ClaimRow, 'id'>[]): Promise<number>;
  listUnverifiedClaims(): Promise<ClaimRow[]>;
  updateClaim(id: number, patch: Partial<ClaimRow>): Promise<void>;
  setFactCheckFlag(appIds: string[]): Promise<void>;
  upsertCompany(row: CompanyRow): Promise<void>;
  listCompanies(): Promise<CompanyRow[]>;
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
      const page = await this.must<T[]>(query(from, from + 999));
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
      const existing = await this.must<Pick<AppRow, 'id' | 'store_id' | 'store'>[]>(
        this.sb.from('apps').select('id, store_id, store').in('store_id', keys),
      );
      const have = new Map(existing.map((e) => [`${e.store}:${e.store_id}`, e.id]));
      const inserts = [];
      for (const r of batch) {
        const k = `${r.store}:${r.store_id}`;
        if (have.has(k)) ids.set(k, have.get(k)!);
        else inserts.push({ ...r, first_seen_at: now, last_seen_at: now });
      }
      if (inserts.length) {
        const created = await this.must<Pick<AppRow, 'id' | 'store_id' | 'store'>[]>(
          this.sb.from('apps').upsert(inserts, { onConflict: 'store_id,store' }).select('id, store_id, store'),
        );
        for (const c of created) ids.set(`${c.store}:${c.store_id}`, c.id);
      }
      // refresh mutable fields + last_seen_at on existing rows
      for (const r of batch) {
        const k = `${r.store}:${r.store_id}`;
        if (have.has(k)) {
          await this.must(
            this.sb.from('apps').update({
              name: r.name, developer_name: r.developer_name, developer_domain: r.developer_domain,
              category: r.category, description: r.description, last_seen_at: now,
            }).eq('id', have.get(k)!),
          );
        }
      }
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

  async upsertRollups(rows: RollupRow[]) {
    for (const batch of chunks(rows)) {
      await this.must(this.sb.from('app_rollups').upsert(batch, { onConflict: 'app_id' }));
    }
  }

  async listRollups() {
    return this.paged<RollupRow>((from, to) => this.sb.from('app_rollups').select('*').order('app_id').range(from, to));
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
