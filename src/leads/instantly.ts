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

/** Add one lead to a campaign. Never activates anything. */
export async function pushLead(campaignId: string, lead: {
  email: string; company_name?: string; first_name?: string; last_name?: string; custom_variables?: Record<string, unknown>;
}): Promise<{ id?: string }> {
  return fetchJson<{ id?: string }>(`${BASE}/leads`, {
    service: 'instantly', minGapMs: 600,
    init: { method: 'POST', headers: headers(), body: JSON.stringify({ campaign: campaignId, ...lead }) },
  });
}
