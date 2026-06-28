/**
 * Leads nightly jobs — independent of the apps discovery jobs, failure isolated
 * by the orchestrator:
 *  1. instantly_sync   — pull campaign emails/analytics into events (idempotent)
 *  2. funnel_rollup    — materialize stage counts + per-lead stage
 *  3. suggestion_engine— compute threshold suggestions, write pending rows.
 *     It NEVER edits config; humans resolve suggestions on the Settings page.
 */
import { log } from '../lib/log.ts';
import { getLeadsDb, type EventRow, type LeadJoined } from './db.ts';
import { instantlyEnabled, listEmails, campaignAnalytics } from './instantly.ts';
import { runSignalRefresh } from './signals.ts';
import { runCull } from './cull-non-apps.ts';
import { runFreshLeads } from './fresh-leads.ts';

const DAY = 86_400_000;

// ---------------------------------------------------------------- helpers
export const DEFAULT_TIERS = { A: 8, B: 6 }; // jaka_score >= A → tier A, >= B → tier B, else C

export function tierOf(score: number | null, tiers: { A: number; B: number } = DEFAULT_TIERS): string {
  if (score == null) return '–';
  return score >= tiers.A ? 'A' : score >= tiers.B ? 'B' : 'C';
}

const QUALIFIED_VERDICTS = new Set(['fit', 'qualified', 'yes', 'icp_fit', 'include']);
export const isQualified = (l: LeadJoined) =>
  l.fit_verdict != null && QUALIFIED_VERDICTS.has(l.fit_verdict.toLowerCase());

// ---------------------------------------------------------------- 1. instantly_sync
export async function runInstantlySync() {
  const db = getLeadsDb();
  const startedAt = new Date().toISOString();
  if (!instantlyEnabled()) {
    log.warn('instantly_sync: INSTANTLY_API_KEY not set, skipping');
    await db.recordRun('instantly_sync', startedAt, {}, 'skipped: no INSTANTLY_API_KEY');
    return { skipped: true };
  }

  const campaigns = (await db.listCampaigns()).filter((c) => c.instantly_campaign_id);
  const leads = await db.listLeadsJoined();
  const leadByEmail = new Map(leads.filter((l) => l.email).map((l) => [l.email!.toLowerCase(), l]));

  let eventsUpserted = 0, errors = 0;
  for (const campaign of campaigns) {
    try {
      const emails = await listEmails(campaign.instantly_campaign_id!);
      const events: EventRow[] = [];
      for (const e of emails) {
        const leadEmail = (e.email_type === 'received' || e.ue_type === 2 ? e.from_address_email : e.to_address_email_list ?? e.lead) ?? '';
        const lead = leadByEmail.get(leadEmail.toLowerCase().split(',')[0]);
        if (!lead) continue;
        const occurredAt = e.timestamp_email ?? e.timestamp_created ?? startedAt;
        const isReply = e.email_type === 'received' || e.ue_type === 2;
        events.push({
          lead_id: lead.id, campaign_id: campaign.id,
          type: isReply ? 'reply' : 'sent',
          payload: { instantly_email_id: e.id, ai_interest_value: e.ai_interest_value ?? null },
          occurred_at: occurredAt,
        });
        // Instantly's interest score >= 0.75 counts as a positive reply.
        if (isReply && (e.ai_interest_value ?? 0) >= 0.75) {
          events.push({ lead_id: lead.id, campaign_id: campaign.id, type: 'positive_reply', payload: { instantly_email_id: e.id }, occurred_at: occurredAt });
        }
      }
      eventsUpserted += await db.upsertEvents(events);
      const analytics = await campaignAnalytics(campaign.instantly_campaign_id!).catch(() => null);
      log.info(`instantly_sync: campaign ${campaign.name}: ${events.length} events`, { analytics: analytics ?? undefined });
    } catch (err) {
      errors++;
      log.error(`instantly_sync failed for campaign ${campaign.name}`, { err: String(err) });
    }
  }
  await db.recordRun('instantly_sync', startedAt, { input: campaigns.length, output: eventsUpserted, errors });
  return { campaigns: campaigns.length, events: eventsUpserted, errors };
}

// ---------------------------------------------------------------- 2. funnel_rollup
export async function runFunnelRollup() {
  const db = getLeadsDb();
  const startedAt = new Date().toISOString();
  const [leads, campaignLeads, events] = await Promise.all([
    db.listLeadsJoined(), db.listCampaignLeads(), db.listEvents(),
  ]);

  const pushed = new Set(campaignLeads.map((c) => c.lead_id));
  const byType = (t: string) => new Set(events.filter((e) => e.type === t).map((e) => e.lead_id));
  const sent = byType('sent');
  const replied = new Set([...byType('reply'), ...byType('positive_reply')]);
  const meeting = byType('meeting');

  const stageOf = (l: LeadJoined): string => {
    if (meeting.has(l.id)) return 'meeting';
    if (replied.has(l.id)) return 'replied';
    if (sent.has(l.id)) return 'sent';
    if (pushed.has(l.id)) return 'pushed';
    if (isQualified(l) && l.email && (l.email_status ?? '').toLowerCase() === 'verified') return 'sendable';
    if (isQualified(l)) return 'icp_qualified';
    return 'raw';
  };

  const stages = new Map<string, string>();
  const counts = new Map<string, number>(); // `${stage}|${arm}|${geo}`
  const bump = (stage: string, arm: string, geo: string) => {
    for (const k of [`${stage}|*|*`, `${stage}|${arm}|*`, `${stage}|*|${geo}`, `${stage}|${arm}|${geo}`]) {
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  };
  for (const l of leads) {
    const stage = stageOf(l);
    if (l.stage !== stage) stages.set(l.id, stage);
    bump(stage, l.source_arm, l.geo ?? 'unknown');
  }

  await db.updateLeadStages(stages);
  await db.replaceFunnelRollups([...counts.entries()].map(([k, count]) => {
    const [stage, source_arm, geo] = k.split('|');
    return { stage, source_arm, geo, count, computed_at: startedAt };
  }));
  await db.recordRun('funnel_rollup', startedAt, { input: leads.length, output: counts.size });
  log.info(`funnel_rollup: ${leads.length} leads, ${stages.size} stage changes`);
  return { leads: leads.length, changed: stages.size };
}

// ---------------------------------------------------------------- 3. suggestion_engine
export async function runSuggestionEngine() {
  const db = getLeadsDb();
  const startedAt = new Date().toISOString();
  const [leads, events, config] = await Promise.all([db.listLeadsJoined(), db.listEvents(), db.listActiveConfig()]);
  const tiers = (config.find((c) => c.key === 'tier_thresholds')?.value as { A: number; B: number } | undefined) ?? DEFAULT_TIERS;

  // reply rate per arm x tier
  const leadById = new Map(leads.map((l) => [l.id, l]));
  const stats = new Map<string, { sends: number; replies: number }>(); // `${arm}|${tier}`
  for (const e of events) {
    if (!e.lead_id) continue;
    const l = leadById.get(e.lead_id);
    if (!l) continue;
    const k = `${l.source_arm}|${tierOf(l.jaka_score, tiers)}`;
    const s = stats.get(k) ?? { sends: 0, replies: 0 };
    if (e.type === 'sent') s.sends++;
    if (e.type === 'reply' || e.type === 'positive_reply') s.replies++;
    stats.set(k, s);
  }

  let written = 0;
  const arms = new Set(leads.map((l) => l.source_arm));
  for (const arm of arms) {
    const a = stats.get(`${arm}|A`);
    const b = stats.get(`${arm}|B`);
    if (!a || !b || a.sends < 100 || b.sends < 100) continue; // not enough signal
    const rateA = a.replies / a.sends, rateB = b.replies / b.sends;
    if (rateA > 0 && rateB >= rateA * 0.9) {
      await db.insertSuggestion({
        proposed: { setting: 'tier_thresholds', arm, change: { A: tiers.B }, current: tiers },
        rationale: `${arm} tier B converts at tier A rates (${(rateB * 100).toFixed(1)}% vs ${(rateA * 100).toFixed(1)}%) — suggest lowering the tier A cutoff from ${tiers.A} to ${tiers.B}.`,
        evidence: { arm, tierA: a, tierB: b, rateA, rateB, computed_at: startedAt },
      });
      written++;
    }
  }
  await db.recordRun('suggestion_engine', startedAt, { input: events.length, output: written });
  log.info(`suggestion_engine: ${written} suggestions queued (pending human review)`);
  return { suggestions: written };
}

// ---------------------------------------------------------------- 4. strategy_rollup
/** Recompute the delta-CRM cross-tab (lead book vs market heat) nightly. */
export async function runStrategyRollup() {
  const db = getLeadsDb();
  const startedAt = new Date().toISOString();
  const { computeStrategyData } = await import('./strategy-data.ts');
  const data = await computeStrategyData();
  await db.insertStrategySnapshot(data);
  await db.recordRun('strategy_rollup', startedAt, { output: 1 });
  log.info('strategy_rollup: delta-CRM cross-tab snapshot stored');
  return { ok: true };
}

/** Bolted onto the nightly orchestrator; same failure-isolation rules. */
export const nightlyJobs = [
  { name: 'instantly_sync', run: runInstantlySync },
  { name: 'signal_refresh', run: runSignalRefresh }, // stitch real app-traction onto leads
  { name: 'tag_icp', run: runCull }, // tag incumbents/D2C/B2B off-ICP so the book stays consumer-apps
  { name: 'funnel_rollup', run: runFunnelRollup },
  { name: 'suggestion_engine', run: runSuggestionEngine },
  { name: 'strategy_rollup', run: runStrategyRollup },
  { name: 'fresh_leads', run: runFreshLeads }, // dedup fresh apps vs used list, stage net-new ICP leads
];
