/**
 * Apps dashboard: static rebuild from the store into public/index.html.
 * Read-only. Search + filters (geo, category, first_seen window, momentum
 * threshold, geo_gap only), sortable by momentum, rank sparkline per row.
 */
import { writeFileSync, mkdirSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { log } from '../lib/log.ts';
import { getStore, type IdeaRow } from '../lib/store.ts';
import { ideaPlayScore, COUNTRIES, LARGE_MARKETS } from '../lib/config.ts';
import { pageShell, embedJson, sparkline, esc } from '../lib/html.ts';

const DAY = 86_400_000;

type IdeaCard = IdeaRow & { play: number };

/**
 * Idea Radar feed: merge the committed seed (research snapshot) with DB ideas from
 * the live X/LinkedIn pipeline (DB wins per dedup_key), keep only buildable +
 * scored ones, and rank by the shared composite. Empty seed/table is fine.
 */
function loadIdeas(dbIdeas: IdeaRow[]): IdeaCard[] {
  const byKey = new Map<string, IdeaRow>();
  try {
    const seed = JSON.parse(readFileSync(path.join(process.cwd(), 'seed', 'idea-radar.json'), 'utf8')) as IdeaRow[];
    for (const s of seed) byKey.set(s.dedup_key, s);
  } catch { /* no seed file, fine */ }
  for (const d of dbIdeas) if (d.status === 'scored') byKey.set(d.dedup_key, d);
  return [...byKey.values()]
    .filter((i) => i.app_name && i.buildability !== 'too_complex' && i.buildability !== 'months')
    .map((i) => ({ ...i, play: ideaPlayScore(i.novelty, i.demand, i.buildability) }))
    .sort((a, b) => b.play - a.play);
}

/** Bundle the Play ops serverless functions into public/api/*.mjs (deps inlined, like
 *  the leads app's prebundled api/index.js) so the public/ deploy needs no package.json. */
async function bundleFunctions() {
  const dir = path.join(process.cwd(), 'src', 'playapi');
  const names = ['login', 'claim', 'start', 'release', 'submit', 'plays-state', 'admin', 'advisor'];
  const esbuild = await import('esbuild');
  await esbuild.build({
    entryPoints: names.map((n) => path.join(dir, `${n}.ts`)),
    outdir: path.join(process.cwd(), 'public', 'api'),
    bundle: true, platform: 'node', format: 'esm', target: 'node20',
    outExtension: { '.js': '.mjs' }, logLevel: 'error',
  });
  // Competitive Analysis tool, separate entry under src/compete. Only bundle when
  // the source is present (it may be uncommitted WIP); a missing entry must NOT
  // fail the whole dashboard build.
  const competeEntry = path.join(process.cwd(), 'src', 'compete', 'apps-entry.ts');
  if (existsSync(competeEntry)) {
    await esbuild.build({
      entryPoints: [competeEntry],
      outfile: path.join(process.cwd(), 'public', 'api', 'compete.mjs'),
      bundle: true, platform: 'node', format: 'esm', target: 'node20', logLevel: 'error',
    });
  }
}

/** Hard gate: never ship a build where a secret value leaked into the public bundle. */
function assertNoSecretLeak() {
  const files = [path.join(process.cwd(), 'public', 'index.html')];
  const apiDir = path.join(process.cwd(), 'public', 'api');
  try { for (const f of readdirSync(apiDir)) if (f.endsWith('.mjs')) files.push(path.join(apiDir, f)); } catch { /* no api dir */ }
  const secrets = ['SUPABASE_SERVICE_ROLE_KEY', 'PLAY_TEAM_PASSCODE', 'PLAY_SESSION_SECRET']
    .map((k) => process.env[k]).filter((v): v is string => !!v && v.length > 12);
  for (const f of files) {
    const txt = readFileSync(f, 'utf8');
    for (const s of secrets) if (txt.includes(s)) throw new Error(`SECURITY: a secret value leaked into ${path.basename(f)}, build aborted`);
  }
}

// --- Clothing / fashion brand filter -------------------------------------
// The plays dashboard ranks consumer APPS worth (re)building. Single-brand
// fashion/apparel retailers (Zara, H&M, UNIQLO, Myntra…) ship store apps that
// chart under "Shopping" but are NOT build targets, you can't rebuild a clothing
// label. Drop them here. Resale/marketplace apps (Vinted, Vestiaire, Back Market)
// are platform plays, so they are deliberately KEPT.
//
// STRONG fashion words drop in any category; brand names + weaker retail words
// drop only inside a Shopping-type category, so we never touch the many legit
// Lifestyle apps (dating, astrology, home security) or design tools whose
// developer legal name merely contains "moda".
const SHOP_CATEGORIES = new Set([
  'Shopping', 'Compras', '쇼핑', 'ショッピング', 'Winkelen', 'Einkaufen', 'Zakupy', 'Alışveriş',
]);
const FASHION_STRONG = /\b(cloth|clothing|apparel|fashion|footwear|sneaker|streetwear|menswear|womenswear|activewear|athleisure|sportswear|lingerie|knitwear|swimwear|textil|couture|garment|outfitter)\b/i;
const FASHION_WEAK = /\b(moda|mode|shoes?|boutique|jeans)\b/i;
const FASHION_BRANDS = [
  'shein', 'zara', 'bershka', 'pull&bear', 'stradivarius', 'massimo dutti', 'uniqlo', 'primark', 'defacto',
  'lc waikiki', 'koton', 'urban outfitters', 'abercrombie', 'hollister', 'lululemon', 'dr martens', 'foot locker',
  'footlocker', 'jd sports', 'ssense', 'farfetch', 'boohoo', 'namshi', '6thstreet', 'brands for less', 'breuninger',
  'asos', 'myntra', 'ajio', 'nykaa fashion', 'revolve', 'bonprix', 'zalando', 'aboutyou', 'about you', 'sinsay',
  'modivo', 'answear', 'inditex', 'oysho', 'lefties', 'zalora', 'deichmann', 'vero moda', 'shoppers stop',
  'max fashion', 'kiabi', 'cupshe', 'yesstyle', 'boozt', 'h&m', 'c&a', 'ccc',
];
const FASHION_BRAND_RE = new RegExp(
  '(?<![a-z])(' + FASHION_BRANDS.map((b) => b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')(?![a-z])', 'i');

function isClothingBrand(name: string | null, developer: string | null, category: string | null): boolean {
  const blob = `${name ?? ''} ${developer ?? ''}`;
  if (FASHION_STRONG.test(blob)) return true;
  if (SHOP_CATEGORIES.has(category ?? '') && (FASHION_BRAND_RE.test(blob) || FASHION_WEAK.test(blob))) return true;
  return false;
}

export async function buildDashboard() {
  const store = getStore();
  const startedAt = new Date().toISOString();
  const since = new Date(Date.now() - 14 * DAY).toISOString();
  const [apps, rollups, snaps, analyses, scores, dbIdeas] = await Promise.all([
    store.listApps(), store.listRollups(), store.listSnapshotsSince(since), store.listAnalyses(), store.listScores(), store.listIdeas(),
  ]);
  const ideas = loadIdeas(dbIdeas);
  const appById = new Map(apps.map((a) => [a.id, a]));
  const analysisById = new Map(analyses.map((a) => [a.app_id, a]));
  const scoresByApp = new Map<string, typeof scores>();
  for (const s of scores) (scoresByApp.get(s.app_id) ?? scoresByApp.set(s.app_id, []).get(s.app_id)!).push(s);

  // Sparkline series: best rank per day per app (across geos/charts), last 14 days.
  const days: string[] = [];
  for (let i = 13; i >= 0; i--) days.push(new Date(Date.now() - i * DAY).toISOString().slice(0, 10));
  const rankByAppDay = new Map<string, Map<string, number>>();
  for (const s of snaps) {
    if (s.chart_rank == null) continue;
    const m = rankByAppDay.get(s.app_id) ?? rankByAppDay.set(s.app_id, new Map()).get(s.app_id)!;
    const d = s.snapshot_date;
    m.set(d, Math.min(m.get(d) ?? Infinity, s.chart_rank));
  }

  // Show the FULL catalog (team wants every app + every geo browsable in the new UI).
  // Nothing is dropped here: the Play score plus the incumbent / too-complex penalties
  // push non-buildable apps down, and the IA (Home top-10, Top-100, category pages)
  // keeps it digestible. Incumbents keep their pill so they stay distinguishable.
  let rows = rollups
    .map((r) => {
      const app = appById.get(r.app_id);
      if (!app) return null;
      const an = analysisById.get(r.app_id);
      const series = days.map((d) => rankByAppDay.get(r.app_id)?.get(d) ?? null);
      const deltas = (scoresByApp.get(r.app_id) ?? [])
        .filter((s) => s.rank_now != null)
        .sort((a, b) => (a.rank_now ?? 999) - (b.rank_now ?? 999))
        .map((s) => ({ geo: s.geo, now: s.rank_now, prev: s.rank_prev, vel: s.rank_velocity, growth: s.rating_growth }));
      return {
        idea: an?.idea_score ?? null,
        idea_note: an?.idea_note ?? null,
        build: an?.buildability ?? null,
        build_note: an?.buildability_note ?? null,
        sat: an?.saturation ?? null,
        sat_note: an?.saturation_note ?? null,
        deltas,
        store_url: app.store === 'apple'
          ? `https://apps.apple.com/app/id${app.store_id}`
          : `https://play.google.com/store/apps/details?id=${app.store_id}`,
        id: r.app_id,
        name: app.name,
        store: app.store,
        developer: app.developer_name,
        category: app.category,
        geos: r.geos_live,
        new_geos: r.new_geos,
        geo_gap: r.geo_gap,
        momentum: r.momentum_score ?? 0,
        best_rank: r.best_rank,
        rating_count: r.rating_count,
        flag: r.fact_check_flag,
        incumbent: r.is_incumbent,
        shortlisted: r.shortlisted,
        first_seen: app.first_seen_at.slice(0, 10),
        spark: sparkline(series),
        play: 0,
        play_rank: 0,
      };
    })
    .filter((r) => r != null);

  // Drop single-brand clothing/fashion retailers, not buildable plays. See
  // isClothingBrand above. Resale/marketplace apps are kept on purpose.
  const beforeClothing = rows.length;
  rows = rows.filter((r) => !isClothingBrand(r!.name, r!.developer, r!.category));
  log.info(`dashboard: dropped ${beforeClothing - rows.length} clothing/fashion brand apps (not build targets)`);

  // Composite "play score" (0-100): how attractive each app is to build a play
  // of right now, combining every score we have, idea quality, momentum, an open
  // market (low saturation), build speed, and proven traction. Fact-check-suspect
  // apps are discounted. The top 100 by this score are the headline "plays".
  const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const moms = rows.map((r) => r!.momentum).sort((a, b) => a - b);
  const momCap = moms.length ? Math.max(1e-9, moms[Math.min(moms.length - 1, Math.floor(moms.length * 0.95))]!) : 1;
  const ratingMax = Math.max(1e-9, ...rows.map((r) => Math.log10(1 + (r!.rating_count ?? 0))));
  const BUILD_SPEED: Record<string, number> = { weekend: 1, few_days: 0.85, week_or_two: 0.6, months: 0.25, too_complex: 0.08 };
  for (const r of rows) {
    const ideaN = clamp01((r!.idea ?? 0) / 10);
    const momN = clamp01((r!.momentum ?? 0) / momCap);
    const openN = r!.sat == null ? 0.5 : clamp01(1 - r!.sat);
    const buildN = BUILD_SPEED[r!.build ?? ''] ?? 0.4;
    const tractionN = clamp01(Math.log10(1 + (r!.rating_count ?? 0)) / ratingMax);
    let s = 0.30 * ideaN + 0.24 * momN + 0.16 * openN + 0.12 * buildN + 0.18 * tractionN;
    if (r!.flag) s *= 0.6; // unverified / suspect traction → discount
    if (r!.incumbent) s *= 0.5; // not a build target, keep visible but sink it below real plays
    r!.play = Math.round(clamp01(s) * 1000) / 10;
  }
  rows.sort((a, b) => b!.play - a!.play);
  rows.forEach((r, i) => { r!.play_rank = i + 1; });

  // play_rank is GLOBAL (over every tracked app). With 26 geos the catalog is huge
  // (~39k), so embed only the top-N by Play score client-side to keep the page light;
  // the tail is low-score noise. totalTracked keeps the honest headline number.
  const totalTracked = rows.length;
  const EMBED_CAP = Number(process.env.EMBED_CAP ?? 6000);
  rows = rows.slice(0, EMBED_CAP);

  const categories = [...new Set(rows.map((r) => r!.category).filter(Boolean))].sort();
  const geos = [...new Set(rows.flatMap((r) => r!.geos))].sort();

  // App Store-style top charts: latest day's top 5 per (geo, chart type, category).
  // Ranks come from per-genre feeds, so they are only comparable within a category;
  // the cross-category "hot" card ranks by our momentum score instead. Entries
  // reference ROWS by index.
  const TOP_N = 5;
  const latestDay = snaps.reduce((m, s) => (s.snapshot_date > m ? s.snapshot_date : m), '');
  const rowIndexByApp = new Map(rows.map((r, i) => [r!.id, i]));
  const chartAcc = new Map<string, Map<number, number>>(); // "geo|chart|category" -> row index -> best rank
  const hotAcc = new Map<string, Set<number>>(); // "geo|chart" -> row indices charting today
  for (const s of snaps) {
    if (s.snapshot_date !== latestDay || s.chart_rank == null) continue;
    const idx = rowIndexByApp.get(s.app_id);
    if (idx == null) continue; // not in the table (too complex / no rollup), keep charts consistent with it
    const cat = appById.get(s.app_id)?.category || 'Other';
    const key = `${s.geo}|${s.chart_type}|${cat}`;
    const m = chartAcc.get(key) ?? chartAcc.set(key, new Map()).get(key)!;
    m.set(idx, Math.min(m.get(idx) ?? Infinity, s.chart_rank));
    const hotKey = `${s.geo}|${s.chart_type}`;
    (hotAcc.get(hotKey) ?? hotAcc.set(hotKey, new Set()).get(hotKey)!).add(idx);
  }
  const topCharts: Record<string, [number, number][]> = {};
  for (const [key, m] of chartAcc) topCharts[key] = [...m].sort((a, b) => a[1] - b[1]).slice(0, TOP_N);
  const hotCharts: Record<string, number[]> = {};
  for (const [key, set] of hotAcc) {
    hotCharts[key] = [...set].sort((a, b) => rows[b]!.momentum - rows[a]!.momentum).slice(0, TOP_N);
  }
  const tcGeos = [...new Set([...chartAcc.keys()].map((k) => k.split('|')[0]))].sort();
  const tcChartSet = new Set([...chartAcc.keys()].map((k) => k.split('|')[1]));
  const tcCharts = ['top_free', 'top_grossing', 'new_free', 'ai_search'].filter((c) => tcChartSet.has(c));

  // Data-source status, derived from which keys are configured at build time.
  const SOURCES: { name: string; desc: string; env: string | null; note?: string }[] = [
    { name: 'Apple App Store', desc: 'charts · scoring · fact-check · dashboard', env: null },
    { name: 'Leads pipeline', desc: 'funnel rollup · suggestions · approval gates', env: null },
    { name: 'App analysis', desc: 'idea · saturation · buildability for new apps', env: 'ANTHROPIC_API_KEY' },
    { name: 'X / Twitter', desc: 'traction fact-check + idea radar', env: 'APIFY_TOKEN' },
    { name: 'LinkedIn', desc: 'build-in-public launches → idea radar', env: 'APIFY_TOKEN' },
    { name: 'Google Play', desc: 'top charts via Apify', env: 'APIFY_TOKEN' },
    { name: 'Product Hunt', desc: 'daily consumer launches → claims', env: 'PRODUCT_HUNT_TOKEN' },
    { name: 'Apollo', desc: 'developer enrichment → leads', env: 'APOLLO_API_KEY', note: 'needs credits topped up' },
    { name: 'Instantly', desc: 'sends · replies · meetings sync', env: 'INSTANTLY_API_KEY' },
  ];
  const sourcesHtml = SOURCES.map((s) => {
    const live = !s.env || Boolean(process.env[s.env]);
    return `<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;border:1px solid var(--line);border-radius:8px">
      <span style="width:8px;height:8px;border-radius:50%;background:${live ? 'var(--good)' : 'var(--warn)'};flex:none"></span>
      <div><b>${esc(s.name)}</b> <span class="dim">${esc(s.desc)}</span><br>
      ${live
        ? '<span class="dim" style="font-size:11px">live · runs nightly 02:15 UTC</span>'
        : `<span style="font-size:11px;color:var(--warn)">waiting on key${s.note ? ` · ${esc(s.note)}` : ''}</span> <code style="font-size:10px" class="dim">gh secret set ${esc(s.env!)}</code>`}
      </div></div>`;
  }).join('');

  // --- Idea Radar panel: server-rendered cards, ranked by composite play ---
  const buildPill = (b: string | null) =>
    `<span class="pill${b === 'weekend' || b === 'few_days' ? ' new' : ''}">${esc(b ?? '?')}</span>`;
  const srcMix = ideas.reduce<Record<string, number>>((m, i) => ((m[i.source] = (m[i.source] ?? 0) + 1), m), {});
  const ideaCards = ideas.slice(0, 60).map((i, n) => {
    const top = n < 12;
    return `<div class="idea${top ? ' idea-top' : ''}${n >= 12 ? ' idea-more' : ''}">
      <div class="idea-head"><span class="idea-play${top ? ' play-hi' : ''}">${i.play.toFixed(0)}</span>
        <b>${esc(i.app_name)}</b><span class="idea-src">${esc(i.source)}</span></div>
      <div class="dim" style="margin:3px 0 6px;font-size:12px">${esc(i.category ?? '-')} · ${buildPill(i.buildability)} · novelty ${i.novelty ?? '-'}/10 · demand ${i.demand ?? '-'}/10</div>
      <div>${esc(i.concept ?? '')}</div>
      <div class="idea-why">▸ ${esc(i.why ?? '')}</div>
      ${i.source_url ? `<a href="${esc(i.source_url)}" target="_blank" class="idea-link">source ↗</a>` : ''}
    </div>`;
  }).join('');
  void srcMix;
  const ideasPanel = ideas.length ? `
<div class="panel">
  <div class="idea-grid" id="idea-grid">${ideaCards}</div>
  ${ideas.length > 12 ? `<button class="ghost" id="idea-toggle" style="margin-top:12px">Show all ${ideas.length} ideas ↓</button>` : ''}
  <p class="muted-note">Live X + LinkedIn scraping refreshes this nightly once <code>APIFY_TOKEN</code> + <code>ANTHROPIC_API_KEY</code> are set; until then it shows the latest research snapshot.</p>
</div>` : '';

  // Home is rendered client-side (renderHome) so it can show top-10 AVAILABLE
  // (unclaimed) plays once the live claim state loads.
  const body = `
<style>
  /* ═══ Light / editorial theme, scoped to the Plays dashboard. The leads app never
        loads this <style>, so the reskin can't leak. Redefining the shared tokens here
        (this block cascades after pageShell's head styles) flips every token-based
        component to the paper aesthetic at once. ═══ */
  @import url('https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500..800&family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap');
  :root {
    --paper:#EFEEE9; --surface:#FCFBF8; --surface-2:#F6F4EE; --ink:#1B1B1A; --muted:#6E6E66; --faint:#9A9A90;
    --go:#0E7C66; --go-dark:#0A5F4E; --go-tint:#E4EFEA; --amber:#B97514; --amber-tint:#F4E9D6; --rust:#B2462E;
    --display:"Bricolage Grotesque",Georgia,serif; --sans:"IBM Plex Sans",system-ui,sans-serif; --mono:"IBM Plex Mono",ui-monospace,monospace;
    --bg:#EFEEE9; --bg-elev:#FCFBF8; --panel:#FCFBF8; --panel-2:#F6F4EE; --line:#DDDCD3; --line-2:#CDCBC0;
    --txt:#1B1B1A; --txt-2:#6E6E66; --dim:#6E6E66; --acc:#0E7C66; --acc-2:#0A5F4E; --acc-ink:#FFFFFF;
    --good:#0E7C66; --good-bg:#E4EFEA; --warn:#B97514; --warn-bg:#F4E9D6; --bad:#B2462E; --bad-bg:#F4DDD5;
    --shadow:0 1px 0 rgba(0,0,0,.03), 0 10px 30px -18px rgba(0,0,0,.28); --ring:0 0 0 3px rgba(14,124,102,.25);
  }
  body { background:var(--paper); color:var(--ink); font-family:var(--sans); }
  h1,h2,h3,h4 { font-family:var(--display); letter-spacing:-.02em; }
  header { background:linear-gradient(180deg,var(--surface),var(--paper)); }
  header h1 { font-family:var(--display); font-weight:800; display:inline-flex; align-items:center; gap:11px; }
  header h1::before { content:'P'; display:grid; place-items:center; width:34px; height:34px; border-radius:9px; background:var(--ink); color:var(--paper); font-size:19px; transform:rotate(-4deg); flex:none; }
  .tour-overlay { position:fixed; inset:0; background:rgba(27,27,26,.42); z-index:90; display:flex; align-items:center; justify-content:center; padding:24px; }
  .tour-overlay.hidden { display:none; }
  .tour-card { max-width:520px; width:100%; max-height:88vh; overflow-y:auto; padding:0; }
  .tour-head { padding:24px 26px 16px; border-bottom:1px solid var(--line); background:repeating-linear-gradient(90deg,transparent 0 38px,rgba(14,124,102,.05) 38px 39px),var(--surface); }
  .tour-title { font-family:var(--display); font-weight:700; font-size:24px; letter-spacing:-.02em; margin:6px 0 6px; }
  .tour-sub { color:var(--muted); font-size:14px; margin:0; max-width:48ch; }
  .tour-list { padding:6px 26px; }
  .tour-row { display:flex; gap:14px; padding:14px 0; border-bottom:1px solid var(--line); }
  .tour-row:last-child { border-bottom:0; }
  .tour-ico { width:38px; height:38px; border-radius:10px; background:var(--surface-2); border:1px solid var(--line); display:grid; place-items:center; font-size:18px; flex:none; }
  .tour-row b { font-weight:700; font-size:15px; }
  .tour-row p { margin:3px 0 0; color:var(--muted); font-size:13.5px; line-height:1.5; }
  .tour-foot { display:flex; gap:14px; align-items:center; padding:18px 26px 24px; border-top:1px solid var(--line); flex-wrap:wrap; }
  .help-btn { width:30px; height:30px; border-radius:8px; border:1px solid var(--line); background:var(--surface); color:var(--muted); font-weight:700; cursor:pointer; font-size:15px; font-family:var(--display); }
  .help-btn:hover { color:var(--ink); border-color:var(--line-2); }
  .panel { background:var(--surface); box-shadow:var(--shadow); }
  th { background:var(--surface-2); color:var(--faint); font-family:var(--mono); font-size:10.5px; letter-spacing:.08em; text-transform:uppercase; font-weight:500; }
  tr:hover td { background:var(--surface-2); }
  input, select, textarea { background:var(--surface); }
  button { color:#fff; } button.ghost { background:var(--surface); color:var(--ink); border:1px solid var(--line); }
  .pill { background:var(--surface-2); border:1px solid var(--line); color:var(--muted); font-family:var(--mono); }
  .pill.new { background:var(--go-tint); color:var(--go-dark); border-color:transparent; }
  .pill.gap { background:var(--amber-tint); color:var(--amber); border-color:transparent; }
  .stat-chip { background:var(--surface); box-shadow:var(--shadow); }
  .stat-chip[data-go]:hover { border-color:var(--go); }
  .tabbtn { color:var(--muted); } .tabbtn.active { color:var(--ink); border-bottom-color:var(--go); }
  .chip { background:var(--surface); color:var(--muted); } .chip.active { background:var(--ink); color:var(--paper); border-color:var(--ink); }
  .play-hi, .playbadge { color:var(--go-dark)!important; } .playbadge { background:var(--go-tint); }
  .results-badge { background:var(--amber); color:#fff; }
  /* expanded detail panel + claim widget: were hardcoded dark, retint to paper */
  tr.detail > td { background:var(--surface-2)!important; }
  .cw { background:var(--surface); border-color:var(--line); }
  /* command palette + login modal on light */
  .cmdk-box, .login-card { background:var(--surface); }
  #cmdk-input { color:var(--ink); }
  tr.approw.play-top td { background: var(--go-tint); }
  tr.approw.play-top:hover td { background: #D9EBE2; }
  .hero .eyebrow { font-family:var(--mono); font-size:11px; letter-spacing:.16em; text-transform:uppercase; color:var(--go); margin:0 0 6px; }
  .hero-h { font-family:var(--display); font-weight:700; font-size:38px; line-height:1.06; letter-spacing:-.03em; margin:0 0 8px; max-width:18ch; color:var(--ink); }
  .hero-h em { font-style:italic; color:var(--go); }
  .hero .sub { color:var(--muted); font-size:15px; max-width:62ch; margin:0; }
  tr.approw.play-top td:first-child { box-shadow: inset 3px 0 0 0 var(--good); }
  .playbadge { display:inline-block; min-width:30px; text-align:center; padding:1px 6px; border-radius:99px; font-size:10px; font-weight:700; background:var(--go-tint); color:var(--go-dark); margin-left:7px; font-family:var(--mono); vertical-align:middle; }
  .play-hi { color: var(--go-dark); font-weight:800; }
  /* Play score = the answer: make it dominant. First column, big display numerals. */
  #t tbody td:first-child b { font-family:var(--display); font-size:19px; font-weight:800; line-height:1; }
  #t tbody td:first-child b.play-hi { font-size:21px; }
  /* claimed rows: clearer ownership cue than dimming alone */
  tr.approw.claimed td:first-child { box-shadow: inset 3px 0 0 0 var(--amber); }
  /* momentum-as-shape + active-filter chips */
  .mom-cell { display:inline-flex; align-items:center; gap:5px; justify-content:flex-end; }
  .mom-arrow { font-size:11px; line-height:1; }
  .active-filters { display:flex; gap:7px; flex-wrap:wrap; align-items:center; margin:0 0 12px; }
  .active-filters:empty { display:none; }
  .af-chip { font-family:var(--mono); font-size:11.5px; font-weight:500; padding:4px 9px; border-radius:20px; background:var(--go-tint); border:1px solid transparent; color:var(--go-dark); cursor:pointer; display:inline-flex; align-items:center; gap:6px; }
  .af-chip:hover { background:#D9EBE2; } .af-chip .af-x { font-weight:700; opacity:.7; }
  .af-clear { font-family:var(--sans); font-size:12px; background:transparent; color:var(--muted); border:0; cursor:pointer; padding:4px 6px; } .af-clear:hover { color:var(--ink); }
  .idea-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(290px,1fr)); gap:10px; }
  .idea { border:1px solid var(--line); border-radius:10px; padding:11px 13px; background:var(--bg); font-size:13px; }
  .idea-top { border-color:var(--go); background:var(--go-tint); }
  .idea-head { display:flex; align-items:center; gap:8px; }
  .idea-head b { font-size:14px; }
  .idea-play { display:inline-flex; align-items:center; justify-content:center; min-width:30px; height:24px; padding:0 6px; border-radius:6px; background:var(--line); font-weight:700; font-variant-numeric:tabular-nums; }
  .idea-play.play-hi { background:var(--go-tint); color:var(--go-dark); }
  .idea-src { margin-left:auto; font-size:10px; text-transform:uppercase; letter-spacing:.04em; color:var(--dim); border:1px solid var(--line); border-radius:99px; padding:1px 7px; }
  .idea-why { color:var(--dim); margin-top:6px; }
  .idea-link { display:inline-block; margin-top:7px; color:var(--acc); font-size:12px; text-decoration:none; }
  .hero p { margin:0; color:var(--dim); font-size:13.5px; max-width:780px; }
  .stats { display:flex; gap:10px; flex-wrap:wrap; margin:13px 0 2px; }
  .stat-chip { border:1px solid var(--line); border-radius:10px; padding:8px 14px; background:var(--panel); }
  .stat-chip b { font-size:18px; display:block; line-height:1.15; }
  .stat-chip span { color:var(--dim); font-size:11px; }
  .stat-chip[data-go] { cursor:pointer; transition:border-color .15s var(--ease), transform .12s var(--ease); }
  .stat-chip[data-go]:hover { border-color:var(--acc); transform:translateY(-1px); }
  .hero-cta { display:flex; gap:10px; margin-top:14px; flex-wrap:wrap; }
  @keyframes paneIn { from { opacity:0; transform:translateY(4px); } to { opacity:1; transform:none; } }
  .tabpane.active { animation:paneIn .18s var(--ease); }
  /* command palette */
  #cmdk { display:none; position:fixed; inset:0; background:rgba(0,0,0,.55); z-index:80; align-items:flex-start; justify-content:center; padding-top:12vh; }
  #cmdk.show { display:flex; animation:paneIn .12s var(--ease); }
  .cmdk-box { width:92%; max-width:560px; padding:0; margin:0; overflow:hidden; box-shadow:0 24px 64px -22px rgba(0,0,0,.75); }
  #cmdk-input { width:100%; border:0; border-bottom:1px solid var(--line); background:transparent; border-radius:0; padding:15px 18px; font-size:15px; }
  #cmdk-input:focus { box-shadow:none; }
  #cmdk-list { max-height:52vh; overflow-y:auto; padding:6px; }
  .cmdk-item { display:flex; gap:10px; align-items:center; padding:9px 12px; border-radius:8px; cursor:pointer; }
  .cmdk-item.sel, .cmdk-item:hover { background:var(--line); }
  .cmdk-item .ci-kind { font-size:10px; text-transform:uppercase; letter-spacing:.06em; color:var(--dim); border:1px solid var(--line-2); border-radius:99px; padding:1px 7px; flex:none; }
  .cmdk-item .ci-sub { color:var(--dim); font-size:12px; margin-left:auto; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:240px; }
  .cmdk-empty { padding:20px; color:var(--dim); text-align:center; font-size:13px; }
  .cmdk-foot { border-top:1px solid var(--line); padding:8px 14px; color:var(--dim); font-size:11px; font-family:var(--mono); }
  .kbd { font-family:var(--mono); font-size:11px; background:var(--line); border:1px solid var(--line-2); border-radius:5px; padding:1px 5px; color:var(--txt-2); }
  .tabs { display:flex; gap:4px; margin:16px 0; border-bottom:1px solid var(--line); flex-wrap:wrap; }
  .tabbtn { background:none; color:var(--dim); border:0; border-bottom:2px solid transparent; border-radius:0; padding:9px 14px; font-size:14px; font-weight:600; cursor:pointer; }
  .tabbtn:hover { color:var(--txt); }
  .tabbtn.active { color:var(--txt); border-bottom-color:var(--acc); }
  .tablink { color:var(--dim); text-decoration:none; padding:9px 14px; font-size:14px; font-weight:600; border-bottom:2px solid transparent; align-self:center; }
  .tablink:hover { color:var(--txt); }
  .tabpane { display:none; }
  .tabpane.active { display:block; }
  th[title] { text-decoration:underline dotted var(--line); text-underline-offset:3px; }
  .idea-more { display:none; }
  .idea-grid.show-all .idea-more { display:block; }
  .cat-chips { display:flex; gap:6px; flex-wrap:wrap; margin:0 0 12px; }
  .chip { background:var(--panel); color:var(--dim); border:1px solid var(--line); border-radius:99px; padding:5px 12px; font-size:12.5px; font-weight:600; cursor:pointer; }
  .chip:hover { color:var(--txt); }
  .chip.active { background:var(--ink); color:var(--paper); border-color:var(--ink); }
  .hl-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(310px,1fr)); gap:10px; }
  .hl-card { display:flex; align-items:center; gap:10px; text-align:left; width:100%; background:var(--bg); border:1px solid var(--line); border-radius:10px; padding:10px 12px; cursor:pointer; color:var(--txt); font:inherit; }
  .hl-card:hover { border-color:var(--acc); }
  .hl-play { display:inline-flex; align-items:center; justify-content:center; min-width:34px; height:30px; border-radius:7px; background:var(--go-tint); color:var(--go-dark); font-weight:700; font-variant-numeric:tabular-nums; flex:none; }
  .hl-name { font-weight:600; flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .hl-meta { color:var(--dim); font-size:11px; flex:none; }
  #login-modal { display:none; position:fixed; inset:0; background:rgba(0,0,0,.55); z-index:50; align-items:center; justify-content:center; }
  #login-modal.show { display:flex; }
  .login-card { max-width:340px; width:90%; }
  #authbox button { font-size:13px; padding:6px 12px; }
  .cw { margin-top:12px; padding:10px 12px; border:1px solid var(--line); border-radius:8px; background:var(--surface-2); }
  .cw button { font-size:13px; }
  .claimed-pill { display:inline-block; padding:1px 7px; border-radius:99px; font-size:11px; background:#3b2a14; color:var(--warn); margin-left:4px; }
  tr.approw.claimed td { opacity:.6; }
  .cw-timer { color:var(--warn); font-variant-numeric:tabular-nums; }
  .gap-all summary { cursor:pointer; color:var(--dim); }
  select.rc { max-width:180px; font-size:12px; padding:3px 6px; color:var(--good); border-color:var(--line); }
  select.rc.rc-claimed { color:var(--warn); }
  #toast { position:fixed; bottom:18px; left:50%; transform:translateX(-50%); z-index:60; display:flex; flex-direction:column; gap:6px; align-items:center; }
  .toast { padding:8px 14px; border-radius:8px; font-size:13px; border:1px solid var(--line); background:var(--panel); opacity:0; transition:opacity .2s; box-shadow:0 4px 16px rgba(0,0,0,.4); }
  .toast.show { opacity:1; }
  .toast.err { border-color:var(--bad); color:var(--bad); }
  .toast.ok { border-color:var(--good); color:var(--good); }
  .cw-timer.cw-urgent { color:var(--bad); font-weight:700; }
  .results-badge { background:var(--warn); color:#fff; padding:3px 8px; border-radius:6px; font-weight:600; font-size:11px; }
  .hl-claimed { margin-left:auto; font-size:10px; color:var(--warn); flex:none; white-space:nowrap; }
  #view-toggle { margin-left:auto; }
  /* Compact view: hide detail/verification cols (Geos 5, Rank14d 6, Satur 10, Ratings 11, Fact 12, First 13), keep Play/App/Claim/Category/Momentum/Idea/Build, plus the row-tap detail. */
  #t.compact th:nth-child(5),#t.compact td:nth-child(5),#t.compact th:nth-child(6),#t.compact td:nth-child(6),#t.compact th:nth-child(10),#t.compact td:nth-child(10),#t.compact th:nth-child(11),#t.compact td:nth-child(11),#t.compact th:nth-child(12),#t.compact td:nth-child(12),#t.compact th:nth-child(13),#t.compact td:nth-child(13){ display:none; }
  @media (max-width:1024px){ .idea-grid,.hl-grid,#tc-grid{ grid-template-columns:repeat(2,1fr)!important; } }
  @media (max-width:640px){
    main{ padding:12px 12px; }
    .tabs{ overflow-x:auto; flex-wrap:nowrap; gap:2px; }
    .tabbtn{ padding:8px 9px; font-size:13px; white-space:nowrap; }
    .idea-grid,.hl-grid,#tc-grid{ grid-template-columns:1fr!important; }
    .login-card{ max-height:90vh; overflow-y:auto; }
    .hero p{ font-size:13px; }
    #t th:nth-child(n+5), #t td:nth-child(n+5){ display:none; } /* phones: Play/App/Claim/Category only; full detail on tap */
    .hero-cta button{ flex:1; min-width:140px; padding:11px 14px; } /* thumb-friendly full-width CTAs */
    #view-toggle{ margin-left:0; }
    .filters{ gap:8px; }
    .stats{ gap:8px; }
  }
</style>
<div class="hero">
  <p class="eyebrow">Nightly app-traction engine</p>
  <h2 class="hero-h">Find the next app <em>worth building</em>.</h2>
  <p class="sub">Every consumer app on the charts, scored on idea quality, momentum, open market, build speed, and proven traction. One number, the <b>Play score</b>. Plus fresh ideas scouted from social.</p>
  <div class="stats">
    <div class="stat-chip" data-go="plays" role="button" tabindex="0" title="Browse all tracked apps"><b>${totalTracked.toLocaleString()}</b><span>apps tracked · ${geos.length} geos</span></div>
    <div class="stat-chip" data-go="plays" role="button" tabindex="0" title="See the top plays"><b>${Math.min(100, rows.length)}</b><span>top plays · green</span></div>
    <div class="stat-chip" data-go="ideas" role="button" tabindex="0" title="See fresh app ideas"><b>${ideas.length}</b><span>fresh ideas</span></div>
    <div class="stat-chip" data-go="charts" role="button" tabindex="0" title="Open the charts"><b>${esc(latestDay)}</b><span>chart data</span></div>
  </div>
  <div class="hero-cta">
    <button id="cta-plays" type="button">🎯 Browse top plays</button>
    <button class="ghost" id="cta-submit" type="button">📝 Submit a play</button>
    <span class="dim" style="align-self:center;font-size:12px">or press <span class="kbd">⌘K</span> to search anything</span>
  </div>
</div>
<div class="tabs">
  <button class="tabbtn active" data-tab="home">🏠 Home</button>
  <button class="tabbtn" data-tab="plays">🎯 Top Plays</button>
  <button class="tabbtn" data-tab="ideas">💡 Idea Radar</button>
  <button class="tabbtn" data-tab="charts">📈 Charts</button>
  <button class="tabbtn" data-tab="submit">📝 Submit a play</button>
  <button class="tabbtn" data-tab="advisor">🧭 Advisor</button>
  <button class="tabbtn" id="admin-tab" data-tab="admin" style="display:none">🛠 Admin</button>
  <a class="tablink" href="/compete">🥊 Competitive</a>
  <button class="help-btn" id="help-tab" type="button" title="How it works" style="margin-left:auto;align-self:center">?</button>
  <span id="authbox" style="align-self:center"></span>
</div>

<section class="tabpane active" id="tab-home">
  <div id="home-body" class="dim" style="padding:8px 0">Loading…</div>
</section>

<section class="tabpane" id="tab-plays">
  <p class="muted-note" style="margin:0 0 10px">Every tracked app, ranked by <b>Play score</b> (0-100), idea quality + momentum + open market + build speed + proven traction. The <b class="play-hi">top 100</b> are pinned on top in green. Pick a category to narrow, then filter by market. Click a row for per-geo trends &amp; the AI analysis.${totalTracked > EMBED_CAP ? ` Top ${EMBED_CAP.toLocaleString()} of ${totalTracked.toLocaleString()} apps loaded for fast browsing.` : ''}</p>
  <div class="cat-chips" id="cat-chips">
    <button class="chip active" data-cat="">All categories</button>
    ${categories.map((c) => `<button class="chip" data-cat="${esc(c)}">${esc(c)}</button>`).join('')}
  </div>
  <div class="panel filters">
    <input type="search" id="q" placeholder="Search name / developer…" style="min-width:220px">
    <label>Market <select id="geo"><option value="">all</option><option value="__large">★ Large markets (arbitrage)</option>${geos.map((g) => `<option>${esc(g)}</option>`).join('')}</select></label>
    <label>Category <select id="cat"><option value="">all</option>${categories.map((c) => `<option>${esc(c)}</option>`).join('')}</select></label>
    <label>First seen <select id="seen"><option value="">any time</option><option value="7">last 7d</option><option value="30">last 30d</option><option value="90">last 90d</option></select></label>
    <label>Momentum ≥ <input type="number" id="mom" step="0.05" style="width:70px"></label>
    <label><input type="checkbox" id="gap"> geo-gap only</label>
    <label><input type="checkbox" id="avail"> available only</label>
    <label id="mine-lbl" style="display:none"><input type="checkbox" id="mine"> my claims</label>
    <button class="ghost" id="view-toggle" type="button" title="Toggle compact / detailed columns">⊞ Detailed</button>
    <span class="dim" id="count"></span>
  </div>
  <div id="active-filters" class="active-filters"></div>
  <div class="panel" style="overflow-x:auto">
  <table id="t"><thead><tr>
    <th data-k="play" class="num" title="Build-worthiness 0-100: idea + momentum + open market + build speed + traction">Play ▾</th>
    <th data-k="name">App</th><th title="Who has reserved or started this play, pick from the dropdown to claim it">Claim</th><th data-k="category">Category</th><th>Geos live</th>
    <th title="Best chart rank per day, last 14 days">Rank 14d</th><th data-k="momentum" class="num" title="Rank velocity + rating growth + new-geo expansion">Momentum</th>
    <th data-k="idea" class="num" title="Concept quality 0-10, proven demand, simple loop, monetizable">Idea</th><th data-k="build" title="How fast a small team could rebuild the core with AI">Build</th><th data-k="sat" class="num" title="Market saturation, lower = more room to win">Satur.</th>
    <th data-k="rating_count" class="num" title="Fact-checked rating count (real traction)">Verified ratings</th><th title="Claimed vs verified traction check">Fact check</th><th data-k="first_seen" title="When we first caught this app">First caught</th>
  </tr></thead><tbody></tbody></table>
  </div>
</section>

<section class="tabpane" id="tab-ideas">
  <p class="muted-note" style="margin:0 0 10px">Groundbreaking-but-simple app concepts scouted from <b>X · LinkedIn · Product Hunt</b>, scored the same way, <b class="play-hi">green</b> = top 12 plays. Showing 12; expand for the full list.</p>
  ${ideasPanel}
</section>

<section class="tabpane" id="tab-charts">
  <p class="muted-note" style="margin:0 0 10px">Live App Store top-5s per category, plus what's hot, moving and new right now, switch geo and chart type.</p>
  <div class="panel">
    <div class="filters" style="margin-bottom:10px">
      <label>Geo <select id="tc-geo"></select></label>
      <label>Chart <select id="tc-chart"></select></label>
      <span class="dim">top ${TOP_N} per category · #n = store chart rank · ${esc(latestDay)} · click an app for details</span>
    </div>
    <div id="tc-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:10px"></div>
  </div>
</section>

<section class="tabpane" id="tab-submit">
  <div id="submit-gate" class="dim" style="padding:6px 0">Please <a href="#" id="submit-signin" style="color:var(--acc)">sign in</a> with your 8x.social email to submit a play.</div>
  <div id="submit-wrap" class="pb" style="display:none">
    <style>
      @import url('https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600..800&family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap');
      .pb{--paper:#EFEEE9;--surface:#FCFBF8;--ink:#1B1B1A;--muted:#6E6E66;--line:#DDDCD3;--go:#0E7C66;--go-dark:#0A5F4E;--rust:#B2462E;max-width:720px}
      .pb .sheet{background:var(--surface);border:1px solid var(--line);border-radius:14px;box-shadow:0 10px 30px -18px rgba(0,0,0,.6);overflow:hidden;color:var(--ink);font-family:"IBM Plex Sans",system-ui,sans-serif}
      .pb .sheet-head{padding:22px 26px 18px;border-bottom:1px solid var(--line);background:repeating-linear-gradient(90deg,transparent 0 38px,rgba(14,124,102,.05) 38px 39px),var(--surface)}
      .pb .eyebrow{font-family:"IBM Plex Mono";font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--go);margin:0 0 6px}
      .pb .sheet-head h2{font-family:"Bricolage Grotesque","IBM Plex Sans";font-weight:700;font-size:23px;letter-spacing:-.02em;margin:0;color:var(--ink)}
      .pb .sheet-head .sub{margin:6px 0 0;font-size:13.5px;color:var(--muted);max-width:52ch}
      .pb form{padding:0 26px 26px}
      .pb .field{padding:15px 0;border-bottom:1px solid var(--line)}
      .pb .field:last-of-type{border-bottom:0}
      .pb .field label{display:block;font-weight:600;font-size:14px;margin-bottom:3px;color:var(--ink)}
      .pb .field .hint{font-size:12.5px;color:var(--muted);margin:0 0 9px}
      .pb .req{color:var(--rust);font-family:"IBM Plex Mono";font-size:11px;font-weight:600}
      .pb .row{display:flex;gap:14px;flex-wrap:wrap}
      .pb .row>.field{flex:1;min-width:200px;border-bottom:0;padding:0}
      .pb input[type=text],.pb textarea{width:100%;font-family:"IBM Plex Sans";font-size:14.5px;color:var(--ink);background:var(--paper);border:1px solid var(--line);border-radius:9px;padding:10px 12px}
      .pb textarea{resize:vertical;min-height:76px;line-height:1.55}
      .pb input:focus,.pb textarea:focus{outline:2px solid var(--go);outline-offset:1px;border-color:transparent;background:#fff}
      .pb .actions{display:flex;align-items:center;gap:14px;padding-top:20px;flex-wrap:wrap}
      .pb .btn-go{font-family:"IBM Plex Sans";font-weight:600;font-size:14.5px;border-radius:10px;cursor:pointer;border:0;padding:11px 20px;background:var(--go);color:#fff}
      .pb .btn-go:hover{background:var(--go-dark)} .pb .btn-go:disabled{opacity:.55;cursor:not-allowed}
      .pb .sf-msg{font-family:"IBM Plex Mono";font-size:12.5px;color:var(--go-dark);font-weight:600}
    </style>
    <form id="submit-form" novalidate>
      <div class="sheet">
        <div class="sheet-head">
          <p class="eyebrow">New play pitch</p>
          <h2>Make the case for a play</h2>
          <p class="sub">Tell us what to build, who it's for in-market, and the proof behind it. It pings the team the moment you submit.</p>
        </div>
        <div class="row" style="padding:14px 26px 0">
          <div class="field"><label>Your name</label><input id="sf-by" type="text" autocomplete="name" placeholder="Who's pitching?" maxlength="80"></div>
          <div class="field"><label>Team / role</label><input id="sf-team" type="text" placeholder="e.g. Growth PM" maxlength="80"></div>
        </div>
        <div style="padding:0 26px">
          <div class="field"><label>Play name <span class="req">required</span></label><input id="sf-name" type="text" placeholder="Working name for the product" maxlength="200" required></div>
          <div class="field"><label>One-line pitch <span class="req">required</span></label><p class="hint">If you only get one sentence, what is this play?</p><input id="sf-pitch" type="text" placeholder="A ___ that helps ___ do ___" maxlength="400"></div>
          <div class="field"><label>Why build this?</label><p class="hint">The proof: demand signal, gap, momentum.</p><textarea id="sf-why" maxlength="3000"></textarea></div>
          <div class="row">
            <div class="field"><label>Category</label><input id="sf-cat" type="text" list="cat-list" placeholder="e.g. Health &amp; Fitness" maxlength="100"></div>
            <div class="field"><label>Target market(s)</label><input id="sf-market" type="text" placeholder="e.g. US, BR, TR" maxlength="100"></div>
          </div>
          <div class="actions"><button type="submit" class="btn-go">Submit play ▸</button><span id="sf-msg" class="sf-msg"></span></div>
        </div>
      </div>
    </form>
  </div>
  <datalist id="cat-list">${categories.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
</section>

<section class="tabpane" id="tab-advisor">
  <p class="muted-note" style="margin:0 0 10px">Enter your app's current features and Claude compares them against competitors, surfacing feature gaps, differentiation angles, pricing/paywall moves, and quick wins. Grounded on the apps we track in your category.</p>
  <div class="panel" style="max-width:720px">
    <div id="advisor-gate" class="dim">Please <a href="#" id="advisor-signin" style="color:var(--acc)">sign in</a> to run the advisor.</div>
    <form id="advisor-form" style="display:none">
      <div style="display:grid;gap:10px;max-width:640px">
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <label style="flex:1;min-width:200px">Your app name<br><input id="adv-name" type="text" style="width:100%" maxlength="200" required></label>
          <label style="flex:1;min-width:160px">Category<br><input id="adv-cat" type="text" list="cat-list" style="width:100%" maxlength="100" placeholder="e.g. Shopping, Health &amp; Fitness"></label>
        </div>
        <label>Main / free features<br><textarea id="adv-free" rows="4" style="width:100%" maxlength="4000" placeholder="One per line, what the app does today, and what's free"></textarea></label>
        <label>Paid / premium features<br><textarea id="adv-paid" rows="4" style="width:100%" maxlength="4000" placeholder="One per line, what's behind the paywall / subscription"></textarea></label>
        <label>Competitors <span class="dim">(optional)</span><br><input id="adv-comp" type="text" style="width:100%" maxlength="600" placeholder="Comma-separated, e.g. Strava, Nike Run Club"></label>
        <label>Notes for Claude <span class="dim">(optional)</span><br><textarea id="adv-notes" rows="2" style="width:100%" maxlength="1500" placeholder="Anything else, target market, current pricing, goals"></textarea></label>
        <div style="display:flex;gap:10px;align-items:center"><button type="submit" id="adv-go">Generate report</button><span id="adv-msg" class="dim"></span></div>
      </div>
    </form>
    <div id="advisor-report" style="margin-top:16px"></div>
  </div>
</section>

<section class="tabpane" id="tab-admin">
  <p class="muted-note" style="margin:0 0 10px">Admin, every manager's claimed plays &amp; submitted ideas. Visible to Defne &amp; Hussain only.</p>
  <div id="admin-body" class="panel dim">Sign in as an admin to view.</div>
</section>

<div id="login-modal">
  <div class="login-card panel">
    <h3 style="margin:0 0 8px">Sign in</h3>
    <p class="muted-note" style="margin:0 0 10px">Sign in with your <b>8x.social</b> email to claim plays and submit ideas.</p>
    <input id="login-name" type="email" placeholder="you@8x.social" autocomplete="email" style="width:100%;margin-bottom:10px" maxlength="120">
    <div style="display:flex;gap:8px"><button id="login-go">Sign in</button><button class="ghost" id="login-cancel">Cancel</button></div>
    <p id="login-msg" class="dim" style="margin:8px 0 0;min-height:1em"></p>
  </div>
</div>

<div id="toast"></div>

<div id="tour-overlay" class="tour-overlay hidden" role="dialog" aria-modal="true" aria-label="How it works">
  <div class="tour-card panel">
    <div class="tour-head">
      <p class="eyebrow">Welcome</p>
      <h3 class="tour-title">How Plays Database works</h3>
      <p class="tour-sub">Find and ship the next app worth building. Here is the quick tour of each tab.</p>
    </div>
    <div class="tour-list">
      <div class="tour-row"><span class="tour-ico">🏠</span><div><b>Home</b><p>Your launchpad: the top available plays and what is rising fastest, ready to claim.</p></div></div>
      <div class="tour-row"><span class="tour-ico">🎯</span><div><b>Top Plays</b><p>Every consumer app on the charts, scored by a single Play score. Filter, claim one, open any app for the full breakdown.</p></div></div>
      <div class="tour-row"><span class="tour-ico">💡</span><div><b>Idea Radar</b><p>Fresh, buildable app concepts scouted nightly from X, LinkedIn, and Product Hunt.</p></div></div>
      <div class="tour-row"><span class="tour-ico">📈</span><div><b>Charts</b><p>Live App Store top fives by category and country, plus what is hot, moving, and new.</p></div></div>
      <div class="tour-row"><span class="tour-ico">🧭</span><div><b>Advisor</b><p>Enter your app's free and paid features and get an AI report comparing you to competitors, with feature gaps and pricing moves.</p></div></div>
      <div class="tour-row"><span class="tour-ico">📝</span><div><b>Submit a play</b><p>Pitch a play to the team. It posts straight to Slack the moment you send it.</p></div></div>
      <div class="tour-row"><span class="tour-ico">⌨️</span><div><b>Search anything</b><p>Press the / key or Cmd K anywhere to fuzzy search every app or jump to any tab.</p></div></div>
    </div>
    <div class="tour-foot">
      <button id="tour-close" type="button">Got it, let me in</button>
      <span style="color:var(--muted);font-size:12.5px">Reopen any time from the ? in the tab bar.</span>
    </div>
  </div>
</div>

<div id="cmdk" role="dialog" aria-modal="true" aria-label="Command palette">
  <div class="cmdk-box panel">
    <input id="cmdk-input" type="text" placeholder="Search apps or jump to a tab…" autocomplete="off" spellcheck="false" aria-label="Search">
    <div id="cmdk-list"></div>
    <div class="cmdk-foot"><span class="kbd">↑</span> <span class="kbd">↓</span> navigate · <span class="kbd">↵</span> open · <span class="kbd">esc</span> close</div>
  </div>
</div>

<details class="panel" style="padding:10px 14px;margin-top:18px">
  <summary style="cursor:pointer;color:var(--dim)">Data sources, what updates automatically tonight</summary>
  <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:8px;margin-top:10px">${sourcesHtml}</div>
  <p class="muted-note">A source activates the moment its key is added as a GitHub secret, no code changes. Nothing auto-sends: Apollo leads and Instantly batches always pass the human approval gate.</p>
</details>`;

  const script = `
const ROWS = ${embedJson(rows)};
const TOP = ${embedJson(topCharts)};
const HOT = ${embedJson(hotCharts)};
const TC_GEOS = ${embedJson(tcGeos)};
const TC_CHARTS = ${embedJson(tcCharts)};
const CHART_LABELS = { top_free: 'Top Free', top_grossing: 'Top Grossing', new_free: 'New Apps', ai_search: 'AI Search' };
const $ = (s) => document.querySelector(s);
let sortKey = 'play', sortDir = -1;
const fmt = (n) => n == null ? '-' : n >= 1e6 ? (n/1e6).toFixed(1)+'M' : n >= 1e3 ? (n/1e3).toFixed(1)+'k' : String(n);
const ALL_GEOS = ${embedJson([...COUNTRIES])};
const NET_GEOS = ${embedJson(LARGE_MARKETS)};
let CLAIMS = {};   // subject_id -> claim row (apps), from /api/plays-state
let ME = null;     // {name, role} UI hint; the HttpOnly cookie is the real gate
function clearFilters(){
  ['q','geo','cat','seen','mom'].forEach(id => { const el = $('#'+id); if (el) el.value=''; });
  ['gap','avail','mine'].forEach(id => { const el = $('#'+id); if (el && el.checked !== undefined) el.checked = false; });
  document.querySelectorAll('.chip').forEach(x => x.classList.toggle('active', (x.dataset.cat||'') === ''));
  render();
}
function clearOneFilter(k){
  if (k === 'q') { $('#q').value = ''; }
  else if (k === 'geo' || k === 'cat' || k === 'seen' || k === 'mom') {
    const el = $('#'+k); if (el) el.value = '';
    if (k === 'cat') document.querySelectorAll('.chip').forEach(x => x.classList.toggle('active', (x.dataset.cat||'') === ''));
  } else { const el = $('#'+k); if (el) el.checked = false; }
  render();
}
// Momentum as a shape: rank-velocity arrow (▲ rising / ▼ falling) + colour, not a bare number.
function momCell(r){
  let best = null;
  for (const d of (r.deltas || [])) { if (d.now != null && (best == null || d.now < best.now)) best = d; }
  const vel = best && best.vel != null ? best.vel : 0;
  const arrow = vel > 0 ? '▲' : vel < 0 ? '▼' : '·';
  const col = vel > 0 ? 'var(--go)' : vel < 0 ? 'var(--rust)' : 'var(--faint)';
  return '<span class="mom-cell"><span class="mom-arrow" style="color:' + col + '">' + arrow + '</span><b>' + r.momentum.toFixed(2) + '</b></span>';
}
function applyView(){
  const t = $('#t'); if (!t) return;
  let v; try { v = localStorage.getItem('play_view') || 'compact'; } catch(e) { v = 'compact'; }
  const compact = v !== 'detailed';
  t.classList.toggle('compact', compact);
  const b = $('#view-toggle'); if (b) b.textContent = compact ? '⊞ Detailed' : '⊟ Compact';
}
function render() {
  const q = $('#q').value.toLowerCase(), geo = $('#geo').value, cat = $('#cat').value;
  const seen = $('#seen').value ? Date.now() - (+$('#seen').value)*864e5 : null;
  const mom = $('#mom').value === '' ? null : +$('#mom').value;
  const gap = $('#gap').checked, availOnly = $('#avail').checked, mineOnly = $('#mine') && $('#mine').checked;
  const geoOk = (r) => !geo ? true : geo === '__large' ? r.geos.some(g => NET_GEOS.includes(g)) : r.geos.includes(geo);
  let rows = ROWS.filter(r =>
    (!q || r.name.toLowerCase().includes(q) || (r.developer||'').toLowerCase().includes(q)) &&
    geoOk(r) && (!cat || r.category === cat) &&
    (seen == null || new Date(r.first_seen).getTime() >= seen) &&
    (mom == null || r.momentum >= mom) && (!gap || r.geo_gap.length) &&
    (!availOnly || !CLAIMS[r.id]) &&
    (!mineOnly || (CLAIMS[r.id] && ME && CLAIMS[r.id].manager_name === ME.name)));
  if (typeof rows[0]?.[sortKey] === 'string') rows.sort((a,b)=> (a[sortKey]||'').localeCompare(b[sortKey]||'') * sortDir);
  else rows.sort((a,b)=> ((a[sortKey]??-Infinity) - (b[sortKey]??-Infinity)) * sortDir);
  const CAP = 500;
  const shown = rows.slice(0, CAP);
  $('#count').innerHTML = rows.length <= CAP ? (rows.length + ' shown') : '<span class="results-badge">top ' + CAP + ' of ' + rows.length + ', narrow by category/search</span>';
  saveFilters();
  (function(){
    const af = []; const qraw = $('#q').value, sv = $('#seen').value;
    if (qraw) af.push(['q','Search: '+qraw]);
    if (geo) af.push(['geo', geo === '__large' ? 'Large markets' : 'Country: '+geo.toUpperCase()]);
    if (cat) af.push(['cat', cat]);
    if (sv) af.push(['seen','Last '+sv+'d']);
    if (mom != null) af.push(['mom','Momentum ≥ '+mom]);
    if (gap) af.push(['gap','Geo-gap only']);
    if (availOnly) af.push(['avail','Available only']);
    if (mineOnly) af.push(['mine','My claims']);
    const afEl = $('#active-filters'); if (!afEl) return;
    afEl.innerHTML = af.length ? af.map(x => '<button class="af-chip" data-k="'+x[0]+'">'+escq(x[1])+' <span class="af-x">×</span></button>').join('') + '<button class="af-clear">Clear all</button>' : '';
    afEl.querySelectorAll('.af-chip').forEach(btn => btn.onclick = () => clearOneFilter(btn.dataset.k));
    const ac = afEl.querySelector('.af-clear'); if (ac) ac.onclick = clearFilters;
  })();
  if (!shown.length) {
    $('#t tbody').innerHTML = '<tr><td colspan="13"><div style="text-align:center;padding:46px 20px;color:var(--dim)">' +
      '<div style="font-size:15px;color:var(--txt);font-weight:600;margin-bottom:6px">No plays match these filters</div>' +
      '<div style="margin-bottom:14px">Try another category, or clear everything to see all ' + ROWS.length + ' apps.</div>' +
      '<button class="ghost" id="clear-filters">Clear filters</button></div></td></tr>';
    const cb = document.getElementById('clear-filters'); if (cb) cb.onclick = clearFilters;
    return;
  }
  $('#t tbody').innerHTML = shown.map((r, i) => '<tr class="approw' + (r.play_rank <= 100 ? ' play-top' : '') + (CLAIMS[r.id] ? ' claimed' : '') + '" data-i="' + ROWS.indexOf(r) + '" style="cursor:pointer">' +
    '<td class="num"><b' + (r.play_rank <= 100 ? ' class="play-hi"' : '') + '>' + (r.play != null ? r.play.toFixed(1) : '-') + '</b>' + (r.play_rank <= 100 ? '<span class="playbadge">#' + r.play_rank + '</span>' : '') + '</td>' +
    '<td><b>' + escq(r.name) + '</b>' + (r.incumbent ? ' <span class="pill">incumbent</span>' : '') +
      '<br><span class="dim">' + escq(r.developer||'') + ' · ' + r.store + '</span></td>' +
    '<td>' + rowClaimSelect(r) + '</td>' +
    '<td>' + escq(r.category||'-') + '</td>' +
    '<td>' + r.geos.map(g => '<span class="pill' + (r.new_geos.includes(g) ? ' new' : '') + '">' + g + '</span>').join('') +
      (r.geo_gap.length ? '<br><span class="dim">gap:</span> ' + r.geo_gap.map(g => '<span class="pill gap">' + g + '</span>').join('') : '') + '</td>' +
    '<td>' + r.spark + '</td>' +
    '<td class="num">' + momCell(r) + '</td>' +
    '<td class="num">' + (r.idea != null ? '<b>' + r.idea + '</b>' : '<span class="dim">-</span>') + '</td>' +
    '<td>' + (r.build ? '<span class="pill' + (r.build === 'weekend' || r.build === 'few_days' ? ' new' : '') + '">' + escq(r.build) + '</span>' : '<span class="dim">-</span>') + '</td>' +
    '<td class="num">' + (r.sat != null ? (r.sat * 100).toFixed(0) + '%' : '<span class="dim">-</span>') + '</td>' +
    '<td class="num">' + fmt(r.rating_count) + '</td>' +
    '<td>' + (r.flag ? '<span class="flag">⚠ suspect</span>' : '<span class="dim">ok</span>') + '</td>' +
    '<td>' + r.first_seen + '</td></tr>').join('');
  document.querySelectorAll('tr.approw').forEach(tr => tr.onclick = (e) => {
    if (e.target.closest('a') || e.target.closest('.claim-btn') || e.target.closest('select.rc')) return;
    const open = tr.nextElementSibling?.classList.contains('detail');
    document.querySelectorAll('tr.detail').forEach(d => d.remove());
    if (open) return;
    openDetailRow(tr);
  });
  document.querySelectorAll('select.rc').forEach(sel => sel.onchange = (e) => {
    e.stopPropagation();
    const v = sel.value, id = sel.dataset.id;
    if (v === 'claim') doClaim(id, sel.dataset.name, sel.dataset.cat);
    else if (v === 'start') doStart(id);
    else if (v === 'release') doRelease(id);
    else if (v === 'login') openLogin();
    sel.value = ''; // snap back to the status option
  });
}
function openDetailRow(tr) {
  const r = ROWS[+tr.dataset.i];
  const d = document.createElement('tr');
  d.className = 'detail';
  d.innerHTML = '<td colspan="13" style="background:var(--surface-2);padding:14px 18px">' + detailHtml(r) + '</td>';
  tr.after(d);
  wireClaimButtons(d);
}
// "Why it scored X": the five Play-score signals as compact bars (glance layer);
// the written analysis notes below are the deeper read.
function scoreBreakdown(r){
  if (r.play == null) return '';
  const bs = { weekend:1, few_days:0.85, week_or_two:0.6, months:0.25, too_complex:0.08 };
  const sig = [
    ['Idea', (r.idea||0)/10, r.idea != null ? r.idea + '/10' : '-'],
    ['Momentum', Math.min((r.momentum||0)/3, 1), (r.momentum||0).toFixed(2)],
    ['Open market', r.sat != null ? 1 - r.sat : 0.5, r.sat != null ? (100 - r.sat*100).toFixed(0) + '%' : '-'],
    ['Build speed', bs[r.build] ?? 0.4, r.build || '-'],
    ['Traction', Math.min(Math.log10(1 + (r.rating_count||0))/6, 1), fmt(r.rating_count)],
  ];
  const bar = (label, v, val) => '<div style="display:flex;align-items:center;gap:10px;margin:5px 0">' +
    '<span style="width:92px;font-size:12px;color:var(--muted);flex:none">' + label + '</span>' +
    '<span style="flex:1;height:7px;border-radius:99px;background:var(--surface-2);overflow:hidden"><span style="display:block;height:100%;width:' + Math.round(Math.max(0,Math.min(1,v))*100) + '%;background:var(--go)"></span></span>' +
    '<span style="width:66px;text-align:right;font-family:var(--mono);font-size:11.5px;color:var(--ink);flex:none">' + escq(String(val)) + '</span></div>';
  return '<div style="margin-top:12px;padding:14px 16px;border:1px solid var(--line);border-radius:10px;background:var(--surface)">' +
    '<div style="display:flex;align-items:baseline;gap:10px;margin-bottom:8px"><span style="font-family:var(--display);font-weight:800;font-size:22px;color:var(--go-dark)">' + r.play.toFixed(1) + '</span><span style="font-size:12px;color:var(--muted)">Play score, how this app breaks down</span></div>' +
    sig.map(s => bar(s[0], s[1], s[2])).join('') + '</div>';
}
function detailHtml(r) {
  const deltaRows = (r.deltas||[]).map(d => '<tr><td><span class="pill">' + d.geo + '</span></td>' +
    '<td class="num">' + (d.now ?? '-') + '</td>' +
    '<td class="num">' + (d.prev ?? '<span class="dim">not charting</span>') + '</td>' +
    (d.prev == null
      ? '<td class="num"><span class="pill new">new entry</span></td>'
      : '<td class="num" style="color:' + ((d.vel||0) > 0 ? 'var(--good)' : (d.vel||0) < 0 ? 'var(--bad)' : 'var(--dim)') + '">' +
        ((d.vel||0) > 0 ? '▲ +' : (d.vel||0) < 0 ? '▼ ' : '') + (d.vel ?? 0) + '</td>') +
    '<td class="num">' + (d.growth ? (d.growth * 100).toFixed(1) + '%' : '-') + '</td></tr>').join('');
  const an = r.idea != null || r.build || r.sat != null;
  return claimWidget(r) +
    scoreBreakdown(r) +
    '<div style="display:flex;gap:28px;flex-wrap:wrap;margin-top:12px">' +
    '<div><h4 style="margin:0 0 6px">Rank deltas (7d) per geo</h4>' +
      '<table style="min-width:320px"><thead><tr><th>Geo</th><th class="num">Rank now</th><th class="num">Rank -7d</th><th class="num">Velocity</th><th class="num">Rating growth</th></tr></thead>' +
      '<tbody>' + (deltaRows || '<tr><td colspan="5" class="dim">no per-geo scores yet</td></tr>') + '</tbody></table></div>' +
    '<div style="max-width:520px"><h4 style="margin:0 0 6px">Analysis</h4>' +
      (an ? (
        '<p style="margin:4px 0"><b>Idea ' + (r.idea ?? '-') + '/10</b>, ' + escq(r.idea_note||'') + '</p>' +
        '<p style="margin:4px 0"><b>Buildability: ' + escq(r.build||'-') + '</b>, ' + escq(r.build_note||'') + '</p>' +
        '<p style="margin:4px 0"><b>Saturation ' + (r.sat != null ? (r.sat * 100).toFixed(0) + '%' : '-') + '</b>, ' + escq(r.sat_note||'') + '</p>'
      ) : '<p class="dim">not analyzed yet, top-momentum apps are analyzed nightly</p>') +
      '<p style="margin:8px 0 0"><a href="' + escq(r.store_url) + '" target="_blank" style="color:var(--acc)">open store listing ↗</a> &nbsp; <a href="/compete?app=' + encodeURIComponent(r.name) + '&category=' + encodeURIComponent(r.category||'') + '" style="color:var(--acc)">🥊 Competitive landscape ↗</a> &nbsp; <button class="ghost copy-link" data-id="' + escq(r.id) + '" style="font-size:12px">🔗 Copy link</button></p></div>' +
    gapsHtml(r) + '</div>';
}
// --- Play ops: claim widget, geo gaps, login, claim/start/release, submit, admin ---
function claimOf(r){ return CLAIMS[r.id] || null; }
function rowClaimSelect(r){
  const c = CLAIMS[r.id];
  let status;
  if (!c) status = '🟢 Available';
  else if (c.status === 'reserved' && c.start_by) {
    const h = Math.floor((new Date(c.start_by).getTime() - Date.now()) / 3.6e6);
    status = '🔒 ' + (c.manager_name || '?') + (h <= 0 ? ' · ⚠ expired' : ' · ' + h + 'h left');
  } else status = (c.status === 'started' ? '🔨 ' : '🔒 ') + (c.manager_name || '?') + ' · ' + c.status;
  let opts = '<option value="" selected>' + escq(status) + '</option>';
  if (!ME) { if (!c) opts += '<option value="login">Sign in to claim…</option>'; }
  else if (!c) { opts += '<option value="claim">▶ Claim for me</option>'; }
  else {
    const mine = c.manager_name === ME.name;
    if (mine && c.status === 'reserved') opts += '<option value="start">✓ Mark started</option><option value="release">✕ Release</option>';
    else if (ME.role === 'admin' && c.status === 'reserved') opts += '<option value="release">✕ Release (admin)</option>';
  }
  return '<select class="rc' + (c ? ' rc-claimed' : '') + '" data-id="' + escq(r.id) + '" data-name="' + escq(r.name) + '" data-cat="' + escq(r.category||'') + '">' + opts + '</select>';
}
function claimWidget(r){
  const c = claimOf(r);
  if (!ME) return '<div class="cw"><span class="dim">Sign in to claim / reserve this play.</span></div>';
  if (!c) return '<div class="cw"><button class="claim-btn" data-act="claim" data-id="'+escq(r.id)+'" data-name="'+escq(r.name)+'" data-cat="'+escq(r.category||'')+'">▶ Claim / reserve this play</button></div>';
  const mine = c.manager_name === ME.name;
  let h = '<div class="cw"><b>Claimed by ' + escq(c.manager_name) + '</b> <span class="dim">· ' + escq(c.status) + '</span>';
  if (c.status === 'reserved' && c.start_by) h += ' <span class="cw-timer" data-by="' + escq(c.start_by) + '"></span>';
  if (mine || ME.role === 'admin') {
    h += '<div style="margin-top:8px;display:flex;gap:8px">';
    if (mine && c.status === 'reserved') h += '<button class="claim-btn" data-act="start" data-id="'+escq(r.id)+'">✓ Mark started</button>';
    h += '<button class="ghost claim-btn" data-act="release" data-id="'+escq(r.id)+'">✕ Release</button></div>';
  }
  return h + '</div>';
}
function gapsHtml(r){
  const live = new Set(r.geos);
  const net = NET_GEOS.filter(g => !live.has(g));
  const all = ALL_GEOS.filter(g => !live.has(g));
  const pills = (arr) => arr.length ? arr.map(g => '<span class="pill gap">'+g+'</span>').join(' ') : '<span class="dim">none</span>';
  return '<div style="max-width:420px"><h4 style="margin:0 0 6px">Geo gaps</h4>' +
    '<p style="margin:4px 0"><span class="dim">Live in:</span> ' + (r.geos.length ? r.geos.map(g=>'<span class="pill">'+g+'</span>').join(' ') : '<span class="dim">, </span>') + '</p>' +
    '<p style="margin:4px 0"><span class="dim">Gap in our creator-network markets:</span><br>' + pills(net) + '</p>' +
    '<details class="gap-all" style="margin-top:4px"><summary>Expand all countries (' + all.length + ' gaps)</summary><p style="margin:6px 0">' + pills(all) + '</p></details></div>';
}
function wireClaimButtons(scope){
  scope.querySelectorAll('.claim-btn').forEach(b => b.onclick = (e) => {
    e.stopPropagation();
    const id = b.dataset.id, act = b.dataset.act;
    if (act === 'claim') doClaim(id, b.dataset.name||'', b.dataset.cat||'');
    else if (act === 'start') doStart(id);
    else if (act === 'release') doRelease(id);
  });
  scope.querySelectorAll('.copy-link').forEach(b => b.onclick = (e) => {
    e.stopPropagation();
    navigator.clipboard.writeText(location.origin + location.pathname + '#/app/' + encodeURIComponent(b.dataset.id))
      .then(() => toast('Link copied, share it', 'ok')).catch(() => toast('Copy failed', 'err'));
  });
  scope.querySelectorAll('.cw-timer').forEach(el => {
    const ms = new Date(el.dataset.by).getTime() - Date.now();
    if (ms <= 0) { el.textContent = '· ⚠ start time elapsed'; el.classList.add('cw-urgent'); return; }
    const h = Math.floor(ms/3.6e6), m = Math.floor((ms%3.6e6)/6e4);
    el.textContent = '· ' + (h < 4 ? '⚠ ' : '') + 'start within ' + h + 'h ' + m + 'm';
    if (h < 4) el.classList.add('cw-urgent');
  });
}
function toast(msg, type){
  const wrap = $('#toast'); if (!wrap) return;
  const t = document.createElement('div'); t.className = 'toast ' + (type || 'ok'); t.textContent = msg;
  wrap.appendChild(t); requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 250); }, 3000);
}
async function api(p, opts){
  const o = Object.assign({ credentials: 'include' }, opts||{});
  for (let attempt = 0; ; attempt++){
    const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 10000);
    try {
      const res = await fetch(p, Object.assign({ signal: ctrl.signal }, o));
      clearTimeout(timer);
      return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
    } catch (e) {
      clearTimeout(timer);
      if (attempt >= 2) return { ok: false, status: 0, data: { error: 'network error, please retry' } };
      await new Promise(r => setTimeout(r, 200 * Math.pow(2, attempt))); // retry transient network/cold-start
    }
  }
}
function meHint(){ try { return JSON.parse(localStorage.getItem('play_me')||'null'); } catch { return null; } }
function saveFilters(){ try { localStorage.setItem('play_filters', JSON.stringify({ q:$('#q').value, geo:$('#geo').value, cat:$('#cat').value, seen:$('#seen').value, mom:$('#mom').value, gap:$('#gap').checked, avail:$('#avail').checked, sortKey, sortDir })); } catch(e){} }
function loadFilters(){
  try {
    const f = JSON.parse(localStorage.getItem('play_filters')||'null'); if (!f) return;
    $('#q').value=f.q||''; $('#geo').value=f.geo||''; $('#cat').value=f.cat||''; $('#seen').value=f.seen||''; $('#mom').value=f.mom||''; $('#gap').checked=!!f.gap; $('#avail').checked=!!f.avail;
    if (f.sortKey) sortKey=f.sortKey; if (typeof f.sortDir==='number') sortDir=f.sortDir;
    document.querySelectorAll('.chip').forEach(x => x.classList.toggle('active', (x.dataset.cat||'') === (f.cat||'')));
  } catch(e){}
}
function setMe(m){ ME = m; if (m) localStorage.setItem('play_me', JSON.stringify(m)); else localStorage.removeItem('play_me'); renderAuth(); }
function renderAuth(){
  const box = $('#authbox'); if (!box) return;
  box.innerHTML = ME ? '<span class="dim" style="margin-right:8px">'+escq(ME.name)+(ME.role==='admin'?' · admin':'')+'</span><button class="ghost" id="signout">Sign out</button>' : '<button id="signin">Sign in</button>';
  const so = $('#signout'); if (so) so.onclick = () => { setMe(null); CLAIMS = {}; refreshAll(); };
  const si = $('#signin'); if (si) si.onclick = openLogin;
  const at = $('#admin-tab'); if (at) at.style.display = (ME && ME.role==='admin') ? '' : 'none';
  const ml = $('#mine-lbl'); if (ml) ml.style.display = ME ? '' : 'none';
  if (!ME && $('#mine')) $('#mine').checked = false;
}
function openLogin(){ $('#login-msg').textContent=''; $('#login-modal').classList.add('show'); $('#login-name').focus(); }
function closeLogin(){ $('#login-modal').classList.remove('show'); }
async function doLogin(){
  const email = $('#login-name').value.trim();
  if (!email || !email.includes('@')) { $('#login-msg').textContent = 'Enter your 8x.social email.'; return; }
  $('#login-msg').textContent = 'Signing in…';
  const r = await api('/api/login', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ email }) });
  if (!r.ok) { $('#login-msg').textContent = r.data.error || 'Sign in failed.'; return; }
  setMe({ name: r.data.name, role: r.data.role });
  closeLogin();
  await loadState(); refreshAll();
}
async function loadState(){
  if (!meHint()) { CLAIMS = {}; return; }
  const r = await api('/api/plays-state');
  if (r.status === 401) { setMe(null); CLAIMS = {}; return; }
  if (r.ok) { CLAIMS = {}; (r.data.claims||[]).forEach(c => { if (c.subject_type === 'app') CLAIMS[c.subject_id] = c; }); if (r.data.me) setMe(r.data.me); }
}
function refreshAll(){ renderHome(); render(); renderSubmitGate(); renderAdvisorGate(); if (ME && ME.role==='admin') renderAdmin(); }
async function doClaim(id, name, cat){
  if (!ME) { openLogin(); return; }
  const r = await api('/api/claim', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ subjectType:'app', subjectId:id, subjectName:name, category:cat }) });
  if (r.status === 401) { setMe(null); openLogin(); return; }
  if (!r.ok) { toast((r.data && r.data.error) || 'Claim failed', 'err'); await loadState(); refreshAll(); reopenDetail(id); return; }
  if (r.data && r.data.won === false) toast('Already claimed by ' + (r.data.claimed_by||'someone'), 'err');
  else toast('✓ Claimed, you have 24h to start', 'ok');
  await loadState(); refreshAll(); reopenDetail(id);  // re-sync from authoritative server state
}
async function doStart(id){
  const r = await api('/api/start', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ subjectType:'app', subjectId:id }) });
  if (r.status === 401) { setMe(null); openLogin(); return; }
  toast(r.ok ? '✓ Marked started' : ((r.data && r.data.error) || 'Start failed'), r.ok ? 'ok' : 'err');
  await loadState(); refreshAll(); reopenDetail(id);
}
async function doRelease(id){
  const r = await api('/api/release', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ subjectType:'app', subjectId:id }) });
  if (r.status === 401) { setMe(null); openLogin(); return; }
  toast(r.ok ? 'Released, back in the pool' : ((r.data && r.data.error) || 'Release failed'), r.ok ? 'ok' : 'err');
  await loadState(); refreshAll(); reopenDetail(id);
}
function reopenDetail(id){
  const i = ROWS.findIndex(r => r.id === id);
  document.querySelectorAll('tr.detail').forEach(d => d.remove());
  if (i < 0) return;
  const tr = document.querySelector('tr.approw[data-i="' + i + '"]');
  if (tr) openDetailRow(tr);
}
function hlCardJS(r){
  const c = CLAIMS[r.id];
  const tail = c ? '<span class="hl-claimed">claimed · '+escq(c.manager_name)+'</span>' : '<span class="hl-meta">'+escq(r.category||'-')+' · '+escq(r.build||'?')+'</span>';
  return '<button class="hl-card" data-id="'+escq(r.id)+'"><span class="hl-play">'+(r.play!=null?r.play.toFixed(0):'-')+'</span><span class="hl-name">'+escq(r.name)+'</span>'+tail+'</button>';
}
function renderHome(){
  const body = $('#home-body'); if (!body) return;
  const free = ROWS.filter(r => !CLAIMS[r.id]);
  const top = free.filter(r => !r.incumbent).slice(0, 10); // ROWS already play-sorted
  const rising = [...free].sort((a,b)=> b.momentum - a.momentum).slice(0, 10);
  const claimed = ROWS.filter(r => CLAIMS[r.id]).sort((a,b)=> new Date(CLAIMS[b.id].claimed_at||0) - new Date(CLAIMS[a.id].claimed_at||0)).slice(0, 12);
  const strip = (title, arr) => '<div class="panel"><div style="font-weight:600;margin-bottom:10px">'+title+'</div><div class="hl-grid">'+(arr.length?arr.map(hlCardJS).join(''):'<span class="dim">none</span>')+'</div></div>';
  body.classList.remove('dim');
  body.innerHTML = strip('🎯 Top 10 available plays to build', top) + strip('🔥 Rising fastest (available)', rising) +
    (claimed.length ? strip('🤝 Claimed by the team', claimed) : '') +
    '<p class="muted-note">' + (ME ? 'Showing plays not yet claimed up top. ' : 'Sign in to claim plays. ') + '<b>Top Plays</b> has all '+ROWS.length+' apps with filters &amp; categories; <b>Idea Radar</b> has fresh concepts.</p>';
  body.querySelectorAll('.hl-card').forEach(c => c.onclick = () => { const i = ROWS.findIndex(r=>r.id===c.dataset.id); if (i>=0) openApp(i); });
}
function renderSubmitGate(){
  const gate = $('#submit-gate'), wrap = $('#submit-wrap'); if (!gate||!wrap) return;
  gate.style.display = ME ? 'none' : ''; wrap.style.display = ME ? '' : 'none';
}
function renderAdvisorGate(){
  const gate = $('#advisor-gate'), form = $('#advisor-form'); if (!gate||!form) return;
  gate.style.display = ME ? 'none' : ''; form.style.display = ME ? '' : 'none';
}
function renderAdvisorReport(rep, grounded){
  const list = (arr, fn) => (arr&&arr.length) ? '<ul style="margin:4px 0 0;padding-left:18px">'+arr.map(fn).join('')+'</ul>' : '<span class="dim">none</span>';
  const sec = (title, inner) => '<div class="panel" style="margin-top:10px"><div style="font-weight:600;margin-bottom:6px">'+title+'</div>'+inner+'</div>';
  let h = sec('📍 Positioning', '<p style="margin:0">'+escq(rep.positioning||'')+'</p>');
  h += sec('🕳️ Feature gaps', list(rep.feature_gaps, g => '<li style="margin-bottom:5px"><b>'+escq(g.feature)+'</b>'+(g.seen_in?' <span class="dim">,  '+escq(g.seen_in)+'</span>':'')+'<br><span class="dim">'+escq(g.why_it_matters||'')+'</span></li>'));
  h += sec('✨ Differentiation', list(rep.differentiation, d => '<li style="margin-bottom:5px"><b>'+escq(d.idea)+'</b><br><span class="dim">'+escq(d.rationale||'')+'</span></li>'));
  const pr = rep.pricing||{};
  h += sec('💳 Pricing &amp; paywall', '<p style="margin:0 0 6px">'+escq(pr.assessment||'')+'</p>'+list(pr.recommendations, r => '<li>'+escq(r)+'</li>'));
  h += sec('⚡ Quick wins', list(rep.quick_wins, w => '<li>'+escq(w)+'</li>'));
  if (grounded && grounded.length) h += '<p class="muted-note">Compared against tracked apps: '+grounded.map(escq).join(', ')+'</p>';
  $('#advisor-report').innerHTML = h;
}
async function renderAdmin(){
  const el = $('#admin-body'); if (!el) return;
  if (!ME || ME.role !== 'admin') { el.className='panel dim'; el.textContent='Sign in as an admin to view.'; return; }
  el.className='panel'; el.textContent='Loading…';
  const r = await api('/api/admin');
  if (!r.ok) { el.textContent = r.data.error || 'Failed to load.'; return; }
  const claims = r.data.claims||[], subs = r.data.submissions||[], mgrs = r.data.managers||[];
  const byMgr = {}; claims.forEach(c => { (byMgr[c.manager_name] = byMgr[c.manager_name]||[]).push(c); });
  let h = '<h4 style="margin:0 0 8px">Managers ('+mgrs.length+')</h4>';
  h += mgrs.map(m => { const cs = byMgr[m.name]||[]; return '<div style="margin-bottom:10px"><b>'+escq(m.name)+'</b>'+(m.role==='admin'?' <span class="pill">admin</span>':'')+' <span class="dim">,  '+cs.length+' claim(s)</span>'+(cs.length?'<br>'+cs.map(c=>'<span class="pill">'+escq(c.subject_name||c.subject_id)+' · '+escq(c.status)+'</span>').join(' '):'')+'</div>'; }).join('') || '<span class="dim">none</span>';
  h += '<h4 style="margin:14px 0 8px">Submitted ideas ('+subs.length+')</h4>';
  h += subs.length ? '<div style="overflow-x:auto"><table><thead><tr><th>By</th><th>App</th><th>Category</th><th>Market</th><th>Pitch</th><th>When</th></tr></thead><tbody>' +
    subs.map(s=>'<tr><td>'+escq(s.manager_name)+'</td><td>'+escq(s.app_name)+'</td><td>'+escq(s.category||'-')+'</td><td>'+escq(s.market||'-')+'</td><td style="max-width:340px">'+escq(s.pitch||'')+'</td><td class="dim">'+escq((s.submitted_at||'').slice(0,10))+'</td></tr>').join('') + '</tbody></table></div>'
    : '<span class="dim">No submissions yet.</span>';
  el.innerHTML = h;
}
function escq(s){ const d=document.createElement('div'); d.textContent=s; return d.innerHTML; }

// --- Top charts (App Store style) ---
const flagEmoji = (g) => g.length === 2 ? String.fromCodePoint(...[...g.toUpperCase()].map(c => 0x1F1A5 + c.charCodeAt(0))) : '';
function tcCard(title, items) {
  return '<div style="border:1px solid var(--line);border-radius:10px;padding:10px 12px">' +
    '<div style="font-weight:600;margin-bottom:6px">' + title + '</div>' +
    (items.length ? '<ol style="margin:0;padding:0;list-style:none">' + items.map((it, n) =>
      '<li class="tc-app" data-i="' + it.i + '" style="display:flex;gap:8px;align-items:baseline;padding:3px 0;cursor:pointer">' +
      '<span class="dim" style="width:16px;text-align:right;font-variant-numeric:tabular-nums;flex:none">' + (n + 1) + '</span>' +
      '<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escq(ROWS[it.i].name) +
        (ROWS[it.i].incumbent ? ' <span class="pill">inc</span>' : '') + '</span>' +
      '<span class="dim" style="font-size:11px;flex:none">' + it.note + '</span></li>').join('') + '</ol>'
    : '<span class="dim" style="font-size:12px">nothing charting</span>') + '</div>';
}
function renderTopCharts() {
  const geo = $('#tc-geo').value, chart = $('#tc-chart').value;
  const prefix = geo + '|' + chart + '|';
  const cats = Object.keys(TOP).filter(k => k.startsWith(prefix)).map(k => k.slice(prefix.length))
    .sort((a, b) => a.localeCompare(b));
  const ranked = (key) => (TOP[key] || []).map(([i, r]) => ({ i, note: '#' + r }));
  const hot = (HOT[geo + '|' + chart] || []).map(i => ({ i, note: ROWS[i].momentum.toFixed(2) }));
  const withDelta = ROWS.map((r, i) => ({ i, d: (r.deltas || []).find(d => d.geo === geo) }));
  const movers = withDelta.filter(x => x.d && x.d.prev != null && (x.d.vel || 0) > 0)
    .sort((a, b) => b.d.vel - a.d.vel).slice(0, 5).map(x => ({ i: x.i, note: '\\u25b2 +' + x.d.vel }));
  const fresh = withDelta.filter(x => x.d && x.d.prev == null && x.d.now != null)
    .sort((a, b) => a.d.now - b.d.now).slice(0, 5).map(x => ({ i: x.i, note: '#' + x.d.now }));
  $('#tc-grid').innerHTML = [
    tcCard('\\u2b50 Hot right now <span class="dim" style="font-weight:400;font-size:11px">by momentum</span>', hot),
    tcCard('\\ud83d\\ude80 Top movers (7d)', movers),
    tcCard('\\ud83c\\udd95 New on charts', fresh),
    ...cats.map(c => tcCard(escq(c), ranked(prefix + c))),
  ].join('');
  document.querySelectorAll('.tc-app').forEach(li => li.onclick = () => openApp(+li.dataset.i));
}
function openApp(i) { location.hash = '#/app/' + encodeURIComponent(ROWS[i].id); }
// --- Command palette (⌘/Ctrl+K) ---
const CMDK_TABS = [
  { label:'Home', act:()=>showTab('home') }, { label:'Top Plays', act:()=>showTab('plays') },
  { label:'Idea Radar', act:()=>showTab('ideas') }, { label:'Charts', act:()=>showTab('charts') },
  { label:'Submit a play', act:()=>showTab('submit') }, { label:'Advisor', act:()=>showTab('advisor') },
  { label:'Competitive', act:()=>{ location.href='/compete'; } },
];
let cmdkItems = [], cmdkSel = 0;
function openCmdk(){ const m=$('#cmdk'); if(!m) return; m.classList.add('show'); const i=$('#cmdk-input'); i.value=''; renderCmdk(''); setTimeout(()=>i.focus(),0); }
function closeCmdk(){ const m=$('#cmdk'); if(m) m.classList.remove('show'); }
function renderCmdk(q){
  q=(q||'').trim().toLowerCase();
  const tabs = CMDK_TABS.filter(t=>!q||t.label.toLowerCase().includes(q)).map(t=>({label:t.label, sub:'', kind:'Tab', act:t.act}));
  const openByRow = r => ()=>{ const i=ROWS.indexOf(r); if(i>=0) openApp(i); };
  // Empty query: surface YOUR claimed plays as quick-access. With a query: search apps and tag claims.
  let claims=[], apps=[];
  if(!q){
    claims = ROWS.filter(r=>CLAIMS[r.id] && ME && CLAIMS[r.id].manager_name===ME.name).slice(0,6)
      .map(r=>({label:r.name, sub:'your claim · '+(CLAIMS[r.id].status||''), kind:'Claim', act:openByRow(r)}));
  } else {
    apps = ROWS.filter(r=>r.name.toLowerCase().includes(q)||(r.developer||'').toLowerCase().includes(q)).slice(0,8)
      .map(r=>{ const c=CLAIMS[r.id]; return {label:r.name, sub:(c?('claimed by '+c.manager_name):(r.developer||''))+' · play '+(r.play!=null?r.play.toFixed(0):'-'), kind:c?'Claim':'App', act:openByRow(r)}; });
  }
  cmdkItems = tabs.concat(claims).concat(apps); cmdkSel = 0;
  const list=$('#cmdk-list'); if(!list) return;
  if(!cmdkItems.length){ list.innerHTML='<div class="cmdk-empty">No matches</div>'; return; }
  list.innerHTML = cmdkItems.map((it,n)=>'<div class="cmdk-item'+(n===0?' sel':'')+'" data-n="'+n+'"><span class="ci-kind">'+it.kind+'</span><span>'+escq(it.label)+'</span>'+(it.sub?'<span class="ci-sub">'+escq(it.sub)+'</span>':'')+'</div>').join('');
  list.querySelectorAll('.cmdk-item').forEach(el=>{ el.onclick=()=>activateCmdk(+el.dataset.n); el.onmousemove=()=>setCmdkSel(+el.dataset.n); });
}
function setCmdkSel(n){ if(!cmdkItems.length) return; cmdkSel=Math.max(0,Math.min(cmdkItems.length-1,n)); document.querySelectorAll('.cmdk-item').forEach((el,i)=>el.classList.toggle('sel', i===cmdkSel)); const s=document.querySelector('.cmdk-item.sel'); if(s) s.scrollIntoView({block:'nearest'}); }
function activateCmdk(n){ const it=cmdkItems[n]; if(!it) return; closeCmdk(); it.act(); }
function openAppById(id){
  const i = ROWS.findIndex(r => r.id === id); if (i < 0) return;
  ['geo','cat','seen','mom'].forEach(x => $('#' + x).value = ''); $('#gap').checked = false;
  if ($('#avail')) $('#avail').checked = false; if ($('#mine')) $('#mine').checked = false;
  $('#q').value = ROWS[i].name;
  document.querySelectorAll('.chip').forEach(x => x.classList.toggle('active', (x.dataset.cat||'') === ''));
  // activate the Plays pane directly so we don't overwrite the shareable #/app/:id hash
  document.querySelectorAll('.tabbtn').forEach(b => b.classList.toggle('active', b.dataset.tab === 'plays'));
  document.querySelectorAll('.tabpane').forEach(p => p.classList.toggle('active', p.id === 'tab-plays'));
  render();
  const tr = document.querySelector('tr.approw[data-i="' + i + '"]');
  if (tr) { document.querySelectorAll('tr.detail').forEach(d => d.remove()); openDetailRow(tr); tr.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
}
$('#tc-geo').innerHTML = TC_GEOS.map(g => '<option value="' + g + '"' + (g === 'us' ? ' selected' : '') + '>' + flagEmoji(g) + ' ' + g.toUpperCase() + '</option>').join('');
$('#tc-chart').innerHTML = TC_CHARTS.map(c => '<option value="' + c + '">' + (CHART_LABELS[c] || c) + '</option>').join('');
['tc-geo','tc-chart'].forEach(id => $('#' + id).addEventListener('input', renderTopCharts));

document.querySelectorAll('th[data-k]').forEach(th => th.onclick = () => {
  const k = th.dataset.k;
  sortDir = sortKey === k ? -sortDir : (k === 'name' || k === 'category' || k === 'first_seen' ? 1 : -1);
  sortKey = k; render();
});
let _rt;
const debouncedRender = () => { clearTimeout(_rt); _rt = setTimeout(render, 200); };
['q','mom'].forEach(id => $('#'+id).addEventListener('input', debouncedRender));
['geo','cat','seen','gap','avail'].forEach(id => $('#'+id).addEventListener('input', render));
if ($('#mine')) $('#mine').addEventListener('input', render);
$('#avail').addEventListener('change', () => { if ($('#avail').checked && $('#mine')) $('#mine').checked = false; });
if ($('#mine')) $('#mine').addEventListener('change', () => { if ($('#mine').checked) $('#avail').checked = false; });
if ($('#view-toggle')) $('#view-toggle').onclick = () => {
  const compact = $('#t').classList.contains('compact');
  try { localStorage.setItem('play_view', compact ? 'detailed' : 'compact'); } catch(e) {}
  applyView();
};
document.querySelectorAll('.stat-chip[data-go]').forEach(c => {
  const go = () => showTab(c.dataset.go);
  c.onclick = go;
  c.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } };
});
if ($('#cta-plays')) $('#cta-plays').onclick = () => showTab('plays');
if ($('#cta-submit')) $('#cta-submit').onclick = () => showTab('submit');

// Tabs, show one focused section at a time
function showTab(t) {
  document.querySelectorAll('.tabbtn').forEach(b => b.classList.toggle('active', b.dataset.tab === t));
  document.querySelectorAll('.tabpane').forEach(p => p.classList.toggle('active', p.id === 'tab-' + t));
  if (t === 'admin') renderAdmin();
  if (t === 'submit') renderSubmitGate();
  if (t === 'advisor') renderAdvisorGate();
  if (('#/' + t) !== location.hash) location.hash = '#/' + t;
}
document.querySelectorAll('.tabbtn').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
const ideaToggle = $('#idea-toggle');
if (ideaToggle) ideaToggle.onclick = () => { $('#idea-grid').classList.add('show-all'); ideaToggle.remove(); };

// Category-first chips on the Plays tab
document.querySelectorAll('.chip').forEach(c => c.onclick = () => {
  document.querySelectorAll('.chip').forEach(x => x.classList.toggle('active', x === c));
  $('#cat').value = c.dataset.cat;
  render();
});

// Auth + submit wiring
$('#login-go').onclick = doLogin;
$('#login-cancel').onclick = closeLogin;
$('#login-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
const ssi = $('#submit-signin'); if (ssi) ssi.onclick = (e) => { e.preventDefault(); openLogin(); };
const sform = $('#submit-form');
if (sform) sform.onsubmit = async (e) => {
  e.preventDefault();
  if (!ME) { openLogin(); return; }
  $('#sf-msg').textContent = 'Submitting…';
  const r = await api('/api/submit', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ appName: $('#sf-name').value, category: $('#sf-cat').value, market: $('#sf-market').value, pitch: $('#sf-pitch').value, details: { by: $('#sf-by').value, team: $('#sf-team').value, why: $('#sf-why').value } }) });
  if (r.status === 401) { setMe(null); openLogin(); return; }
  $('#sf-msg').textContent = r.ok ? '✓ Submitted, the team has been pinged. Thank you!' : (r.data.error || 'Failed');
  if (r.ok) { ['sf-by','sf-team','sf-name','sf-pitch','sf-why','sf-cat','sf-market'].forEach(id => { $('#'+id).value=''; }); if (ME.role==='admin') renderAdmin(); }
};

// Advisor wiring
const asi = $('#advisor-signin'); if (asi) asi.onclick = (e) => { e.preventDefault(); openLogin(); };
const aform = $('#advisor-form');
if (aform) aform.onsubmit = async (e) => {
  e.preventDefault();
  if (!ME) { openLogin(); return; }
  const go = $('#adv-go');
  go.disabled = true; $('#adv-msg').textContent = 'Analyzing… this takes ~20-30s';
  // Direct fetch with a long timeout, the shared api() helper aborts at 10s and
  // retries, which is wrong for a ~20-30s LLM call (it surfaces as "network error").
  let r;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 70000);
    const res = await fetch('/api/advisor', { method:'POST', credentials:'include', headers:{'content-type':'application/json'}, body: JSON.stringify({
      appName: $('#adv-name').value, category: $('#adv-cat').value, freeFeatures: $('#adv-free').value,
      paidFeatures: $('#adv-paid').value, competitors: $('#adv-comp').value, notes: $('#adv-notes').value }), signal: ctrl.signal });
    clearTimeout(timer);
    r = { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
  } catch (err) { r = { ok: false, status: 0, data: { error: 'timed out, please try again' } }; }
  go.disabled = false;
  if (r.status === 401) { setMe(null); openLogin(); $('#adv-msg').textContent=''; return; }
  if (!r.ok) { $('#adv-msg').textContent = (r.data && r.data.error) || 'Failed'; return; }
  $('#adv-msg').textContent = '✓ Report ready';
  renderAdvisorReport(r.data.report, r.data.grounded_on);
};

// Shareable hash routing: #/plays, #/admin … and deep links #/app/<id>
function routeFromHash(){
  const h = location.hash || '';
  const m = h.match(/^#\\/app\\/(.+)$/);
  if (m) { openAppById(decodeURIComponent(m[1])); return; }
  const t = h.replace('#/','') || 'home';
  if (document.getElementById('tab-'+t)) showTab(t);
}
window.addEventListener('hashchange', routeFromHash);
// command palette shortcuts
document.addEventListener('keydown', e => {
  const open = $('#cmdk') && $('#cmdk').classList.contains('show');
  if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); open ? closeCmdk() : openCmdk(); return; }
  const inField = /^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName || '');
  if (!open && e.key === '/' && !inField) { e.preventDefault(); openCmdk(); return; }
  if (!open) return;
  if (e.key === 'Escape') { e.preventDefault(); closeCmdk(); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); setCmdkSel(cmdkSel + 1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); setCmdkSel(cmdkSel - 1); }
  else if (e.key === 'Enter') { e.preventDefault(); activateCmdk(cmdkSel); }
});
if ($('#cmdk-input')) $('#cmdk-input').addEventListener('input', e => renderCmdk(e.target.value));
if ($('#cmdk')) $('#cmdk').addEventListener('click', e => { if (e.target.id === 'cmdk') closeCmdk(); });

ME = meHint();
loadFilters();
renderAuth();
renderHome();
render();
applyView();
renderTopCharts();
routeFromHash();
// first-run tutorial
function openTour(){ const m=$('#tour-overlay'); if(m) m.classList.remove('hidden'); }
function closeTour(){ const m=$('#tour-overlay'); if(m) m.classList.add('hidden'); }
if ($('#help-tab')) $('#help-tab').onclick = openTour;
if ($('#tour-close')) $('#tour-close').onclick = closeTour;
if ($('#tour-overlay')) $('#tour-overlay').addEventListener('click', e => { if (e.target.id === 'tour-overlay') closeTour(); });
try { if (!localStorage.getItem('plays_tour_seen')) { openTour(); localStorage.setItem('plays_tour_seen','1'); } } catch(e) {}
loadState().then(refreshAll);`;

  const html = pageShell({ title: 'Plays Database', active: 'apps', app: 'apps', body, script });
  const out = path.join(process.cwd(), 'public', 'index.html');
  mkdirSync(path.dirname(out), { recursive: true });
  // Build-integrity gate: a half-failed ingest must abort the build, not silently
  // ship a thin dashboard that then auto-deploys. Override with MIN_DASHBOARD_ROWS.
  const top100 = rows.filter((r) => (r!.play_rank ?? 0) <= 100 && r!.play_rank > 0).length;
  const minRows = Number(process.env.MIN_DASHBOARD_ROWS ?? 500);
  if (rows.length < minRows || top100 < 50) {
    throw new Error(`build gate: ${rows.length} rows / ${top100} top-plays, refusing to ship a thin dashboard (set MIN_DASHBOARD_ROWS to override)`);
  }
  writeFileSync(out, html);
  await bundleFunctions();   // public/api/*.mjs (claim/login/admin endpoints)
  assertNoSecretLeak();      // abort if any secret value made it into the deployed bundle
  await store.recordRun('dashboard', startedAt, true, { rows: rows.length });
  log.info(`dashboard: ${rows.length} rows -> public/index.html`);
  const published = await publishDashboard(html);
  return { rows: rows.length, published };
}

/**
 * Publish the built page to the public `dashboard` Supabase Storage bucket so the
 * team link stays fresh after every build (nightly CI + local stale rebuilds).
 * Deliberately a no-op until that bucket exists: creating a public bucket is the
 * conscious make-this-public step, done by a human in the Supabase UI, not here.
 */
async function publishDashboard(html: string): Promise<boolean> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key || process.env.LOCAL_STORE === '1') return false;
  const supabase = createClient(url, key);
  const { error } = await supabase.storage.from('dashboard').upload('index.html', html, {
    contentType: 'text/html; charset=utf-8', cacheControl: '300', upsert: true,
  });
  if (error) {
    if (/bucket not found/i.test(error.message)) {
      log.info('dashboard publish skipped, create a public "dashboard" bucket in Supabase Storage to go live');
    } else {
      log.error('dashboard publish failed', { err: error.message });
    }
    return false;
  }
  log.info(`dashboard published -> ${url}/storage/v1/object/public/dashboard/index.html`);
  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  buildDashboard().then((r) => log.info('dashboard build done', r));
}
