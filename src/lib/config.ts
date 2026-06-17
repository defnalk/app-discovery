// Apple App Store storefronts. Keyless (iTunes RSS), so geo breadth is free.
// Mature markets (buying power) + emerging/creator-cheap markets (8x geo-arbitrage thesis).
export const COUNTRIES = [
  // original 9
  'us', 'gb', 'br', 'tr', 'in', 'id', 'mx', 'de', 'fr',
  // mature additions
  'ca', 'au', 'jp', 'kr', 'es', 'it', 'nl', 'se', 'pl',
  // emerging / creator-cheap markets to arbitrage into
  'sa', 'ae', 'ng', 'vn', 'th', 'ph', 'ar', 'co',
] as const;
export type Geo = (typeof COUNTRIES)[number];

// Large markets the geo-arbitrage view checks for absence in (cheap UA to land).
export const LARGE_MARKETS: Geo[] = ['in', 'br', 'tr', 'id', 'mx', 'ng', 'ph', 'vn'];

// Apple genre ids. null = all categories. Keyless, so category breadth is free.
export const APPLE_CATEGORIES: { key: string; genreId: number | null }[] = [
  { key: 'all', genreId: null },
  { key: 'productivity', genreId: 6007 },
  { key: 'photo-video', genreId: 6008 },
  { key: 'finance', genreId: 6015 },
  { key: 'lifestyle', genreId: 6012 },
  { key: 'education', genreId: 6017 },
  { key: 'utilities', genreId: 6002 },       // AI tools cluster here
  { key: 'graphics-design', genreId: 6027 }, // and here
  { key: 'social-networking', genreId: 6005 },
  { key: 'health-fitness', genreId: 6013 },
  { key: 'entertainment', genreId: 6016 },
  { key: 'travel', genreId: 6003 },
  { key: 'food-drink', genreId: 6023 },
  { key: 'shopping', genreId: 6024 },
  { key: 'music', genreId: 6011 },
  { key: 'business', genreId: 6000 },
];

// iTunes Search terms for surfacing new apps before they chart (not just AI).
export const AI_SEARCH_TERMS = [
  'AI', 'AI assistant', 'AI photo', 'AI video', 'AI chat', 'AI agent', 'AI image',
  'photo editor', 'habit tracker', 'language learning',
];
// Only keep search hits released within this window ("new" apps).
export const AI_SEARCH_MAX_AGE_DAYS = 270;

// Google Play category ids for the same verticals.
export const PLAY_CATEGORIES: { key: string; playId: string | null }[] = [
  { key: 'all', playId: null },
  { key: 'productivity', playId: 'PRODUCTIVITY' },
  { key: 'photo-video', playId: 'PHOTOGRAPHY' },
  { key: 'finance', playId: 'FINANCE' },
  { key: 'lifestyle', playId: 'LIFESTYLE' },
  { key: 'education', playId: 'EDUCATION' },
];

export const CHART_TYPES = ['top_free', 'top_grossing'] as const;
export type ChartType = (typeof CHART_TYPES)[number];

export const CHART_LIMIT = 100;

// --- Momentum scoring ---
export const SCORING = {
  lookbackDays: 7, // window for rank velocity / rating growth
  // weights for the composite (per-geo score)
  wRankVelocity: 0.45,
  wRatingGrowth: 0.3,
  wNewGeo: 0.25,
  // newness ranks (bonus decaying over 30 days) but does not gate
  newnessWindowDays: 30,
  newnessMaxBonus: 0.2,
  // an app "charts strongly" in a geo if best rank <= this (geo-arbitrage)
  strongRank: 50,
  strongGeoMin: 2,
  // incumbents excluded from shortlist, kept in the table
  incumbentRatingCount: 500_000,
};

// Developers treated as known majors (matched case-insensitively as substrings).
export const KNOWN_MAJORS = [
  'google', 'meta platforms', 'facebook', 'whatsapp', 'instagram', 'apple',
  'microsoft', 'amazon', 'netflix', 'spotify', 'bytedance', 'tiktok',
  'tencent', 'snap inc', 'pinterest', 'x corp', 'twitter', 'telegram',
  'disney', 'roblox', 'supercell', 'king', 'electronic arts', 'activision',
  'zoom', 'paypal', 'uber', 'booking.com', 'airbnb', 'duolingo', 'openai',
  'adobe', 'samsung', 'yandex', 'alibaba', 'shein', 'temu', 'canva',
  'anthropic', 'perplexity', 'deepseek', 'x.ai', 'xai',
];

export const SHORTLIST_MOMENTUM_MIN = 0.15;

// Fact check: claimed/verified above this is flagged suspect.
export const SUSPECT_DISCREPANCY = 3;

// Product Hunt topics considered "consumer app".
export const PH_CONSUMER_TOPICS = [
  'android', 'ios', 'iphone', 'productivity', 'health-fitness', 'education',
  'social-media', 'photography', 'fintech', 'lifestyle', 'dating', 'games',
  'consumer', 'mobile',
];

// X monitoring (phase 2): keywords + builder watchlist.
export const X_KEYWORDS = [
  'hit #1 on the app store',
  'hit #1 on the App Store',
  '10k downloads',
  '100k downloads',
  'top of the app store',
  'crossed 1 million users',
];
export const X_WATCHLIST: string[] = [
  // add builder handles here, e.g. 'blakeir', 'levelsio'
];

// --- Idea Radar: surface NEW, simple-to-build app ideas from social chatter ---
// X/Twitter search terms that catch launch + build-in-public posts (the engine
// looks UPSTREAM of the store charts — apps still being talked about, not yet
// trending). Used by ingest-x-ideas once APIFY_TOKEN is set.
export const X_IDEA_KEYWORDS = [
  'just launched my app',
  'just shipped my app',
  'built this app in a weekend',
  'vibe coded an app',
  'my new iOS app',
  'launched on the App Store',
  'indie app launch',
  'weekend project app',
  'shipped a new app',
];

// LinkedIn post search queries (Apify LinkedIn actor, best-effort + ToS-bound).
export const LINKEDIN_IDEA_QUERIES = [
  'excited to launch our app',
  'just launched our app',
  'we built an app',
  'new app store launch',
  'indie app launch',
];

// How fast a small team can ship the core: higher = simpler = better play.
export const BUILD_SPEED: Record<string, number> = {
  weekend: 1, few_days: 0.85, week_or_two: 0.6, months: 0.25, too_complex: 0,
};

/**
 * Idea Radar composite (0-100): groundbreaking × proven demand × build speed.
 * Single source of truth, shared by analyze-ideas and the dashboard so the
 * seed file and live pipeline always score identically.
 */
export function ideaPlayScore(novelty: number | null, demand: number | null, buildability: string | null): number {
  const n = Math.max(0, Math.min(10, novelty ?? 0)) / 10;
  const d = Math.max(0, Math.min(10, demand ?? 0)) / 10;
  const b = BUILD_SPEED[buildability ?? ''] ?? 0.4;
  return Math.round((0.4 * n + 0.3 * d + 0.3 * b) * 1000) / 10;
}
