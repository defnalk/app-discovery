/**
 * Import the already-sourced contact lists sitting in ~/Downloads that the
 * original importers never loaded. Every file here was hand/LLM-vetted during
 * the earlier cold-email projects, so this is pure keyless lead expansion — no
 * Apollo, no API spend. New source_arms widen the strategy mix too.
 *
 * Idempotent on (domain|email) and (company|arm), exactly like import-pools /
 * import-xlsx, so re-running never duplicates and overlaps with the existing
 * book are skipped. Run with DRY_RUN=1 to preview counts without writing.
 */
import XLSX from 'xlsx';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { log } from '../lib/log.ts';
import { getLeadsDb, type NewLead, type NewClassification } from './db.ts';

const DOWNLOADS = process.env.LEADS_DIR ?? path.join(process.env.HOME ?? '', 'Downloads');
const DRY_RUN = process.env.DRY_RUN === '1';
const str = (v: unknown): string | null => (v == null || v === '' ? null : String(v).trim());
const lc = (v: unknown): string | null => str(v)?.toLowerCase() ?? null;

type Row = Record<string, unknown>;
/** First non-empty value across a list of possible header aliases. */
function pick(row: Row, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = str(row[k]);
    if (v) return v;
  }
  return null;
}
function domainOf(row: Row): string | null {
  const raw = pick(row, 'domain', 'website', 'url');
  if (!raw) return null;
  try {
    return new URL(raw.startsWith('http') ? raw : `https://${raw}`).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return raw.toLowerCase().replace(/^www\./, '').split('/')[0] || null;
  }
}
// Map free-text classification/verdict strings onto the canonical fit verdict.
const QUALIFIED = /fit|qualif|yes|include|icp|sendable|clean/i;
function fitOf(row: Row): string | null {
  const v = pick(row, 'fit_verdict', 'classification', 'status');
  if (!v) return null;
  return QUALIFIED.test(v) ? 'fit' : lc(v);
}
function scoreOf(row: Row): number | null {
  const v = pick(row, 'jaka_score', 'icp_score', 'score');
  const n = v == null ? NaN : Number(v);
  return Number.isFinite(n) ? n : null;
}

type Spec = {
  file: string;
  /** literal arm, or a column to read the arm from (per-row) with a fallback. */
  arm: string | { col: string; fallback: string };
  geo?: string;       // literal geo when the list is single-market
  geoCol?: string;    // or a column holding the geo
  list: string;       // recorded in raw_payload.list for provenance
};

const SPECS: Spec[] = [
  { file: 'all_leads_full.csv',                              arm: { col: 'source', fallback: 'imported_master' }, list: 'all_leads_full' },
  { file: '8x_lead_fit.csv',                                 arm: { col: 'strategy', fallback: 'lead_fit' }, geoCol: 'target_geo', list: '8x_lead_fit' },
  { file: 'leads_qualified.csv',                             arm: { col: 'source', fallback: 'qualified' }, list: 'leads_qualified' },
  { file: 'lookalikes_8x_final.csv',                         arm: 'lookalike', geoCol: 'country', list: 'lookalikes_final' },
  { file: '8x_india_icp_lookalikes_top100_with_contacts.csv',arm: 'lookalike', geo: 'in', list: 'india_lookalikes_top100' },
  { file: 'new_ai_consumer_leads.csv',                       arm: 'new_ai_consumer', list: 'new_ai_consumer' },
  { file: 'instantly_clean_sendable.csv',                    arm: { col: 'list', fallback: 'clean_sendable' }, list: 'instantly_clean_sendable' },
  { file: 'turkey_new_apps_web.csv',                         arm: 'market_pool', geo: 'tr', list: 'turkey_new_apps_web' },
  { file: 'ranked_from_image.csv',                           arm: 'ranked', geoCol: 'target_geo', list: 'ranked_from_image' },
];

type Parsed = { lead: NewLead; cls: Omit<NewClassification, 'lead_id'> | null };

function parse(spec: Spec): Parsed[] {
  const full = path.join(DOWNLOADS, spec.file);
  if (!existsSync(full)) { log.warn(`import-extra: ${spec.file} not found, skipping`); return []; }
  const wb = XLSX.readFile(full);
  const rows = XLSX.utils.sheet_to_json<Row>(wb.Sheets[wb.SheetNames[0]], { defval: null });
  const out: Parsed[] = [];
  for (const r of rows) {
    const company = pick(r, 'company', 'company_name', 'name');
    const email = lc(pick(r, 'email', 'email_address'));
    const domain = domainOf(r);
    if (!company && !email && !domain) continue; // not a lead row
    const arm = typeof spec.arm === 'string'
      ? spec.arm
      : (pick(r, spec.arm.col) ?? spec.arm.fallback).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    const geo = spec.geo ?? (spec.geoCol ? lc(pick(r, spec.geoCol)) ?? null : null);
    const reason = pick(r, 'why_good_for_8x', 'why_fit', 'why_selected', 'why_benefit', 'reason', 'classifier_reasoning', 'haiku_reason', 'classification_reason');
    const fit = fitOf(r);
    const score = scoreOf(r);
    out.push({
      lead: {
        source_arm: arm || 'imported',
        company, domain, email,
        email_status: lc(pick(r, 'email_status', 'email_source')) ?? (email ? 'unverified' : 'needs_lookup'),
        contact_name: pick(r, 'contact_name', 'contact', 'market_facing_contact', 'first_name'),
        contact_title: pick(r, 'contact_title', 'title'),
        category: pick(r, 'category', 'vertical', 'industry'),
        hq: pick(r, 'hq', 'hq_city', 'city'),
        geo,
        // Only a real URL belongs here — research text (paid_social_evidence) goes in raw_payload.
        signal_source_url: (() => { const u = pick(r, 'signal_source_url', 'signal_source'); return u && /^https?:\/\//i.test(u) ? u : null; })(),
        enriched_at: null, // imported, not enriched by us — never claim a fake enrichment timestamp
        raw_payload: { list: spec.list, tier: pick(r, 'tier'), stage: pick(r, 'stage', 'company_stage', 'entry_stage'),
          business_model: pick(r, 'business_model', 'bm'), expansion_signal: pick(r, 'expansion_signal'),
          paid_social_evidence: pick(r, 'paid_social_evidence'),
          phone: pick(r, 'phone'), employees: pick(r, 'employees'), founded: pick(r, 'founded'), linkedin: pick(r, 'linkedin') },
      },
      cls: (fit || score != null || reason)
        ? { jaka_score: score, market_status: lc(pick(r, 'market_status')) ?? 'unknown', fit_verdict: fit, reason, model_version: `import:${spec.list}` }
        : null,
    });
  }
  return out;
}

export async function runExtraListImport() {
  const db = getLeadsDb();
  const startedAt = new Date().toISOString();

  const existing = await db.listLeadsJoined();
  const seen = new Set<string>();
  const keysOf = (l: { domain: string | null; email: string | null; company: string | null; source_arm: string }) => {
    const ks: string[] = [];
    if (l.domain || l.email) ks.push(`${l.domain ?? ''}|${l.email ?? ''}`);
    if (l.company) ks.push(`c:${l.company.toLowerCase()}|${l.source_arm}`);
    return ks;
  };
  for (const l of existing) keysOf(l).forEach((k) => seen.add(k));

  let totalParsed = 0, totalInserted = 0, totalClassified = 0;
  const armTally = new Map<string, number>();
  for (const spec of SPECS) {
    const parsed = parse(spec);
    totalParsed += parsed.length;
    const fresh: Parsed[] = [];
    for (const p of parsed) {
      const ks = keysOf(p.lead);
      if (ks.some((k) => seen.has(k))) continue;
      ks.forEach((k) => seen.add(k));
      fresh.push(p);
      armTally.set(p.lead.source_arm, (armTally.get(p.lead.source_arm) ?? 0) + 1);
    }
    const withEmail = fresh.filter((p) => p.lead.email).length;
    log.info(`import-extra ${spec.file}: ${parsed.length} parsed, ${fresh.length} new (${withEmail} w/ email), ${parsed.length - fresh.length} dup`);
    if (DRY_RUN || !fresh.length) { totalInserted += fresh.length; continue; }

    const inserted = await db.insertLeads(fresh.map((p) => p.lead));
    totalInserted += inserted;
    const all = await db.listLeadsJoined();
    const idByKey = new Map<string, string>();
    const hasCls = new Map<string, boolean>();
    for (const l of all) { keysOf(l).forEach((k) => idByKey.set(k, l.id)); hasCls.set(l.id, l.fit_verdict != null || l.reason != null); }
    const cls: NewClassification[] = [];
    for (const p of fresh) {
      if (!p.cls) continue;
      const id = keysOf(p.lead).map((k) => idByKey.get(k)).find(Boolean);
      if (!id || hasCls.get(id)) continue;
      hasCls.set(id, true);
      cls.push({ lead_id: id, ...p.cls });
    }
    totalClassified += cls.length ? await db.insertClassifications(cls) : 0;
  }

  log.info(`import-extra ${DRY_RUN ? '(DRY RUN) ' : ''}done: ${totalParsed} parsed, ${totalInserted} new leads, ${totalClassified} classified`);
  log.info('import-extra new leads by arm:', Object.fromEntries([...armTally.entries()].sort((a, b) => b[1] - a[1])));
  if (!DRY_RUN) await db.recordRun('import_extra_lists', startedAt, { input: totalParsed, output: totalInserted });
  return { parsed: totalParsed, inserted: totalInserted, classified: totalClassified, byArm: Object.fromEntries(armTally) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runExtraListImport();
}
