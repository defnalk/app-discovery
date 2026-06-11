/**
 * Fact check: compare unverified claims against store-verified numbers.
 * verified_value = iTunes ratingCount (apple) or installs bracket (google).
 * discrepancy_ratio = claimed / verified; > SUSPECT_DISCREPANCY flags the app
 * on the dashboard. ph_upvotes claims are provenance-only, never fact-checked.
 */
import { SUSPECT_DISCREPANCY } from '../lib/config.ts';
import { log } from '../lib/log.ts';
import { getStore } from '../lib/store.ts';

export async function runFactCheck() {
  const store = getStore();
  const startedAt = new Date().toISOString();
  const claims = (await store.listUnverifiedClaims()).filter((c) => c.claimed_metric !== 'ph_upvotes');
  if (!claims.length) {
    await store.recordRun('factcheck', startedAt, true, { checked: 0 });
    return { checked: 0, suspect: 0 };
  }

  const [apps, snaps] = await Promise.all([
    store.listApps(),
    store.listSnapshotsSince(new Date(Date.now() - 14 * 86_400_000).toISOString()),
  ]);
  const appById = new Map(apps.map((a) => [a.id, a]));

  // Latest verified numbers per app: max rating_count (apple) / max installs (google).
  const verified = new Map<string, { ratingCount: number | null; installs: number | null }>();
  for (const s of snaps) {
    const v = verified.get(s.app_id) ?? { ratingCount: null, installs: null };
    if (s.rating_count != null) v.ratingCount = Math.max(v.ratingCount ?? 0, s.rating_count);
    if (s.installs != null) v.installs = Math.max(v.installs ?? 0, s.installs);
    verified.set(s.app_id, v);
  }

  const suspectApps: string[] = [];
  let checked = 0;
  for (const claim of claims) {
    const app = appById.get(claim.app_id);
    const v = verified.get(claim.app_id);
    if (!app || !v || claim.claimed_value == null || claim.id == null) continue;
    // users/downloads → installs bracket on google, ratingCount proxy on apple; reviews → ratingCount
    const verifiedValue =
      claim.claimed_metric === 'reviews' ? v.ratingCount
      : app.store === 'google' ? (v.installs ?? v.ratingCount)
      : v.ratingCount;
    if (verifiedValue == null || verifiedValue === 0) continue;
    const ratio = claim.claimed_value / verifiedValue;
    await store.updateClaim(claim.id, {
      verified_value: verifiedValue,
      discrepancy_ratio: Number(ratio.toFixed(2)),
    });
    checked++;
    if (ratio > SUSPECT_DISCREPANCY) suspectApps.push(claim.app_id);
  }

  await store.setFactCheckFlag([...new Set(suspectApps)]);
  await store.recordRun('factcheck', startedAt, true, { checked, suspect: suspectApps.length });
  log.info(`factcheck: ${checked} claims verified, ${suspectApps.length} suspect`);
  return { checked, suspect: suspectApps.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runFactCheck().then((r) => log.info('factcheck done', r));
}
