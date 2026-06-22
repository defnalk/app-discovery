/**
 * Instantly v2 API client — rate limited, retried with backoff (via fetchJson).
 * HARD RULE: this module contains NO endpoint that starts, resumes, schedules,
 * or activates sending. Pushing leads adds them to an existing campaign only;
 * campaign activation is a human action inside Instantly itself.
 */
import { fetchJson } from '../lib/http.ts';

const BASE = 'https://api.instantly.ai/api/v2';

function headers() {
  const key = process.env.INSTANTLY_API_KEY;
  if (!key) throw new Error('INSTANTLY_API_KEY not set');
  return { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
}

export const instantlyEnabled = () => Boolean(process.env.INSTANTLY_API_KEY);

export type InstantlyEmail = {
  id: string;
  campaign_id?: string;
  lead?: string; // lead email address
  to_address_email_list?: string;
  from_address_email?: string;
  email_type?: string; // 'sent' | 'received' (ue_type 1/2 in some responses)
  ue_type?: number;
  timestamp_email?: string;
  timestamp_created?: string;
  ai_interest_value?: number; // 0..1 positive-intent score when available
};

/** Paginated list of emails (sent + received) for a campaign. */
export async function listEmails(campaignId: string, limit = 100): Promise<InstantlyEmail[]> {
  const out: InstantlyEmail[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < 50; page++) {
    const qs = new URLSearchParams({ campaign_id: campaignId, limit: String(limit) });
    if (startingAfter) qs.set('starting_after', startingAfter);
    const res = await fetchJson<{ items?: InstantlyEmail[]; next_starting_after?: string }>(
      `${BASE}/emails?${qs}`, { service: 'instantly', minGapMs: 600, init: { headers: headers() } },
    );
    out.push(...(res.items ?? []));
    if (!res.next_starting_after || !res.items?.length) break;
    startingAfter = res.next_starting_after;
  }
  return out;
}

/** Campaign-level analytics (sent/opens/replies counters). */
export async function campaignAnalytics(campaignId: string): Promise<Record<string, unknown> | null> {
  const res = await fetchJson<Record<string, unknown>[] | Record<string, unknown>>(
    `${BASE}/campaigns/analytics?id=${encodeURIComponent(campaignId)}`,
    { service: 'instantly', minGapMs: 600, init: { headers: headers() } },
  );
  return Array.isArray(res) ? (res[0] ?? null) : res;
}

// ------------------------------------------------------------- read-only listings
// Everything below is GET-only and used by the Campaigns dashboard page. Per the
// HARD RULE above, none of it starts/resumes/schedules/activates sending.

export type InstantlyCampaign = {
  id: string;
  name?: string;
  status?: number; // 0 draft · 1 active · 2 paused · 3 completed · 4 subsequences · <0 issue
  timestamp_created?: string;
  timestamp_updated?: string;
};

/** Native per-campaign counters as Instantly reports them (superset; fields vary). */
export type CampaignAnalytics = {
  campaign_id?: string;
  campaign_name?: string;
  leads_count?: number;
  contacted_count?: number;
  emails_sent_count?: number;
  new_leads_contacted_count?: number;
  open_count?: number;
  open_count_unique?: number;
  reply_count?: number;
  reply_count_unique?: number;
  link_click_count?: number;
  link_click_count_unique?: number;
  bounced_count?: number;
  unsubscribed_count?: number;
  completed_count?: number;
  total_opportunities?: number;
  total_opportunity_value?: number;
  [k: string]: unknown;
};

/** Daily workspace-wide (or per-campaign) counters for the trend chart. */
export type DailyAnalytics = { date: string; sent?: number; opened?: number; replies?: number; unique_opened?: number; unique_replies?: number; clicks?: number };

/** All campaigns in the workspace (paginated). Read-only. */
export async function listCampaigns(limit = 100): Promise<InstantlyCampaign[]> {
  const out: InstantlyCampaign[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < 50; page++) {
    const qs = new URLSearchParams({ limit: String(limit) });
    if (startingAfter) qs.set('starting_after', startingAfter);
    const res = await fetchJson<{ items?: InstantlyCampaign[]; next_starting_after?: string }>(
      `${BASE}/campaigns?${qs}`, { service: 'instantly', minGapMs: 600, init: { headers: headers() } },
    );
    out.push(...(res.items ?? []));
    if (!res.next_starting_after || !res.items?.length) break;
    startingAfter = res.next_starting_after;
  }
  return out;
}

/**
 * Analytics for the given campaigns. The endpoint with no params returns only a
 * recent-activity subset (not all campaigns) and the `ids[]` form is ignored, so
 * we pass the explicit repeated `ids=` form, chunked to keep the URL sane.
 * Read-only.
 */
export async function campaignAnalyticsByIds(ids: string[]): Promise<CampaignAnalytics[]> {
  const out: CampaignAnalytics[] = [];
  for (let i = 0; i < ids.length; i += 25) {
    const qs = ids.slice(i, i + 25).map((id) => `ids=${encodeURIComponent(id)}`).join('&');
    const res = await fetchJson<CampaignAnalytics[] | CampaignAnalytics>(
      `${BASE}/campaigns/analytics?${qs}`,
      { service: 'instantly', minGapMs: 600, init: { headers: headers() } },
    );
    if (Array.isArray(res)) out.push(...res);
    else if (res) out.push(res);
  }
  return out;
}

/** Daily counters between two YYYY-MM-DD dates (workspace-wide when no campaign id). Read-only. */
export async function dailyAnalytics(startDate: string, endDate: string): Promise<DailyAnalytics[]> {
  const qs = new URLSearchParams({ start_date: startDate, end_date: endDate });
  const res = await fetchJson<DailyAnalytics[]>(
    `${BASE}/campaigns/analytics/daily?${qs}`,
    { service: 'instantly', minGapMs: 600, init: { headers: headers() } },
  );
  return Array.isArray(res) ? res : [];
}

/** Add one lead to a campaign. Never activates anything. */
export async function pushLead(campaignId: string, lead: {
  email: string; company_name?: string; first_name?: string; last_name?: string; custom_variables?: Record<string, unknown>;
}): Promise<{ id?: string }> {
  return fetchJson<{ id?: string }>(`${BASE}/leads`, {
    service: 'instantly', minGapMs: 600,
    init: { method: 'POST', headers: headers(), body: JSON.stringify({ campaign: campaignId, ...lead }) },
  });
}
