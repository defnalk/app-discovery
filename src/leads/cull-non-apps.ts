/**
 * Tag non-consumer-app leads so the dashboard can filter them out. 8x targets
 * consumer MOBILE APPS that run creator/UGC ad campaigns for installs — not
 * incumbents, not D2C physical-goods brands, not B2B.
 *
 * NON-DESTRUCTIVE: writes raw_payload.icp_type ('incumbent' | 'd2c_or_b2b') onto
 * the off-ICP leads (consumer apps are left untagged). Nothing is deleted, so
 * it's fully reversible and the dashboard can still show everything on toggle.
 *
 * Rules (in order):
 *   1. incumbent (big brands/banks/majors)  -> tag 'incumbent'  (OpenAI, L'Oréal, JPMorgan…)
 *   2. matched to a real App Store app       -> consumer app     (signal_verified overrides category)
 *   3. D2C-physical or B2B name/category     -> tag 'd2c_or_b2b' (beauty, apparel, food, IT services…)
 *   4. otherwise                             -> consumer app
 *
 * DRY_RUN=1 previews counts without writing.
 */
import { KNOWN_MAJORS } from '../lib/config.ts';
import { log } from '../lib/log.ts';
import { getLeadsDb } from './db.ts';

const DRY_RUN = process.env.DRY_RUN === '1';

// Big non-app brands/conglomerates/banks — dropped even if they have an app (too big to be a UA target).
const INCUMBENT_BRANDS = [
  "l'oreal", 'loreal', 'garnier', 'maybelline', 'estee lauder', 'estée lauder', 'unilever', 'nestle', 'nestlé',
  'procter', 'p&g', 'colgate', 'nivea', 'danone', 'coca-cola', 'coca cola', 'pepsi', 'kraft', 'mondelez',
  'jpmorgan', 'jp morgan', 'chase bank', 'goldman', 'morgan stanley', 'bank of america', 'citibank', 'citigroup',
  'wells fargo', 'hsbc', 'barclays', 'american express', 'mastercard', 'visa inc',
];
// Clearly NOT a consumer app: physical D2C goods + B2B/services industries. Matched against name AND category.
const NON_APP =
  /beaut|cosmetic|skincare|makeup|fragrance|perfume|apparel|fashion|footwear|jewel|clothing|textile|athleisure|activewear|food and beverage|food & beverage|beverage|grocery|nutrition|supplement|vitamin|personal care|consumer goods|consumer packaged|cpg|fmcg|furniture|home goods|mattress|wholesale|distributor|manufactur|information technology|& services|and services|staffing|recruit|consulting|real estate|automotive|logistics|hospitality|construction|\binsurance\b|\bbank\b|financial services|winery|brewery|spirits/i;

function classify(l: { company: string | null; category: string | null; raw_payload?: Record<string, unknown> | null }): 'incumbent' | 'consumer_app' | 'd2c_or_b2b' {
  const name = (l.company ?? '').toLowerCase();
  if (INCUMBENT_BRANDS.some((b) => name.includes(b)) || KNOWN_MAJORS.some((m) => name.includes(m))) return 'incumbent';
  const text = `${name} ${(l.category ?? '').toLowerCase()}`;
  // A real, matched App Store app is a consumer app regardless of a brand-y category label.
  if (l.raw_payload?.signal_verified) return 'consumer_app';
  if (NON_APP.test(text)) return 'd2c_or_b2b';
  return 'consumer_app';
}

export async function runCull() {
  const db = getLeadsDb();
  const leads = await db.listLeadsJoined();
  const updates: { id: string; signal_source_url: string | null; raw_payload: Record<string, unknown> | null }[] = [];
  const tally = { incumbent: 0, d2c_or_b2b: 0, consumer_app: 0 };
  for (const l of leads) {
    const c = classify(l);
    tally[c]++;
    const rp = (l.raw_payload as Record<string, unknown> | null) ?? {};
    const want = c === 'consumer_app' ? undefined : c; // only tag the off-ICP ones
    if (rp.icp_type !== want) {
      const next = { ...rp };
      if (want) next.icp_type = want; else delete next.icp_type;
      updates.push({ id: l.id, signal_source_url: l.signal_source_url, raw_payload: next });
    }
  }
  log.info(`cull: ${leads.length} leads -> ${tally.consumer_app} consumer apps · ${tally.incumbent} incumbents + ${tally.d2c_or_b2b} D2C/B2B tagged off-ICP`);

  if (DRY_RUN) { log.info('cull: DRY RUN, nothing written'); return { consumer_apps: tally.consumer_app, tagged: updates.length, ...tally }; }
  const written = updates.length ? await db.updateLeadSignals(updates) : 0;
  log.info(`cull: tagged ${written} leads off-ICP (non-destructive)`);
  return { consumer_apps: tally.consumer_app, tagged: written, ...tally };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runCull();
}
