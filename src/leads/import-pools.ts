/**
 * Market-pool lead sourcing (per 2026-06-12 meeting):
 *  1. Import the vetted Turkey (729) and India (1,003) consumer-app lists from
 *     ~/Downloads as source_arm=market_pool, geo-tagged.
 *  2. Generate app_discovery leads from the engine for the pool markets:
 *     locally-charting apps + expansion candidates (geo-gap) with developer domains.
 * Idempotent on (domain|email) and (company|arm) like the other importers.
 */
import XLSX from 'xlsx';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { log } from '../lib/log.ts';
import { getStore } from '../lib/store.ts';
import { getLeadsDb, type NewLead, type NewClassification } from './db.ts';

const DOWNLOADS = process.env.LEADS_DIR ?? path.join(process.env.HOME ?? '', 'Downloads');
const POOLS = ['in', 'br', 'tr', 'id', 'mx'];
const str = (v: unknown): string | null => (v == null || v === '' ? null : String(v).trim());

type Row = Record<string, unknown>;
type Parsed = { lead: NewLead; cls: Omit<NewClassification, 'lead_id'> | null };

function parsePoolList(file: string, geo: string, listName: string): Parsed[] {
  const full = path.join(DOWNLOADS, file);
  if (!existsSync(full)) { log.warn(`import-pools: ${file} not found`); return []; }
  const wb = XLSX.readFile(full);
  const rows = XLSX.utils.sheet_to_json<Row>(wb.Sheets[wb.SheetNames[0]], { defval: null });
  return rows.filter((r) => str(r.company)).map((r) => ({
    lead: {
      source_arm: 'market_pool',
      company: str(r.company),
      domain: str(r.domain)?.toLowerCase() ?? null,
      email: str(r.email)?.toLowerCase() ?? null,
      email_status: str(r.email_status)?.toLowerCase() ?? null,
      contact_name: str(r.contact_name),
      contact_title: str(r.title),
      category: str(r.category),
      hq: [str(r.city), str(r.state)].filter(Boolean).join(', ') || null,
      geo,
      signal_source_url: null,
      enriched_at: str(r.email) ? new Date().toISOString() : null,
      raw_payload: {
        list: listName, phone: str(r.phone), phone_flag: str(r.phone_flag ?? r.email_flag),
        why_benefit: str(r.why_benefit), ugc: str(r.ugc), employees: str(r.employees),
        founded: str(r.founded), linkedin: str(r.linkedin), website: str(r.website),
      },
    },
    // Lists were LLM-vetted as consumer-app ICP during the original projects.
    cls: {
      jaka_score: null, market_status: 'present_in_market', fit_verdict: 'fit',
      reason: str(r.why_benefit) ?? str(r.description) ?? `vetted ${listName} consumer app`,
      model_version: 'import:vetted-list',
    },
  }));
}

async function appDiscoveryPoolLeads(): Promise<Parsed[]> {
  const store = getStore();
  const [apps, rollups] = await Promise.all([store.listApps(), store.listRollups()]);
  const appById = new Map(apps.map((a) => [a.id, a]));
  const out: Parsed[] = [];
  const candidates = rollups
    .filter((r) => !r.is_incumbent && (r.momentum_score ?? 0) >= 0.4)
    .map((r) => ({ r, app: appById.get(r.app_id)! }))
    .filter(({ app }) => app && app.status === 'active' && app.developer_domain)
    .sort((a, b) => (b.r.momentum_score ?? 0) - (a.r.momentum_score ?? 0));

  const seenDomains = new Set<string>();
  let local = 0, expansion = 0;
  for (const { r, app } of candidates) {
    if (seenDomains.has(app.developer_domain!)) continue;
    const liveInPool = POOLS.find((p) => r.geos_live.includes(p));
    const gapPool = (r.geo_gap ?? [])[0];
    const mode = liveInPool ? 'local_charting' : gapPool ? 'expanding_into' : null;
    if (!mode) continue;
    if (mode === 'local_charting' && local >= 150) continue;
    if (mode === 'expanding_into' && expansion >= 100) continue;
    seenDomains.add(app.developer_domain!);
    mode === 'local_charting' ? local++ : expansion++;
    out.push({
      lead: {
        source_arm: 'app_discovery',
        company: app.developer_name ?? app.name,
        domain: app.developer_domain,
        email: null, // pattern-email + MX verification pass comes next
        email_status: 'needs_lookup',
        contact_name: null,
        contact_title: null,
        category: app.category,
        hq: null,
        geo: liveInPool ?? gapPool!,
        signal_source_url: app.store === 'apple'
          ? `https://apps.apple.com/app/id${app.store_id}`
          : `https://play.google.com/store/apps/details?id=${app.store_id}`,
        enriched_at: null,
        raw_payload: {
          app_name: app.name, mode, momentum_score: r.momentum_score,
          geos_live: r.geos_live, geo_gap: r.geo_gap, best_rank: r.best_rank,
        },
      },
      cls: null,
    });
  }
  log.info(`import-pools: engine generated ${local} local-charting + ${expansion} expansion leads`);
  return out;
}

export async function runPoolImport() {
  const db = getLeadsDb();
  const startedAt = new Date().toISOString();
  const sets: { name: string; parsed: Parsed[] }[] = [
    { name: 'turkey_list', parsed: parsePoolList('turkey_coldcall_COMBINED.csv', 'tr', 'turkey_coldcall_COMBINED') },
    { name: 'india_list', parsed: parsePoolList('india_coldcall_list_FINAL.csv', 'in', 'india_coldcall_FINAL') },
    { name: 'app_discovery_pools', parsed: await appDiscoveryPoolLeads() },
  ];

  const existing = await db.listLeadsJoined();
  const seen = new Set<string>();
  const keysOf = (l: { domain: string | null; email: string | null; company: string | null; source_arm: string }) => {
    const ks: string[] = [];
    if (l.domain || l.email) ks.push(`${l.domain ?? ''}|${l.email ?? ''}`);
    if (l.company) ks.push(`c:${l.company.toLowerCase()}|${l.source_arm}`);
    return ks;
  };
  for (const l of existing) keysOf(l).forEach((k) => seen.add(k));

  for (const set of sets) {
    const fresh: Parsed[] = [];
    for (const p of set.parsed) {
      const ks = keysOf(p.lead);
      if (ks.some((k) => seen.has(k))) continue;
      ks.forEach((k) => seen.add(k));
      fresh.push(p);
    }
    const inserted = fresh.length ? await db.insertLeads(fresh.map((p) => p.lead)) : 0;

    const all = await db.listLeadsJoined();
    const idByKey = new Map<string, string>();
    const hasCls = new Map<string, boolean>();
    for (const l of all) {
      keysOf(l).forEach((k) => idByKey.set(k, l.id));
      hasCls.set(l.id, l.fit_verdict != null || l.reason != null);
    }
    const cls: NewClassification[] = [];
    for (const p of set.parsed) {
      if (!p.cls) continue;
      const id = keysOf(p.lead).map((k) => idByKey.get(k)).find(Boolean);
      if (!id || hasCls.get(id)) continue;
      hasCls.set(id, true);
      cls.push({ lead_id: id, ...p.cls });
    }
    const classified = cls.length ? await db.insertClassifications(cls) : 0;
    log.info(`import-pools ${set.name}: ${set.parsed.length} parsed, ${inserted} inserted, ${classified} classified, ${set.parsed.length - fresh.length} skipped`);
  }
  await db.recordRun('import_pools', startedAt, { input: sets.reduce((s, x) => s + x.parsed.length, 0) });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runPoolImport();
}
