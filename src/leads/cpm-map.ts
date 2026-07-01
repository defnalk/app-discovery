/**
 * CPM-delta opportunity map (the "where does 8x win hardest" lens from the Jun 11 strategy call).
 *
 *   delta(geo, category) = (paidCPM[geo] * categoryMult[category]) / organicCPM[geo]
 *
 * Bigger delta = organic creator UGC beats paid ads harder in that market x category =
 * higher 8x opportunity. Leads inherit the delta of their (geo, category) cell and re-rank by it.
 *
 * DATA HONESTY:
 *  - PAID CPM      : real, sourced (Meta 2025-26 benchmarks). See `src`.
 *  - CATEGORY MULT : derived from Meta industry CPM 2025 (health ~$20.7, ecom ~$16, median ~$13.5, tech ~$6.9).
 *  - ORGANIC CPM   : ESTIMATE. There is no public per-market organic-UGC CPM. Public UGC rates are
 *                    ~$0.50–$5 per 1k views; 8x's fresh-account model sits at the low end and rises
 *                    with market saturation. >>> REPLACE these with Bulut social-listening data. <<<
 */

// Paid Meta CPM (US$, 2025-26). Sources noted; (est) = no direct source, emerging-market proxy.
export const PAID_CPM_BY_GEO: Record<string, { usd: number; src: string }> = {
  us: { usd: 16.0, src: 'Statista / Lebesgue Meta CPM 2025 (~$16; AdAmigo $20.5)' },
  br: { usd: 4.20, src: 'Lebesgue / AdAmigo 2025 ($2.6–4.2)' },
  mx: { usd: 3.92, src: 'Adligator / Lebesgue 2025' },
  in: { usd: 1.80, src: 'multiple 2025 ($1.36–2.6)' },
  tr: { usd: 2.50, src: '(est) emerging-market proxy — no direct source' },
  id: { usd: 2.00, src: '(est) emerging-market proxy' },
  ar: { usd: 2.50, src: '(est) emerging-market proxy' },
};
export const DEFAULT_PAID_CPM = 6.0; // unknown geo

// Category multiplier vs ~1.0 median (Meta industry CPM 2025).
export const CATEGORY_MULT: Record<string, number> = {
  health: 1.5, wellness: 1.5, fitness: 1.4,
  finance: 1.35, fintech: 1.35, bank: 1.35, invest: 1.3, insurance: 1.3,
  beauty: 1.2, ecommerce: 1.2, dtc: 1.2, retail: 1.2, fashion: 1.2, skincare: 1.2,
  dating: 1.05, social: 1.05, matrimony: 1.05,
  food: 1.0, beverage: 1.0,
  travel: 0.95,
  education: 0.8, edtech: 0.8, learning: 0.8,
  music: 0.7, audio: 0.7,
  gaming: 0.75, games: 0.75,
  productivity: 0.6,
  ai: 0.55, saas: 0.55, tech: 0.55,
};
export const DEFAULT_CATEGORY_MULT = 1.0;

// Organic UGC CPM ($/1k views) — ESTIMATE, replace with Bulut data.
export const ORGANIC_CPM_BY_GEO: Record<string, number> = {
  us: 2.00, br: 0.55, mx: 0.65, in: 0.35, tr: 0.40, id: 0.45, ar: 0.55,
};
export const DEFAULT_ORGANIC_CPM = 0.60;

export const DELTA_CAP = 40; // normalize/clip extreme ratios

export function catMult(category?: string | null): number {
  if (!category) return DEFAULT_CATEGORY_MULT;
  const c = category.toLowerCase();
  for (const [k, v] of Object.entries(CATEGORY_MULT)) if (c.includes(k)) return v;
  return DEFAULT_CATEGORY_MULT;
}
export const paidCpm = (geo?: string | null, category?: string | null) =>
  (PAID_CPM_BY_GEO[(geo || '').toLowerCase()]?.usd ?? DEFAULT_PAID_CPM) * catMult(category);
export const organicCpm = (geo?: string | null) =>
  ORGANIC_CPM_BY_GEO[(geo || '').toLowerCase()] ?? DEFAULT_ORGANIC_CPM;
export const cpmDelta = (geo?: string | null, category?: string | null) =>
  paidCpm(geo, category) / organicCpm(geo);

/** opportunity_score in 0..1: lead fit (jaka_score) blended with normalized market×category delta. */
export function opportunityScore(jakaScore: number | null | undefined, geo?: string | null, category?: string | null): number {
  const fit = jakaScore == null ? 0.5 : Math.max(0, Math.min(1, jakaScore > 1 ? jakaScore / 100 : jakaScore));
  const dNorm = Math.min(cpmDelta(geo, category), DELTA_CAP) / DELTA_CAP;
  return Number((fit * dNorm).toFixed(4));
}

/** Snapshot for the `config` table (key='cpm_map'), so the map is tunable without a redeploy. */
export function cpmMapConfig() {
  return {
    paid_cpm_by_geo: PAID_CPM_BY_GEO,
    category_mult: CATEGORY_MULT,
    organic_cpm_by_geo: ORGANIC_CPM_BY_GEO,
    defaults: { paid: DEFAULT_PAID_CPM, organic: DEFAULT_ORGANIC_CPM, category_mult: DEFAULT_CATEGORY_MULT },
    delta_cap: DELTA_CAP,
    note: 'organic_cpm_by_geo are ESTIMATES — replace with Bulut social-listening data',
  };
}
