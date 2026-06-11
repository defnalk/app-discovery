/**
 * Leads-section storage. Reuses the 8x_lead_intel tables (leads,
 * classifications, config, threshold_suggestions, campaigns, campaign_leads,
 * events, runs) plus the dashboard additions (approvals, settings_audit,
 * funnel_rollups). Supabase in production; data/leads-local.json with
 * LOCAL_STORE=1 for development.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { log } from '../lib/log.ts';

export type LeadJoined = {
  id: string;
  source_arm: string;
  company: string | null;
  domain: string | null;
  email: string | null;
  email_status: string | null;
  contact_name: string | null;
  contact_title: string | null;
  category: string | null;
  hq: string | null;
  geo: string | null;
  stage: string | null;
  signal_source_url: string | null;
  enriched_at: string | null;
  created_at: string;
  // latest classification
  jaka_score: number | null;
  market_status: string | null;
  fit_verdict: string | null;
  reason: string | null;
};

export type CampaignRow = {
  id: string;
  instantly_campaign_id: string | null;
  name: string;
  status: string;
  approved_at: string | null;
  created_at: string;
};

export type CampaignLeadRow = { campaign_id: string; lead_id: string; instantly_lead_id: string | null; send_status: string | null };

export type EventRow = {
  lead_id: string | null;
  campaign_id: string | null;
  type: string;
  payload: Record<string, unknown> | null;
  occurred_at: string;
};

export type ConfigRow = { key: string; value: unknown; version: number; active: boolean; updated_at: string | null; updated_by: string | null };

export type SuggestionRow = {
  id?: number;
  proposed: Record<string, unknown>;
  rationale: string | null;
  evidence: Record<string, unknown> | null;
  status: string;
  decided_by: string | null;
  decided_at: string | null;
  created_at?: string;
};

export type FunnelRow = { stage: string; source_arm: string; geo: string; count: number; computed_at: string };

export type AuditRow = { setting: string; old_value: unknown; new_value: unknown; suggested_by: 'system' | 'user'; approved_by: string; created_at?: string };

export const FUNNEL_STAGES = ['raw', 'icp_qualified', 'pushed', 'sendable', 'sent', 'replied', 'meeting'] as const;

export type NewLead = {
  source_arm: string;
  company: string | null;
  domain: string | null;
  email: string | null;
  email_status: string | null;
  contact_name: string | null;
  contact_title: string | null;
  category: string | null;
  hq: string | null;
  geo: string | null;
  signal_source_url: string | null;
  enriched_at: string | null;
  raw_payload: Record<string, unknown> | null;
};

export interface LeadsDb {
  backend: 'supabase' | 'local';
  /** Idempotent on (domain, email); provenance (source_arm) is mandatory. */
  insertLeads(rows: NewLead[]): Promise<number>;
  listLeadsJoined(): Promise<LeadJoined[]>;
  updateLeadStages(stages: Map<string, string>): Promise<void>;
  replaceFunnelRollups(rows: FunnelRow[]): Promise<void>;
  getFunnelRollups(): Promise<FunnelRow[]>;
  listCampaigns(status?: string): Promise<CampaignRow[]>;
  listCampaignLeads(campaignId?: string): Promise<CampaignLeadRow[]>;
  setCampaignStatus(id: string, status: string, approvedAt?: string): Promise<void>;
  setCampaignLeadPushed(campaignId: string, leadId: string, instantlyLeadId: string | null, sendStatus: string): Promise<void>;
  insertApproval(a: { batch_id: string; lead_ids: string[]; excluded_lead_ids: string[]; status: 'approved' | 'rejected'; approved_by: string; note: string | null }): Promise<void>;
  listApprovals(): Promise<({ batch_id: string; status: string; approved_by: string; note: string | null; created_at: string })[]>;
  upsertEvents(rows: EventRow[]): Promise<number>;
  listEvents(sinceIso?: string): Promise<EventRow[]>;
  listActiveConfig(): Promise<ConfigRow[]>;
  insertConfigVersion(key: string, value: unknown, updatedBy: string): Promise<void>;
  listSuggestions(status?: string): Promise<SuggestionRow[]>;
  insertSuggestion(s: Omit<SuggestionRow, 'id' | 'status' | 'decided_by' | 'decided_at'>): Promise<void>;
  resolveSuggestion(id: number, status: 'approved' | 'rejected', by: string): Promise<SuggestionRow | null>;
  insertAudit(a: AuditRow): Promise<void>;
  listAudit(): Promise<AuditRow[]>;
  recordRun(stage: string, startedAt: string, counts: { input?: number; output?: number; errors?: number }, notes?: string): Promise<void>;
}

// ---------------------------------------------------------------- Supabase
class SupabaseLeadsDb implements LeadsDb {
  backend = 'supabase' as const;
  sb: SupabaseClient;
  constructor(url: string, key: string) {
    this.sb = createClient(url, key, { auth: { persistSession: false } });
  }
  private async must<T>(p: PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T> {
    const { data, error } = await p;
    if (error) throw new Error(error.message);
    return data as T;
  }

  async insertLeads(rows: NewLead[]) {
    const valid = rows.filter((r) => r.source_arm); // provenance mandatory
    if (valid.length < rows.length) log.warn(`insertLeads: rejected ${rows.length - valid.length} rows without source_arm`);
    let n = 0;
    for (let i = 0; i < valid.length; i += 500) {
      const batch = valid.slice(i, i + 500);
      await this.must(this.sb.from('leads').upsert(batch, { onConflict: 'domain,email', ignoreDuplicates: true }));
      n += batch.length;
    }
    return n;
  }

  async listLeadsJoined() {
    const leads = await this.must<Record<string, unknown>[]>(
      this.sb.from('leads').select('*, classifications(jaka_score, market_status, fit_verdict, reason, classified_at)').limit(20000),
    );
    return leads.map((l) => {
      const cls = (l.classifications as Record<string, unknown>[] | null ?? [])
        .sort((a, b) => String(b.classified_at).localeCompare(String(a.classified_at)))[0] ?? {};
      const { classifications: _, ...lead } = l;
      return { ...lead, jaka_score: cls.jaka_score ?? null, market_status: cls.market_status ?? null, fit_verdict: cls.fit_verdict ?? null, reason: cls.reason ?? null } as LeadJoined;
    });
  }

  async updateLeadStages(stages: Map<string, string>) {
    // group by stage to batch updates
    const byStage = new Map<string, string[]>();
    for (const [id, st] of stages) (byStage.get(st) ?? byStage.set(st, []).get(st)!).push(id);
    for (const [stage, ids] of byStage) {
      for (let i = 0; i < ids.length; i += 500) {
        await this.must(this.sb.from('leads').update({ stage }).in('id', ids.slice(i, i + 500)));
      }
    }
  }

  async replaceFunnelRollups(rows: FunnelRow[]) {
    await this.must(this.sb.from('funnel_rollups').delete().neq('stage', ''));
    if (rows.length) await this.must(this.sb.from('funnel_rollups').insert(rows));
  }
  async getFunnelRollups() { return this.must<FunnelRow[]>(this.sb.from('funnel_rollups').select('*')); }

  async listCampaigns(status?: string) {
    let q = this.sb.from('campaigns').select('*').order('created_at', { ascending: false });
    if (status) q = q.eq('status', status);
    return this.must<CampaignRow[]>(q);
  }
  async listCampaignLeads(campaignId?: string) {
    let q = this.sb.from('campaign_leads').select('*');
    if (campaignId) q = q.eq('campaign_id', campaignId);
    return this.must<CampaignLeadRow[]>(q);
  }
  async setCampaignStatus(id: string, status: string, approvedAt?: string) {
    await this.must(this.sb.from('campaigns').update({ status, ...(approvedAt ? { approved_at: approvedAt } : {}) }).eq('id', id));
  }
  async setCampaignLeadPushed(campaignId: string, leadId: string, instantlyLeadId: string | null, sendStatus: string) {
    await this.must(this.sb.from('campaign_leads').update({ instantly_lead_id: instantlyLeadId, send_status: sendStatus }).eq('campaign_id', campaignId).eq('lead_id', leadId));
  }
  async insertApproval(a: Parameters<LeadsDb['insertApproval']>[0]) {
    await this.must(this.sb.from('approvals').insert(a));
  }
  async listApprovals() {
    return this.must<Awaited<ReturnType<LeadsDb['listApprovals']>>>(this.sb.from('approvals').select('batch_id, status, approved_by, note, created_at'));
  }

  async upsertEvents(rows: EventRow[]) {
    let n = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const batch = rows.slice(i, i + 500);
      await this.must(this.sb.from('events').upsert(batch, { onConflict: 'lead_id,campaign_id,type,occurred_at', ignoreDuplicates: true }));
      n += batch.length;
    }
    return n;
  }
  async listEvents(sinceIso?: string) {
    let q = this.sb.from('events').select('lead_id, campaign_id, type, payload, occurred_at').limit(50000);
    if (sinceIso) q = q.gte('occurred_at', sinceIso);
    return this.must<EventRow[]>(q);
  }

  async listActiveConfig() {
    return this.must<ConfigRow[]>(this.sb.from('config').select('*').eq('active', true));
  }
  async insertConfigVersion(key: string, value: unknown, updatedBy: string) {
    const cur = await this.must<ConfigRow[]>(this.sb.from('config').select('*').eq('key', key).eq('active', true));
    const version = (cur[0]?.version ?? 0) + 1;
    if (cur[0]) await this.must(this.sb.from('config').update({ active: false }).eq('key', key).eq('active', true));
    await this.must(this.sb.from('config').insert({ key, value, version, active: true, updated_at: new Date().toISOString(), updated_by: updatedBy }));
  }

  async listSuggestions(status?: string) {
    let q = this.sb.from('threshold_suggestions').select('*').order('created_at', { ascending: false });
    if (status) q = q.eq('status', status);
    return this.must<SuggestionRow[]>(q);
  }
  async insertSuggestion(s: Omit<SuggestionRow, 'id' | 'status' | 'decided_by' | 'decided_at'>) {
    // dedupe: skip if an identical pending proposal exists
    const pending = await this.listSuggestions('pending');
    if (pending.some((p) => JSON.stringify(p.proposed) === JSON.stringify(s.proposed))) return;
    await this.must(this.sb.from('threshold_suggestions').insert({ ...s, status: 'pending' }));
  }
  async resolveSuggestion(id: number, status: 'approved' | 'rejected', by: string) {
    const rows = await this.must<SuggestionRow[]>(
      this.sb.from('threshold_suggestions').update({ status, decided_by: by, decided_at: new Date().toISOString() })
        .eq('id', id).eq('status', 'pending').select('*'),
    );
    return rows[0] ?? null;
  }

  async insertAudit(a: AuditRow) { await this.must(this.sb.from('settings_audit').insert(a)); }
  async listAudit() {
    return this.must<AuditRow[]>(this.sb.from('settings_audit').select('*').order('created_at', { ascending: false }).limit(200));
  }

  async recordRun(stage: string, startedAt: string, counts: { input?: number; output?: number; errors?: number }, notes?: string) {
    await this.must(this.sb.from('runs').insert({
      stage, started_at: startedAt, finished_at: new Date().toISOString(),
      input_count: counts.input ?? null, output_count: counts.output ?? null, error_count: counts.errors ?? 0, notes: notes ?? null,
    }));
  }
}

// ---------------------------------------------------------------- Local JSON
type LocalLeadsData = {
  leads: (Omit<LeadJoined, 'jaka_score' | 'market_status' | 'fit_verdict' | 'reason'> & { raw_payload?: unknown })[];
  classifications: { lead_id: string; jaka_score: number | null; market_status: string | null; fit_verdict: string | null; reason: string | null; classified_at: string }[];
  campaigns: CampaignRow[];
  campaign_leads: CampaignLeadRow[];
  events: EventRow[];
  config: ConfigRow[];
  threshold_suggestions: SuggestionRow[];
  approvals: { batch_id: string; lead_ids: string[]; excluded_lead_ids: string[]; status: string; approved_by: string; note: string | null; created_at: string }[];
  settings_audit: AuditRow[];
  funnel_rollups: FunnelRow[];
  runs: unknown[];
  _suggestionSeq: number;
};

class LocalLeadsDb implements LeadsDb {
  backend = 'local' as const;
  file = path.join(process.cwd(), 'data', 'leads-local.json');
  d: LocalLeadsData;
  constructor() {
    mkdirSync(path.dirname(this.file), { recursive: true });
    this.d = existsSync(this.file)
      ? JSON.parse(readFileSync(this.file, 'utf8'))
      : { leads: [], classifications: [], campaigns: [], campaign_leads: [], events: [], config: [], threshold_suggestions: [], approvals: [], settings_audit: [], funnel_rollups: [], runs: [], _suggestionSeq: 1 };
  }
  private save() { writeFileSync(this.file, JSON.stringify(this.d)); }

  async insertLeads(rows: NewLead[]) {
    const valid = rows.filter((r) => r.source_arm);
    if (valid.length < rows.length) log.warn(`insertLeads: rejected ${rows.length - valid.length} rows without source_arm`);
    const key = (r: { domain: string | null; email: string | null }) => `${r.domain}|${r.email}`;
    const seen = new Set(this.d.leads.map(key));
    let n = 0;
    const now = new Date().toISOString();
    for (const r of valid) {
      if (seen.has(key(r))) continue;
      seen.add(key(r));
      this.d.leads.push({ id: randomUUID(), created_at: now, stage: 'raw', ...r });
      n++;
    }
    this.save();
    return n;
  }

  async listLeadsJoined() {
    const latest = new Map<string, LocalLeadsData['classifications'][number]>();
    for (const c of this.d.classifications) {
      const cur = latest.get(c.lead_id);
      if (!cur || c.classified_at > cur.classified_at) latest.set(c.lead_id, c);
    }
    return this.d.leads.map((l) => {
      const c = latest.get(l.id);
      return { ...l, jaka_score: c?.jaka_score ?? null, market_status: c?.market_status ?? null, fit_verdict: c?.fit_verdict ?? null, reason: c?.reason ?? null } as LeadJoined;
    });
  }
  async updateLeadStages(stages: Map<string, string>) {
    for (const l of this.d.leads) { const s = stages.get(l.id); if (s) l.stage = s; }
    this.save();
  }
  async replaceFunnelRollups(rows: FunnelRow[]) { this.d.funnel_rollups = rows; this.save(); }
  async getFunnelRollups() { return this.d.funnel_rollups; }
  async listCampaigns(status?: string) { return this.d.campaigns.filter((c) => !status || c.status === status); }
  async listCampaignLeads(campaignId?: string) { return this.d.campaign_leads.filter((c) => !campaignId || c.campaign_id === campaignId); }
  async setCampaignStatus(id: string, status: string, approvedAt?: string) {
    const c = this.d.campaigns.find((c) => c.id === id);
    if (c) { c.status = status; if (approvedAt) c.approved_at = approvedAt; }
    this.save();
  }
  async setCampaignLeadPushed(campaignId: string, leadId: string, instantlyLeadId: string | null, sendStatus: string) {
    const cl = this.d.campaign_leads.find((c) => c.campaign_id === campaignId && c.lead_id === leadId);
    if (cl) { cl.instantly_lead_id = instantlyLeadId; cl.send_status = sendStatus; }
    this.save();
  }
  async insertApproval(a: Parameters<LeadsDb['insertApproval']>[0]) {
    this.d.approvals.push({ ...a, created_at: new Date().toISOString() });
    this.save();
  }
  async listApprovals() { return this.d.approvals; }
  async upsertEvents(rows: EventRow[]) {
    const key = (e: EventRow) => `${e.lead_id}|${e.campaign_id}|${e.type}|${e.occurred_at}`;
    const seen = new Set(this.d.events.map(key));
    let n = 0;
    for (const r of rows) { if (!seen.has(key(r))) { seen.add(key(r)); this.d.events.push(r); n++; } }
    this.save();
    return n;
  }
  async listEvents(sinceIso?: string) { return this.d.events.filter((e) => !sinceIso || e.occurred_at >= sinceIso); }
  async listActiveConfig() { return this.d.config.filter((c) => c.active); }
  async insertConfigVersion(key: string, value: unknown, updatedBy: string) {
    const cur = this.d.config.find((c) => c.key === key && c.active);
    if (cur) cur.active = false;
    this.d.config.push({ key, value, version: (cur?.version ?? 0) + 1, active: true, updated_at: new Date().toISOString(), updated_by: updatedBy });
    this.save();
  }
  async listSuggestions(status?: string) { return this.d.threshold_suggestions.filter((s) => !status || s.status === status); }
  async insertSuggestion(s: Omit<SuggestionRow, 'id' | 'status' | 'decided_by' | 'decided_at'>) {
    if (this.d.threshold_suggestions.some((p) => p.status === 'pending' && JSON.stringify(p.proposed) === JSON.stringify(s.proposed))) return;
    this.d.threshold_suggestions.push({ ...s, id: this.d._suggestionSeq++, status: 'pending', decided_by: null, decided_at: null, created_at: new Date().toISOString() });
    this.save();
  }
  async resolveSuggestion(id: number, status: 'approved' | 'rejected', by: string) {
    const s = this.d.threshold_suggestions.find((s) => s.id === id && s.status === 'pending');
    if (!s) return null;
    s.status = status; s.decided_by = by; s.decided_at = new Date().toISOString();
    this.save();
    return s;
  }
  async insertAudit(a: AuditRow) { this.d.settings_audit.unshift({ ...a, created_at: new Date().toISOString() }); this.save(); }
  async listAudit() { return this.d.settings_audit; }
  async recordRun(stage: string, startedAt: string, counts: { input?: number; output?: number; errors?: number }, notes?: string) {
    this.d.runs.push({ stage, started_at: startedAt, finished_at: new Date().toISOString(), ...counts, notes });
    this.save();
  }
}

let _db: LeadsDb | null = null;
export function getLeadsDb(): LeadsDb {
  if (_db) return _db;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (process.env.LOCAL_STORE === '1' || !url || !key) {
    if (!url || !key) log.warn('leads: no Supabase env — using local JSON store (data/leads-local.json)');
    _db = new LocalLeadsDb();
  } else {
    _db = new SupabaseLeadsDb(url, key);
  }
  return _db;
}
