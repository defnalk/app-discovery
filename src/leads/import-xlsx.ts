/**
 * One-shot importer for the four lead-list spreadsheet exports in ~/Downloads,
 * mapping each to its strategy arm:
 *   apollo_outreach_ranked  → apollo_websearch
 *   net_new_entrants        → new_entrant
 *   lookalikes_8x_final     → lookalike
 *   linkedin_hiring_leads   → linkedin_hiring
 * Idempotent: existing (domain|email) or (company|arm) leads are skipped, and
 * classifications are only written for newly inserted leads. Safe to rerun,
 * including once against LOCAL_STORE and again against Supabase.
 */
import XLSX from 'xlsx';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { log } from '../lib/log.ts';
import { getLeadsDb, type NewLead, type NewClassification } from './db.ts';

const DOWNLOADS = process.env.LEADS_DIR ?? path.join(process.env.HOME ?? '', 'Downloads');

const GEO_BY_COUNTRY: Record<string, string> = {
  'india': 'in', 'brazil': 'br', 'turkey': 'tr', 'türkiye': 'tr', 'indonesia': 'id',
  'mexico': 'mx', 'united states': 'us', 'usa': 'us', 'united kingdom': 'gb', 'uk': 'gb',
  'germany': 'de', 'france': 'fr',
};
const geoOf = (country: string | null | undefined): string | null =>
  country ? GEO_BY_COUNTRY[country.trim().toLowerCase()] ?? null : null;

/** Last comma-segment of an hq string is usually the country. */
const geoFromHq = (hq: string | null | undefined): string | null =>
  geoOf(hq?.split(',').pop());

const GENERIC_MAIL = /gmail|yahoo|hotmail|outlook|icloud|proton/;
function domainOf(website: string | null | undefined, email: string | null | undefined): string | null {
  if (website) {
    try { return new URL(website.includes('://') ? website : `https://${website}`).hostname.replace(/^www\./, '').toLowerCase(); } catch { /* fall through */ }
  }
  const mailDomain = email?.split('@')[1]?.toLowerCase();
  return mailDomain && !GENERIC_MAIL.test(mailDomain) ? mailDomain : null;
}

const firstUrl = (s: string | null | undefined): string | null => s?.match(/https?:\/\/\S+/)?.[0] ?? null;
const str = (v: unknown): string | null => (v == null || v === '' ? null : String(v).trim());

type Parsed = { lead: NewLead; cls: Omit<NewClassification, 'lead_id'> | null };
type Row = Record<string, unknown>;

function sheetRows(file: string, sheet: string, skipBanner = false): Row[] {
  const wb = XLSX.readFile(path.join(DOWNLOADS, file));
  const ws = wb.Sheets[sheet];
  if (!ws) { log.warn(`import: sheet "${sheet}" missing in ${file}`); return []; }
  return XLSX.utils.sheet_to_json<Row>(ws, { defval: null, range: skipBanner ? 1 : 0 });
}

// ---------------------------------------------------------------- per-file parsers
function parseApollo(file: string): Parsed[] {
  return sheetRows(file, 'Ranked Outreach', true).filter((r) => str(r.company)).map((r) => {
    const band = str(r.band) ?? '';
    const researched = str(r.confidence) === 'researched';
    const fit = band === 'Disqualified' ? 'exclude' : researched && /fit/i.test(band) ? 'fit' : null;
    return {
      lead: {
        source_arm: 'apollo_websearch',
        company: str(r.company),
        domain: domainOf(str(r.website), str(r.email)),
        email: str(r.email)?.toLowerCase() ?? null,
        email_status: str(r.email_status)?.toLowerCase() ?? null,
        contact_name: str(r.contact_name),
        contact_title: str(r.contact_title),
        category: str(r.industry),
        hq: [str(r.city), str(r.country)].filter(Boolean).join(', ') || null,
        geo: geoOf(str(r.country)),
        signal_source_url: null,
        enriched_at: str(r.email) ? new Date().toISOString() : null,
        raw_payload: { apollo_id: str(r.apollo_id), rank: r.rank, band, confidence: str(r.confidence), employees: str(r.employees) },
      },
      cls: {
        jaka_score: typeof r.score === 'number' ? Math.round(r.score) / 10 : null,
        market_status: null,
        fit_verdict: fit,
        reason: str(r['why (score basis)']),
        model_version: researched ? 'import:researched' : 'import:heuristic',
      },
    };
  });
}

function parseNewEntrants(file: string): Parsed[] {
  const out: Parsed[] = [];
  for (const [sheet, hasEmail] of [['NEW entrants - send ready (41)', true], ['NEW entrants - need email (20)', false]] as const) {
    for (const r of sheetRows(file, sheet)) {
      if (!str(r.Company)) continue;
      const email = hasEmail ? str(r.Email)?.toLowerCase() ?? null : null;
      out.push({
        lead: {
          source_arm: 'new_entrant',
          company: str(r.Company),
          domain: domainOf(null, email),
          email,
          email_status: hasEmail ? (str(r.Confidence)?.toLowerCase() === 'high' ? 'verified' : 'unverified') : null,
          contact_name: str(r.Contact),
          contact_title: str(r.Title),
          category: null,
          hq: str(r.HQ),
          geo: geoOf(str(r['Target geo'])),
          signal_source_url: firstUrl(str(r['Signal source'])),
          enriched_at: null,
          raw_payload: { expansion_signal: str(r['Expansion signal (NEW evidence)']), email_source: str(r['Email source']) },
        },
        // market_status new_entrant is backed by the dated entry evidence in the sheet.
        cls: { jaka_score: null, market_status: 'new_entrant', fit_verdict: 'fit', reason: str(r['Expansion signal (NEW evidence)']), model_version: 'import:researched' },
      });
    }
  }
  for (const r of sheetRows(file, 'Original clean sendable (26)')) {
    if (!str(r.Company)) continue;
    const email = str(r.Email)?.toLowerCase() ?? null;
    out.push({
      lead: {
        source_arm: 'new_entrant', company: str(r.Company), domain: domainOf(null, email),
        email, email_status: 'verified', contact_name: null, contact_title: str(r.Title),
        category: null, hq: null, geo: null, signal_source_url: null, enriched_at: null, raw_payload: null,
      },
      cls: { jaka_score: null, market_status: str(r['Market status']), fit_verdict: 'fit', reason: str(r.Reason), model_version: 'import:researched' },
    });
  }
  return out;
}

function parseLookalikes(file: string): Parsed[] {
  const parse = (sheet: string, sendReady: boolean): Parsed[] =>
    sheetRows(file, sheet).filter((r) => str(r.Company)).map((r) => ({
      lead: {
        source_arm: 'lookalike',
        company: str(r.Company),
        domain: str(r.Domain)?.toLowerCase() ?? domainOf(null, str(r.Email)),
        email: str(r.Email)?.toLowerCase() ?? null,
        email_status: str(r.Email) ? (str(r.Confidence)?.toLowerCase() === 'high' ? 'verified' : 'unverified') : null,
        contact_name: str(r.Contact),
        contact_title: str(r.Title),
        category: str(r.Category),
        hq: str(r.Country),
        geo: geoOf(str(r.Country)),
        signal_source_url: null,
        enriched_at: null,
        raw_payload: { founded: r.Founded ?? null, business_model: str(r['Business model']), why_selected: str(r['Why selected']), email_source: str(r['Email source']) },
      },
      cls: sendReady
        ? { jaka_score: null, market_status: null, fit_verdict: 'fit', reason: str(r['Classifier reasoning']), model_version: 'import:classifier' }
        : { jaka_score: null, market_status: null, fit_verdict: null, reason: str(r['Classifier reasoning']), model_version: 'import:classifier' },
    }));
  // send-ready first so the dedup pass keeps the fit verdict for the overlap
  return [...parse('Send-ready (285)', true), ...parse('All selected (489)', false)];
}

function parseLinkedinHiring(file: string): Parsed[] {
  return sheetRows(file, 'LinkedIn Hiring Leads', true).filter((r) => str(r.company)).map((r) => {
    const incumbent = str(r.is_incumbent)?.toLowerCase() === 'yes';
    return {
      lead: {
        source_arm: 'linkedin_hiring',
        company: str(r.company),
        domain: str(r.domain)?.toLowerCase() ?? domainOf(null, str(r.email)),
        email: str(r.email)?.toLowerCase() ?? null,
        email_status: str(r.email_status)?.toLowerCase() ?? null,
        contact_name: str(r.contact_name),
        contact_title: str(r.contact_title),
        category: str(r.industry),
        hq: str(r.hq),
        geo: geoFromHq(str(r.hq)),
        signal_source_url: null,
        // hiring proves hiring, not market entry: signal stays in raw_payload, never market_status
        enriched_at: null,
        raw_payload: { hiring_signal: str(r.hiring_signal), is_incumbent: incumbent },
      },
      cls: incumbent
        ? { jaka_score: null, market_status: null, fit_verdict: 'exclude', reason: 'incumbent mega-brand (file flag)', model_version: 'import:flag' }
        : null,
    };
  });
}

// ---------------------------------------------------------------- main
const FILES: { file: string; parse: (f: string) => Parsed[] }[] = [
  { file: 'apollo_outreach_ranked (2).xlsx', parse: parseApollo },
  { file: 'net_new_entrants (3).xlsx', parse: parseNewEntrants },
  { file: 'lookalikes_8x_final copy (3).xlsx', parse: parseLookalikes },
  { file: 'linkedin_hiring_leads (3).xlsx', parse: parseLinkedinHiring },
];

export async function runImport() {
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

  const summary: Record<string, { parsed: number; inserted: number; classified: number; skipped: number }> = {};
  for (const { file, parse } of FILES) {
    if (!existsSync(path.join(DOWNLOADS, file))) {
      log.warn(`import: ${file} not found in ${DOWNLOADS}, skipping`);
      continue;
    }
    const parsed = parse(file);
    const fresh: Parsed[] = [];
    for (const p of parsed) {
      const ks = keysOf(p.lead);
      if (ks.some((k) => seen.has(k))) continue;
      ks.forEach((k) => seen.add(k));
      fresh.push(p);
    }
    const inserted = fresh.length ? await db.insertLeads(fresh.map((p) => p.lead)) : 0;

    // Classifications for any parsed lead that exists but has none yet — this
    // backfills after partial runs and stays idempotent (classified leads skip).
    const all = await db.listLeadsJoined();
    const idByKey = new Map<string, string>();
    const hasCls = new Map<string, boolean>();
    for (const l of all) {
      keysOf(l).forEach((k) => idByKey.set(k, l.id));
      hasCls.set(l.id, l.fit_verdict != null || l.reason != null || l.jaka_score != null || l.market_status != null);
    }
    const cls: NewClassification[] = [];
    for (const p of parsed) {
      if (!p.cls) continue;
      const id = keysOf(p.lead).map((k) => idByKey.get(k)).find(Boolean);
      if (!id || hasCls.get(id)) continue;
      hasCls.set(id, true);
      cls.push({ lead_id: id, ...p.cls });
    }
    const classified = cls.length ? await db.insertClassifications(cls) : 0;

    const arm = parsed[0]?.lead.source_arm ?? file;
    summary[arm] = { parsed: parsed.length, inserted, classified, skipped: parsed.length - fresh.length };
    log.info(`import ${arm}: ${parsed.length} parsed, ${inserted} inserted, ${classified} classified, ${parsed.length - fresh.length} skipped as existing`);
  }

  await db.recordRun('import_xlsx', startedAt, {
    input: Object.values(summary).reduce((a, s) => a + s.parsed, 0),
    output: Object.values(summary).reduce((a, s) => a + s.inserted, 0),
  }, JSON.stringify(summary));
  return summary;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runImport().then((s) => log.info('import done', { summary: s }));
}
