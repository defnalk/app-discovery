/**
 * DEV ONLY: seed demo leads data into the LOCAL store so the leads pages can
 * be exercised without the production Supabase project. Refuses to run
 * against Supabase.
 */
import { randomUUID } from 'node:crypto';
import { getLeadsDb } from './db.ts';
import { log } from '../lib/log.ts';

const db = getLeadsDb();
if (db.backend !== 'local') {
  console.error('seed-demo refuses to run against Supabase. Set LOCAL_STORE=1.');
  process.exit(1);
}

const now = Date.now();
const iso = (daysAgo: number, salt = 0) => new Date(now - daysAgo * 86_400_000 + salt * 1000).toISOString();

const ARMS = ['new_entrant', 'lookalike', 'linkedin_hiring', 'apollo_websearch', 'app_discovery'];
const GEOS = ['in', 'tr', 'br', 'mx'];

// Volume leads for the lookalike arm so suggestion_engine has signal:
// tier A (score 8.5): 120 sends, 7 replies → 5.8% | tier B (score 6.5): 110 sends, 7 replies → 6.4%
const leads = [];
for (let i = 0; i < 230; i++) {
  const tierA = i < 120;
  leads.push({
    source_arm: 'lookalike',
    company: `DemoCo ${i}`,
    domain: `demo${i}.example.com`,
    email: `growth@demo${i}.example.com`,
    email_status: 'verified',
    contact_name: `Contact ${i}`,
    contact_title: 'Head of Growth',
    category: tierA ? 'Consumer Fintech' : 'Health & Fitness',
    hq: 'Bengaluru, India',
    geo: GEOS[i % GEOS.length],
    signal_source_url: null,
    enriched_at: iso(10),
    raw_payload: null,
    _score: tierA ? 8.5 : 6.5,
  });
}
// A few varied leads across the other arms for the table/filters.
for (const [i, arm] of ARMS.entries()) {
  leads.push({
    source_arm: arm,
    company: `${arm} sample`,
    domain: `${arm.replace(/_/g, '-')}.example.com`,
    email: `founder@${arm.replace(/_/g, '-')}.example.com`,
    email_status: i % 2 ? 'accept_all' : 'verified',
    contact_name: 'Ada Demo',
    contact_title: 'Founder',
    category: 'AI / Productivity',
    hq: 'Istanbul, Turkey',
    geo: GEOS[i % GEOS.length],
    signal_source_url: arm === 'app_discovery' ? 'https://apps.apple.com/app/id000000' : null,
    enriched_at: iso(3),
    raw_payload: null,
    _score: 7 + i * 0.3,
  });
}

await db.insertLeads(leads.map(({ _score, ...l }) => l));
const stored = await db.listLeadsJoined();
const byDomain = new Map(stored.map((l) => [l.domain, l]));

// classifications (local backend reads d.classifications directly)
const local = db as unknown as { d: { classifications: unknown[]; campaigns: unknown[]; campaign_leads: unknown[] }; save?: () => void };
for (const l of leads) {
  const row = byDomain.get(l.domain);
  if (!row) continue;
  local.d.classifications.push({
    lead_id: row.id, jaka_score: l._score,
    market_status: l.source_arm === 'new_entrant' ? 'new_entrant' : 'present_in_market',
    fit_verdict: 'fit', reason: 'Demo: consumer app, plausibly affords 10-20K/mo, growth hiring signal',
    classified_at: iso(9),
  });
}

// A pending-approval batch with 6 leads.
const batchId = randomUUID();
local.d.campaigns.push({
  id: batchId, instantly_campaign_id: 'demo-instantly-campaign', name: 'TR+IN wave 3 (demo)',
  status: 'pending_approval', approved_at: null, created_at: iso(1),
});
for (const l of stored.slice(230, 236)) {
  local.d.campaign_leads.push({ campaign_id: batchId, lead_id: l.id, instantly_lead_id: null, send_status: null });
}

// events: every lookalike lead got a sent; 7 tier-A + 7 tier-B replies; 1 meeting
const events = [];
for (const [i, l] of leads.entries()) {
  if (l.source_arm !== 'lookalike') continue;
  const row = byDomain.get(l.domain)!;
  events.push({ lead_id: row.id, campaign_id: batchId, type: 'sent', payload: null, occurred_at: iso(8, i) });
  const tierA = l._score >= 8;
  const replyIdx = tierA ? i : i - 120;
  if (replyIdx < 7) {
    events.push({ lead_id: row.id, campaign_id: batchId, type: 'reply', payload: null, occurred_at: iso(7 - (replyIdx % 5), i) });
    if (replyIdx < 2) events.push({ lead_id: row.id, campaign_id: batchId, type: 'positive_reply', payload: null, occurred_at: iso(6, i) });
    if (replyIdx === 0) events.push({ lead_id: row.id, campaign_id: batchId, type: 'meeting', payload: null, occurred_at: iso(5, i) });
  }
}
await db.upsertEvents(events);
await db.insertConfigVersion('tier_thresholds', { A: 8, B: 6 }, 'seed');
await db.insertConfigVersion('icp_exclusions', { exclude: ['pure B2B/enterprise', 'agencies', 'incumbents'], min_budget_usd: 5000 }, 'seed');

log.info(`seed-demo: ${stored.length} leads, ${events.length} events, 1 pending batch`);
