/**
 * Apollo enrichment for shortlisted apps. Resolves developer_domain, calls
 * Apollo organization enrichment, stores firmographics + one growth/marketing
 * contact, and appends qualifying companies to the existing leads pipeline
 * CSV format with source=app_discovery. NOTHING is auto-sent — a human reviews
 * leads_out/app_discovery_leads.csv before anything leaves this system.
 * Skips itself when APOLLO_API_KEY is unset.
 */
import { appendFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fetchJson } from '../lib/http.ts';
import { log } from '../lib/log.ts';
import { getStore } from '../lib/store.ts';
import { getLeadsDb, type NewLead } from '../leads/db.ts';

const APOLLO_BASE = 'https://api.apollo.io/api/v1';
// Existing pipeline schema (matches india/turkey cold-call lists) + provenance.
const LEAD_COLUMNS = [
  'company', 'category', 'description', 'why_benefit', 'ugc', 'contact_name', 'title',
  'email', 'email_status', 'phone', 'phone_flag', 'website', 'city', 'employees',
  'founded', 'domain', 'linkedin', 'source',
] as const;

type ApolloOrg = {
  id?: string; name?: string; website_url?: string; linkedin_url?: string;
  city?: string; country?: string; estimated_num_employees?: number;
  founded_year?: number; latest_funding_stage?: string; phone?: string;
};

const csvEscape = (v: unknown) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export async function runApolloEnrichment() {
  const store = getStore();
  const startedAt = new Date().toISOString();
  const apiKey = process.env.APOLLO_API_KEY;
  if (!apiKey) {
    log.warn('apollo: APOLLO_API_KEY not set, skipping enrichment');
    await store.recordRun('apollo', startedAt, true, { skipped: 'no APOLLO_API_KEY' });
    return { skipped: true };
  }

  const [apps, rollups, companies] = await Promise.all([
    store.listApps(), store.listRollups(), store.listCompanies(),
  ]);
  const appById = new Map(apps.map((a) => [a.id, a]));
  const alreadyEnriched = new Set(companies.filter((c) => c.enriched_at).map((c) => c.app_id));

  const targets = rollups
    .filter((r) => r.shortlisted && !alreadyEnriched.has(r.app_id))
    .map((r) => ({ rollup: r, app: appById.get(r.app_id)! }))
    .filter((t) => t.app?.developer_domain)
    .slice(0, 50); // batch cap per night, keeps Apollo credit burn bounded

  const leadsFile = path.join(process.cwd(), 'leads_out', 'app_discovery_leads.csv');
  mkdirSync(path.dirname(leadsFile), { recursive: true });
  if (!existsSync(leadsFile)) writeFileSync(leadsFile, LEAD_COLUMNS.join(',') + '\n');

  let enriched = 0, leads = 0;
  const pipelineLeads: NewLead[] = [];
  for (const { app, rollup } of targets) {
    try {
      const org = (await fetchJson<{ organization?: ApolloOrg }>(
        `${APOLLO_BASE}/organizations/enrich?domain=${encodeURIComponent(app.developer_domain!)}`,
        { service: 'apollo', minGapMs: 1500, init: { headers: { 'x-api-key': apiKey } } },
      )).organization;
      if (!org?.id) { log.warn(`apollo: no org for ${app.developer_domain}`); continue; }

      // One growth/marketing contact via people search.
      let contact: { name?: string; title?: string; email?: string; email_status?: string } = {};
      try {
        const people = await fetchJson<{ people?: { name?: string; title?: string; email?: string; email_status?: string }[] }>(
          `${APOLLO_BASE}/mixed_people/api_search`,
          {
            service: 'apollo', minGapMs: 1500,
            init: {
              method: 'POST',
              headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
              body: JSON.stringify({
                organization_ids: [org.id],
                person_titles: ['growth', 'marketing', 'user acquisition', 'performance marketing'],
                per_page: 1,
              }),
            },
          },
        );
        contact = people.people?.[0] ?? {};
      } catch (err) {
        log.warn(`apollo: people search failed for ${app.developer_domain}`, { err: String(err) });
      }

      await store.upsertCompany({
        app_id: app.id,
        apollo_org_id: org.id ?? null,
        hq: [org.city, org.country].filter(Boolean).join(', ') || null,
        stage: org.latest_funding_stage ?? null,
        employee_count: org.estimated_num_employees ?? null,
        contact_name: contact.name ?? null,
        contact_email: contact.email ?? null,
        enriched_at: new Date().toISOString(),
      });
      enriched++;

      // Qualify: has a domain and isn't a giant. Append to the lead pipeline CSV.
      if ((org.estimated_num_employees ?? 0) <= 1000) {
        const row = {
          company: org.name ?? app.developer_name ?? app.name,
          category: app.category ?? '',
          description: (app.description ?? '').slice(0, 200),
          why_benefit: `App "${app.name}" trending on ${app.store} charts — growth team likely buying creative`,
          ugc: 'Category-typical',
          contact_name: contact.name ?? '',
          title: contact.title ?? '',
          email: contact.email ?? '',
          email_status: contact.email_status ?? '',
          phone: org.phone ?? '',
          phone_flag: '',
          website: org.website_url ?? `https://${app.developer_domain}`,
          city: org.city ?? '',
          employees: org.estimated_num_employees ?? '',
          founded: org.founded_year ?? '',
          domain: app.developer_domain,
          linkedin: org.linkedin_url ?? '',
          source: 'app_discovery',
        };
        appendFileSync(leadsFile, LEAD_COLUMNS.map((c) => csvEscape(row[c])).join(',') + '\n');
        leads++;
        // Same lead into the unified pipeline; flows through the identical approval gate.
        pipelineLeads.push({
          source_arm: 'app_discovery',
          company: row.company,
          domain: app.developer_domain,
          email: contact.email ?? null,
          email_status: contact.email_status ?? null,
          contact_name: contact.name ?? null,
          contact_title: contact.title ?? null,
          category: app.category,
          hq: [org.city, org.country].filter(Boolean).join(', ') || null,
          geo: rollup.geos_live[0] ?? null,
          signal_source_url: app.store === 'apple'
            ? `https://apps.apple.com/app/id${app.store_id}`
            : `https://play.google.com/store/apps/details?id=${app.store_id}`,
          enriched_at: new Date().toISOString(),
          raw_payload: { apollo_org_id: org.id, momentum_score: rollup.momentum_score, geos_live: rollup.geos_live },
        });
      }
    } catch (err) {
      log.error(`apollo enrich failed: ${app.developer_domain}`, { err: String(err) });
    }
  }

  const pipelined = pipelineLeads.length ? await getLeadsDb().insertLeads(pipelineLeads) : 0;
  await store.recordRun('apollo', startedAt, true, { enriched, leads, pipelined });
  log.info(`apollo: ${enriched} enriched, ${leads} leads appended, ${pipelined} into pipeline (human review required before send)`);
  return { enriched, leads, pipelined };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runApolloEnrichment().then((r) => log.info('apollo enrichment done', r));
}
