/**
 * fresh-leads — stage genuinely-new app leads every night.
 *
 * Takes the discovery store, drops anything already in data/used_leads.csv
 * (the master "already contacted, don't touch" suppression list), strips
 * mega-corps / portfolio developers so the book stays consumer-app ICP, and
 * writes the fresh leads to logs/fresh_leads.csv (picked up by the nightly
 * logs artifact) plus a count in the run log. Failure-isolated like the other
 * leads jobs — it never throws into the orchestrator.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { getStore } from '../lib/store.ts';
import { log } from '../lib/log.ts';

// substrings that mark a developer as too big to be ICP
const GIANTS = [
  'google', 'microsoft', 'apple', 'meta', 'amazon', 'bytedance', 'tencent',
  'disney', 'adobe', 'samsung', 'sony', 'netflix', 'paypal', 'spotify',
  'uber', 'openai', 'x corp', 'alphabet', 'yahoo', 'electronic arts',
  'zynga', 'walmart', 'target',
];

function normDomain(d: string | null | undefined): string {
  let s = (d ?? '').trim().toLowerCase();
  s = s.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  return s.includes('.') ? s : '';
}

function loadUsed(): { domains: Set<string>; names: Set<string> } {
  const domains = new Set<string>();
  const names = new Set<string>();
  try {
    const text = readFileSync(new URL('../../seed/used_leads.csv', import.meta.url), 'utf8');
    for (const line of text.split(/\r?\n/).slice(1)) {
      if (!line.trim()) continue;
      const [company, domain] = line.split(',');
      const nd = normDomain(domain);
      if (nd) domains.add(nd);
      if (company) names.add(company.trim().toLowerCase());
    }
  } catch (err) {
    log.warn('fresh_leads: used_leads.csv not readable — no suppression applied', { err: String(err) });
  }
  return { domains, names };
}

export async function runFreshLeads() {
  const apps = await getStore().listApps();
  const { domains: usedDom, names: usedName } = loadUsed();

  // a developer with many apps is a portfolio/big company, not ICP
  const devCount = new Map<string, number>();
  for (const a of apps) {
    const n = (a.developer_name ?? '').trim().toLowerCase();
    if (n) devCount.set(n, (devCount.get(n) ?? 0) + 1);
  }
  const isGiant = (name: string, dom: string) => {
    const n = name.toLowerCase().trim();
    if (GIANTS.some((g) => n.includes(g))) return true;
    if ((devCount.get(n) ?? 0) > 3) return true;
    return ['google', 'apple', 'microsoft', 'meta', 'facebook', 'amazon'].includes(dom.split('.')[0]);
  };

  const seen = new Set<string>();
  const fresh: { company: string; domain: string; category: string; app: string; first_seen: string }[] = [];
  for (const a of apps) {
    const dom = normDomain(a.developer_domain);
    const name = (a.developer_name ?? '').trim();
    if (!dom) continue;
    if (usedDom.has(dom) || usedName.has(name.toLowerCase())) continue;
    if (isGiant(name, dom)) continue;
    if (seen.has(dom)) continue;
    seen.add(dom);
    fresh.push({
      company: name,
      domain: dom,
      category: a.category ?? '',
      app: a.name ?? '',
      first_seen: (a.first_seen_at ?? '').slice(0, 10),
    });
  }
  fresh.sort((x, y) => y.first_seen.localeCompare(x.first_seen)); // newest first

  const esc = (s: string) => `"${(s ?? '').replace(/"/g, '""')}"`;
  const csv = ['company,domain,category,app,first_seen']
    .concat(fresh.map((r) => [r.company, r.domain, r.category, r.app, r.first_seen].map(esc).join(',')))
    .join('\n');
  try {
    mkdirSync(new URL('../../logs/', import.meta.url), { recursive: true });
    writeFileSync(new URL('../../logs/fresh_leads.csv', import.meta.url), csv);
  } catch (err) {
    log.warn('fresh_leads: could not write logs/fresh_leads.csv', { err: String(err) });
  }

  const top = fresh.slice(0, 10).map((r) => `${r.company} (${r.domain})`).join(', ');
  log.info(`fresh_leads: ${fresh.length} net-new ICP leads staged of ${apps.length} apps — top: ${top}`);
  return { fresh: fresh.length, apps: apps.length };
}
