export const COUNTRIES = ['us', 'gb', 'br', 'tr', 'in', 'id', 'mx', 'de', 'fr'] as const;
export type Geo = (typeof COUNTRIES)[number];

// Large markets the geo-arbitrage view checks for absence in.
export const LARGE_MARKETS: Geo[] = ['in', 'br', 'tr', 'id', 'mx'];

// Apple genre ids. null = all categories.
export const APPLE_CATEGORIES: { key: string; genreId: number | null }[] = [
  { key: 'all', genreId: null },
  { key: 'productivity', genreId: 6007 },
  { key: 'photo-video', genreId: 6008 },
  { key: 'finance', genreId: 6015 },
  { key: 'lifestyle', genreId: 6012 },
  { key: 'education', genreId: 6017 },
];

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
