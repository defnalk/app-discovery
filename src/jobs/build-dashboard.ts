/**
 * Apps dashboard: static rebuild from the store into public/index.html.
 * Read-only. Search + filters (geo, category, first_seen window, momentum
 * threshold, geo_gap only), sortable by momentum, rank sparkline per row.
 */
import { writeFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
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
  } catch { /* no seed file — fine */ }
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
  const names = ['login', 'claim', 'start', 'release', 'submit', 'plays-state', 'admin'];
  const esbuild = await import('esbuild');
  await esbuild.build({
    entryPoints: names.map((n) => path.join(dir, `${n}.ts`)),
    outdir: path.join(process.cwd(), 'public', 'api'),
    bundle: true, platform: 'node', format: 'esm', target: 'node20',
    outExtension: { '.js': '.mjs' }, logLevel: 'error',
  });
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
    for (const s of secrets) if (txt.includes(s)) throw new Error(`SECURITY: a secret value leaked into ${path.basename(f)} — build aborted`);
  }
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
  const rows = rollups
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

  // Composite "play score" (0–100): how attractive each app is to build a play
  // of right now, combining every score we have — idea quality, momentum, an open
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
    if (r!.incumbent) s *= 0.5; // not a build target — keep visible but sink it below real plays
    r!.play = Math.round(clamp01(s) * 1000) / 10;
  }
  rows.sort((a, b) => b!.play - a!.play);
  rows.forEach((r, i) => { r!.play_rank = i + 1; });

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
    if (idx == null) continue; // not in the table (too complex / no rollup) — keep charts consistent with it
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
      <div class="dim" style="margin:3px 0 6px;font-size:12px">${esc(i.category ?? '–')} · ${buildPill(i.buildability)} · novelty ${i.novelty ?? '–'}/10 · demand ${i.demand ?? '–'}/10</div>
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
  tr.approw.play-top td { background: rgba(63,207,142,0.09); }
  tr.approw.play-top:hover td { background: rgba(63,207,142,0.16); }
  tr.approw.play-top td:first-child { box-shadow: inset 3px 0 0 0 var(--good); }
  .playbadge { display:inline-block; min-width:34px; text-align:center; padding:1px 6px; border-radius:99px; font-size:11px; font-weight:700; background:#10301f; color:var(--good); margin-left:6px; }
  .play-hi { color: var(--good); font-weight:700; }
  .idea-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(290px,1fr)); gap:10px; }
  .idea { border:1px solid var(--line); border-radius:10px; padding:11px 13px; background:var(--bg); font-size:13px; }
  .idea-top { border-color:rgba(63,207,142,0.45); background:rgba(63,207,142,0.06); }
  .idea-head { display:flex; align-items:center; gap:8px; }
  .idea-head b { font-size:14px; }
  .idea-play { display:inline-flex; align-items:center; justify-content:center; min-width:30px; height:24px; padding:0 6px; border-radius:6px; background:var(--line); font-weight:700; font-variant-numeric:tabular-nums; }
  .idea-play.play-hi { background:#10301f; color:var(--good); }
  .idea-src { margin-left:auto; font-size:10px; text-transform:uppercase; letter-spacing:.04em; color:var(--dim); border:1px solid var(--line); border-radius:99px; padding:1px 7px; }
  .idea-why { color:var(--dim); margin-top:6px; }
  .idea-link { display:inline-block; margin-top:7px; color:var(--acc); font-size:12px; text-decoration:none; }
  .hero p { margin:0; color:var(--dim); font-size:13.5px; max-width:780px; }
  .stats { display:flex; gap:10px; flex-wrap:wrap; margin:13px 0 2px; }
  .stat-chip { border:1px solid var(--line); border-radius:10px; padding:8px 14px; background:var(--panel); }
  .stat-chip b { font-size:18px; display:block; line-height:1.15; }
  .stat-chip span { color:var(--dim); font-size:11px; }
  .tabs { display:flex; gap:4px; margin:16px 0; border-bottom:1px solid var(--line); flex-wrap:wrap; }
  .tabbtn { background:none; color:var(--dim); border:0; border-bottom:2px solid transparent; border-radius:0; padding:9px 14px; font-size:14px; font-weight:600; cursor:pointer; }
  .tabbtn:hover { color:var(--txt); }
  .tabbtn.active { color:var(--txt); border-bottom-color:var(--acc); }
  .tabpane { display:none; }
  .tabpane.active { display:block; }
  th[title] { text-decoration:underline dotted var(--line); text-underline-offset:3px; }
  .idea-more { display:none; }
  .idea-grid.show-all .idea-more { display:block; }
  .cat-chips { display:flex; gap:6px; flex-wrap:wrap; margin:0 0 12px; }
  .chip { background:var(--panel); color:var(--dim); border:1px solid var(--line); border-radius:99px; padding:5px 12px; font-size:12.5px; font-weight:600; cursor:pointer; }
  .chip:hover { color:var(--txt); }
  .chip.active { background:var(--acc); color:#06121f; border-color:var(--acc); }
  .hl-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(310px,1fr)); gap:10px; }
  .hl-card { display:flex; align-items:center; gap:10px; text-align:left; width:100%; background:var(--bg); border:1px solid var(--line); border-radius:10px; padding:10px 12px; cursor:pointer; color:var(--txt); font:inherit; }
  .hl-card:hover { border-color:var(--acc); }
  .hl-play { display:inline-flex; align-items:center; justify-content:center; min-width:34px; height:30px; border-radius:7px; background:#10301f; color:var(--good); font-weight:700; font-variant-numeric:tabular-nums; flex:none; }
  .hl-name { font-weight:600; flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .hl-meta { color:var(--dim); font-size:11px; flex:none; }
  #login-modal { display:none; position:fixed; inset:0; background:rgba(0,0,0,.55); z-index:50; align-items:center; justify-content:center; }
  #login-modal.show { display:flex; }
  .login-card { max-width:340px; width:90%; }
  #authbox button { font-size:13px; padding:6px 12px; }
  .cw { margin-top:12px; padding:10px 12px; border:1px solid var(--line); border-radius:8px; background:#11161f; }
  .cw button { font-size:13px; }
  .claimed-pill { display:inline-block; padding:1px 7px; border-radius:99px; font-size:11px; background:#3b2a14; color:var(--warn); margin-left:4px; }
  tr.approw.claimed td { opacity:.6; }
  .cw-timer { color:var(--warn); font-variant-numeric:tabular-nums; }
  .gap-all summary { cursor:pointer; color:var(--dim); }
</style>
<div class="hero">
  <p>Consumer apps worth building — every app ranked nightly by a single <b>Play score</b>, plus fresh app ideas scouted from social. Click any app for the full breakdown.</p>
  <div class="stats">
    <div class="stat-chip"><b>${rows.length}</b><span>apps tracked</span></div>
    <div class="stat-chip"><b>${Math.min(100, rows.length)}</b><span>top plays · green</span></div>
    <div class="stat-chip"><b>${ideas.length}</b><span>fresh ideas</span></div>
    <div class="stat-chip"><b>${esc(latestDay)}</b><span>chart data</span></div>
  </div>
</div>
<div class="tabs">
  <button class="tabbtn active" data-tab="home">🏠 Home</button>
  <button class="tabbtn" data-tab="plays">🎯 Top Plays</button>
  <button class="tabbtn" data-tab="ideas">💡 Idea Radar</button>
  <button class="tabbtn" data-tab="charts">📈 Charts</button>
  <button class="tabbtn" data-tab="submit">📝 Submit a play</button>
  <button class="tabbtn" id="admin-tab" data-tab="admin" style="display:none">🛠 Admin</button>
  <span id="authbox" style="margin-left:auto;align-self:center"></span>
</div>

<section class="tabpane active" id="tab-home">
  <div id="home-body" class="dim" style="padding:8px 0">Loading…</div>
</section>

<section class="tabpane" id="tab-plays">
  <p class="muted-note" style="margin:0 0 10px">Every tracked app, ranked by <b>Play score</b> (0–100) — idea quality + momentum + open market + build speed + proven traction. The <b class="play-hi">top 100</b> are pinned on top in green. Pick a category to narrow, then filter by market. Click a row for per-geo trends &amp; the AI analysis.</p>
  <div class="cat-chips" id="cat-chips">
    <button class="chip active" data-cat="">All categories</button>
    ${categories.map((c) => `<button class="chip" data-cat="${esc(c)}">${esc(c)}</button>`).join('')}
  </div>
  <div class="panel filters">
    <input type="search" id="q" placeholder="Search name / developer…" style="min-width:220px">
    <label>Geo <select id="geo"><option value="">all</option>${geos.map((g) => `<option>${esc(g)}</option>`).join('')}</select></label>
    <label>Category <select id="cat"><option value="">all</option>${categories.map((c) => `<option>${esc(c)}</option>`).join('')}</select></label>
    <label>First seen <select id="seen"><option value="">any time</option><option value="7">last 7d</option><option value="30">last 30d</option><option value="90">last 90d</option></select></label>
    <label>Momentum ≥ <input type="number" id="mom" step="0.05" style="width:70px"></label>
    <label><input type="checkbox" id="gap"> geo-gap only</label>
    <span class="dim" id="count"></span>
  </div>
  <div class="panel" style="overflow-x:auto">
  <table id="t"><thead><tr>
    <th data-k="play" class="num" title="Build-worthiness 0–100: idea + momentum + open market + build speed + traction">Play ▾</th>
    <th data-k="name">App</th><th data-k="category">Category</th><th>Geos live</th>
    <th title="Best chart rank per day, last 14 days">Rank 14d</th><th data-k="momentum" class="num" title="Rank velocity + rating growth + new-geo expansion">Momentum</th>
    <th data-k="idea" class="num" title="Concept quality 0–10 — proven demand, simple loop, monetizable">Idea</th><th data-k="build" title="How fast a small team could rebuild the core with AI">Build</th><th data-k="sat" class="num" title="Market saturation — lower = more room to win">Satur.</th>
    <th data-k="rating_count" class="num" title="Fact-checked rating count (real traction)">Verified ratings</th><th title="Claimed vs verified traction check">Fact check</th><th data-k="first_seen" title="When we first caught this app">First caught</th>
  </tr></thead><tbody></tbody></table>
  </div>
</section>

<section class="tabpane" id="tab-ideas">
  <p class="muted-note" style="margin:0 0 10px">Groundbreaking-but-simple app concepts scouted from <b>X · LinkedIn · Product Hunt</b>, scored the same way — <b class="play-hi">green</b> = top 12 plays. Showing 12; expand for the full list.</p>
  ${ideasPanel}
</section>

<section class="tabpane" id="tab-charts">
  <p class="muted-note" style="margin:0 0 10px">Live App Store top-5s per category, plus what's hot, moving and new right now — switch geo and chart type.</p>
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
  <p class="muted-note" style="margin:0 0 10px">Submit a play idea for the team. Admins (Defne &amp; Hussain) review submissions in the Admin tab.</p>
  <div class="panel" style="max-width:680px">
    <div id="submit-gate" class="dim">Please <a href="#" id="submit-signin" style="color:var(--acc)">sign in</a> to submit a play idea.</div>
    <form id="submit-form" style="display:none">
      <div style="display:grid;gap:10px;max-width:560px">
        <label>App / play name<br><input id="sf-name" type="text" style="width:100%" maxlength="200" required></label>
        <label>Category<br><input id="sf-cat" type="text" list="cat-list" style="width:100%" maxlength="100"></label>
        <label>Target market(s)<br><input id="sf-market" type="text" placeholder="e.g. US, BR, TR" style="width:100%" maxlength="100"></label>
        <label>Pitch — why is this a good play?<br><textarea id="sf-pitch" rows="4" style="width:100%" maxlength="4000"></textarea></label>
        <div style="display:flex;gap:10px;align-items:center"><button type="submit">Submit play idea</button><span id="sf-msg" class="dim"></span></div>
      </div>
    </form>
  </div>
  <datalist id="cat-list">${categories.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
</section>

<section class="tabpane" id="tab-admin">
  <p class="muted-note" style="margin:0 0 10px">Admin — every manager's claimed plays &amp; submitted ideas. Visible to Defne &amp; Hussain only.</p>
  <div id="admin-body" class="panel dim">Sign in as an admin to view.</div>
</section>

<div id="login-modal">
  <div class="login-card panel">
    <h3 style="margin:0 0 8px">Sign in</h3>
    <p class="muted-note" style="margin:0 0 10px">Enter your name and the shared team passcode to claim plays and submit ideas.</p>
    <input id="login-name" type="text" placeholder="Your name" style="width:100%;margin-bottom:8px" maxlength="60">
    <input id="login-pass" type="password" placeholder="Team passcode" style="width:100%;margin-bottom:10px">
    <div style="display:flex;gap:8px"><button id="login-go">Sign in</button><button class="ghost" id="login-cancel">Cancel</button></div>
    <p id="login-msg" class="dim" style="margin:8px 0 0;min-height:1em"></p>
  </div>
</div>

<details class="panel" style="padding:10px 14px;margin-top:18px">
  <summary style="cursor:pointer;color:var(--dim)">Data sources — what updates automatically tonight</summary>
  <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:8px;margin-top:10px">${sourcesHtml}</div>
  <p class="muted-note">A source activates the moment its key is added as a GitHub secret — no code changes. Nothing auto-sends: Apollo leads and Instantly batches always pass the human approval gate.</p>
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
const fmt = (n) => n == null ? '–' : n >= 1e6 ? (n/1e6).toFixed(1)+'M' : n >= 1e3 ? (n/1e3).toFixed(1)+'k' : String(n);
const ALL_GEOS = ${embedJson([...COUNTRIES])};
const NET_GEOS = ${embedJson(LARGE_MARKETS)};
let CLAIMS = {};   // subject_id -> claim row (apps), from /api/plays-state
let ME = null;     // {name, role} UI hint; the HttpOnly cookie is the real gate
function render() {
  const q = $('#q').value.toLowerCase(), geo = $('#geo').value, cat = $('#cat').value;
  const seen = $('#seen').value ? Date.now() - (+$('#seen').value)*864e5 : null;
  const mom = $('#mom').value === '' ? null : +$('#mom').value;
  const gap = $('#gap').checked;
  let rows = ROWS.filter(r =>
    (!q || r.name.toLowerCase().includes(q) || (r.developer||'').toLowerCase().includes(q)) &&
    (!geo || r.geos.includes(geo)) && (!cat || r.category === cat) &&
    (seen == null || new Date(r.first_seen).getTime() >= seen) &&
    (mom == null || r.momentum >= mom) && (!gap || r.geo_gap.length));
  if (typeof rows[0]?.[sortKey] === 'string') rows.sort((a,b)=> (a[sortKey]||'').localeCompare(b[sortKey]||'') * sortDir);
  else rows.sort((a,b)=> ((a[sortKey]??-Infinity) - (b[sortKey]??-Infinity)) * sortDir);
  const CAP = 500;
  const shown = rows.slice(0, CAP);
  $('#count').textContent = rows.length <= CAP ? rows.length + ' shown' : 'showing top ' + CAP + ' of ' + rows.length + ' — narrow by category or search';
  $('#t tbody').innerHTML = shown.map((r, i) => '<tr class="approw' + (r.play_rank <= 100 ? ' play-top' : '') + (CLAIMS[r.id] ? ' claimed' : '') + '" data-i="' + ROWS.indexOf(r) + '" style="cursor:pointer">' +
    '<td class="num"><b' + (r.play_rank <= 100 ? ' class="play-hi"' : '') + '>' + (r.play != null ? r.play.toFixed(1) : '–') + '</b>' + (r.play_rank <= 100 ? '<span class="playbadge">#' + r.play_rank + '</span>' : '') + '</td>' +
    '<td><b>' + escq(r.name) + '</b>' + (r.incumbent ? ' <span class="pill">incumbent</span>' : '') + (CLAIMS[r.id] ? ' <span class="claimed-pill">claimed: ' + escq(CLAIMS[r.id].manager_name) + '</span>' : '') +
      '<br><span class="dim">' + escq(r.developer||'') + ' · ' + r.store + '</span></td>' +
    '<td>' + escq(r.category||'–') + '</td>' +
    '<td>' + r.geos.map(g => '<span class="pill' + (r.new_geos.includes(g) ? ' new' : '') + '">' + g + '</span>').join('') +
      (r.geo_gap.length ? '<br><span class="dim">gap:</span> ' + r.geo_gap.map(g => '<span class="pill gap">' + g + '</span>').join('') : '') + '</td>' +
    '<td>' + r.spark + '</td>' +
    '<td class="num"><b>' + r.momentum.toFixed(2) + '</b></td>' +
    '<td class="num">' + (r.idea != null ? '<b>' + r.idea + '</b>' : '<span class="dim">–</span>') + '</td>' +
    '<td>' + (r.build ? '<span class="pill' + (r.build === 'weekend' || r.build === 'few_days' ? ' new' : '') + '">' + escq(r.build) + '</span>' : '<span class="dim">–</span>') + '</td>' +
    '<td class="num">' + (r.sat != null ? (r.sat * 100).toFixed(0) + '%' : '<span class="dim">–</span>') + '</td>' +
    '<td class="num">' + fmt(r.rating_count) + '</td>' +
    '<td>' + (r.flag ? '<span class="flag">⚠ suspect</span>' : '<span class="dim">ok</span>') + '</td>' +
    '<td>' + r.first_seen + '</td></tr>').join('');
  document.querySelectorAll('tr.approw').forEach(tr => tr.onclick = (e) => {
    if (e.target.closest('a') || e.target.closest('.claim-btn')) return;
    const open = tr.nextElementSibling?.classList.contains('detail');
    document.querySelectorAll('tr.detail').forEach(d => d.remove());
    if (open) return;
    openDetailRow(tr);
  });
}
function openDetailRow(tr) {
  const r = ROWS[+tr.dataset.i];
  const d = document.createElement('tr');
  d.className = 'detail';
  d.innerHTML = '<td colspan="12" style="background:#11161f;padding:14px 18px">' + detailHtml(r) + '</td>';
  tr.after(d);
  wireClaimButtons(d);
}
function detailHtml(r) {
  const deltaRows = (r.deltas||[]).map(d => '<tr><td><span class="pill">' + d.geo + '</span></td>' +
    '<td class="num">' + (d.now ?? '–') + '</td>' +
    '<td class="num">' + (d.prev ?? '<span class="dim">not charting</span>') + '</td>' +
    (d.prev == null
      ? '<td class="num"><span class="pill new">new entry</span></td>'
      : '<td class="num" style="color:' + ((d.vel||0) > 0 ? 'var(--good)' : (d.vel||0) < 0 ? 'var(--bad)' : 'var(--dim)') + '">' +
        ((d.vel||0) > 0 ? '▲ +' : (d.vel||0) < 0 ? '▼ ' : '') + (d.vel ?? 0) + '</td>') +
    '<td class="num">' + (d.growth ? (d.growth * 100).toFixed(1) + '%' : '–') + '</td></tr>').join('');
  const an = r.idea != null || r.build || r.sat != null;
  return claimWidget(r) +
    '<div style="display:flex;gap:28px;flex-wrap:wrap;margin-top:12px">' +
    '<div><h4 style="margin:0 0 6px">Rank deltas (7d) per geo</h4>' +
      '<table style="min-width:320px"><thead><tr><th>Geo</th><th class="num">Rank now</th><th class="num">Rank -7d</th><th class="num">Velocity</th><th class="num">Rating growth</th></tr></thead>' +
      '<tbody>' + (deltaRows || '<tr><td colspan="5" class="dim">no per-geo scores yet</td></tr>') + '</tbody></table></div>' +
    '<div style="max-width:520px"><h4 style="margin:0 0 6px">Analysis</h4>' +
      (an ? (
        '<p style="margin:4px 0"><b>Idea ' + (r.idea ?? '–') + '/10</b> — ' + escq(r.idea_note||'') + '</p>' +
        '<p style="margin:4px 0"><b>Buildability: ' + escq(r.build||'–') + '</b> — ' + escq(r.build_note||'') + '</p>' +
        '<p style="margin:4px 0"><b>Saturation ' + (r.sat != null ? (r.sat * 100).toFixed(0) + '%' : '–') + '</b> — ' + escq(r.sat_note||'') + '</p>'
      ) : '<p class="dim">not analyzed yet — top-momentum apps are analyzed nightly</p>') +
      '<p style="margin:8px 0 0"><a href="' + escq(r.store_url) + '" target="_blank" style="color:var(--acc)">open store listing ↗</a></p></div>' +
    gapsHtml(r) + '</div>';
}
// --- Play ops: claim widget, geo gaps, login, claim/start/release, submit, admin ---
function claimOf(r){ return CLAIMS[r.id] || null; }
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
    '<p style="margin:4px 0"><span class="dim">Live in:</span> ' + (r.geos.length ? r.geos.map(g=>'<span class="pill">'+g+'</span>').join(' ') : '<span class="dim">—</span>') + '</p>' +
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
  scope.querySelectorAll('.cw-timer').forEach(el => {
    const ms = new Date(el.dataset.by).getTime() - Date.now();
    if (ms <= 0) { el.textContent = '· start time elapsed'; return; }
    const h = Math.floor(ms/3.6e6), m = Math.floor((ms%3.6e6)/6e4);
    el.textContent = '· start within ' + h + 'h ' + m + 'm';
  });
}
const api = (p, opts) => fetch(p, Object.assign({ credentials: 'include' }, opts||{})).then(async res => ({ ok: res.ok, status: res.status, data: await res.json().catch(()=>({})) }));
function meHint(){ try { return JSON.parse(localStorage.getItem('play_me')||'null'); } catch { return null; } }
function setMe(m){ ME = m; if (m) localStorage.setItem('play_me', JSON.stringify(m)); else localStorage.removeItem('play_me'); renderAuth(); }
function renderAuth(){
  const box = $('#authbox'); if (!box) return;
  box.innerHTML = ME ? '<span class="dim" style="margin-right:8px">'+escq(ME.name)+(ME.role==='admin'?' · admin':'')+'</span><button class="ghost" id="signout">Sign out</button>' : '<button id="signin">Sign in</button>';
  const so = $('#signout'); if (so) so.onclick = () => { setMe(null); CLAIMS = {}; refreshAll(); };
  const si = $('#signin'); if (si) si.onclick = openLogin;
  const at = $('#admin-tab'); if (at) at.style.display = (ME && ME.role==='admin') ? '' : 'none';
}
function openLogin(){ $('#login-msg').textContent=''; $('#login-modal').classList.add('show'); $('#login-name').focus(); }
function closeLogin(){ $('#login-modal').classList.remove('show'); }
async function doLogin(){
  const name = $('#login-name').value.trim(), passcode = $('#login-pass').value;
  if (!name) { $('#login-msg').textContent = 'Enter your name.'; return; }
  $('#login-msg').textContent = 'Signing in…';
  const r = await api('/api/login', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ name, passcode }) });
  if (!r.ok) { $('#login-msg').textContent = r.data.error || 'Sign in failed.'; return; }
  setMe({ name: r.data.name, role: r.data.role });
  $('#login-pass').value=''; closeLogin();
  await loadState(); refreshAll();
}
async function loadState(){
  if (!meHint()) { CLAIMS = {}; return; }
  const r = await api('/api/plays-state');
  if (r.status === 401) { setMe(null); CLAIMS = {}; return; }
  if (r.ok) { CLAIMS = {}; (r.data.claims||[]).forEach(c => { if (c.subject_type === 'app') CLAIMS[c.subject_id] = c; }); if (r.data.me) setMe(r.data.me); }
}
function refreshAll(){ renderHome(); render(); renderSubmitGate(); if (ME && ME.role==='admin') renderAdmin(); }
async function doClaim(id, name, cat){
  if (!ME) { openLogin(); return; }
  const r = await api('/api/claim', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ subjectType:'app', subjectId:id, subjectName:name, category:cat }) });
  if (r.status === 401) { setMe(null); openLogin(); return; }
  if (r.ok && r.data && r.data.claim) CLAIMS[id] = r.data.claim;
  if (r.ok && r.data && r.data.won === false) alert('Already claimed by ' + (r.data.claimed_by||'someone'));
  refreshAll(); reopenDetail(id);
}
async function doStart(id){
  const r = await api('/api/start', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ subjectType:'app', subjectId:id }) });
  if (r.ok && r.data.started) CLAIMS[id] = r.data.started;
  refreshAll(); reopenDetail(id);
}
async function doRelease(id){
  const r = await api('/api/release', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ subjectType:'app', subjectId:id }) });
  if (r.ok) delete CLAIMS[id];
  refreshAll(); reopenDetail(id);
}
function reopenDetail(id){
  const i = ROWS.findIndex(r => r.id === id);
  document.querySelectorAll('tr.detail').forEach(d => d.remove());
  if (i < 0) return;
  const tr = document.querySelector('tr.approw[data-i="' + i + '"]');
  if (tr) openDetailRow(tr);
}
function hlCardJS(r){ return '<button class="hl-card" data-id="'+escq(r.id)+'"><span class="hl-play">'+(r.play!=null?r.play.toFixed(0):'–')+'</span><span class="hl-name">'+escq(r.name)+'</span><span class="hl-meta">'+escq(r.category||'–')+' · '+escq(r.build||'?')+'</span></button>'; }
function renderHome(){
  const body = $('#home-body'); if (!body) return;
  const free = ROWS.filter(r => !CLAIMS[r.id]);
  const top = free.filter(r => !r.incumbent).slice(0, 10); // ROWS already play-sorted
  const rising = [...free].sort((a,b)=> b.momentum - a.momentum).slice(0, 10);
  const strip = (title, arr) => '<div class="panel"><div style="font-weight:600;margin-bottom:10px">'+title+'</div><div class="hl-grid">'+(arr.length?arr.map(hlCardJS).join(''):'<span class="dim">none available</span>')+'</div></div>';
  body.classList.remove('dim');
  body.innerHTML = strip('🎯 Top 10 available plays to build', top) + strip('🔥 Rising fastest (available)', rising) +
    '<p class="muted-note">' + (ME ? 'Showing plays not yet claimed. ' : 'Sign in to claim plays. ') + '<b>Top Plays</b> has all '+ROWS.length+' apps with filters &amp; categories; <b>Idea Radar</b> has fresh concepts.</p>';
  body.querySelectorAll('.hl-card').forEach(c => c.onclick = () => { const i = ROWS.findIndex(r=>r.id===c.dataset.id); if (i>=0) openApp(i); });
}
function renderSubmitGate(){
  const gate = $('#submit-gate'), form = $('#submit-form'); if (!gate||!form) return;
  gate.style.display = ME ? 'none' : ''; form.style.display = ME ? '' : 'none';
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
  h += mgrs.map(m => { const cs = byMgr[m.name]||[]; return '<div style="margin-bottom:10px"><b>'+escq(m.name)+'</b>'+(m.role==='admin'?' <span class="pill">admin</span>':'')+' <span class="dim">— '+cs.length+' claim(s)</span>'+(cs.length?'<br>'+cs.map(c=>'<span class="pill">'+escq(c.subject_name||c.subject_id)+' · '+escq(c.status)+'</span>').join(' '):'')+'</div>'; }).join('') || '<span class="dim">none</span>';
  h += '<h4 style="margin:14px 0 8px">Submitted ideas ('+subs.length+')</h4>';
  h += subs.length ? '<div style="overflow-x:auto"><table><thead><tr><th>By</th><th>App</th><th>Category</th><th>Market</th><th>Pitch</th><th>When</th></tr></thead><tbody>' +
    subs.map(s=>'<tr><td>'+escq(s.manager_name)+'</td><td>'+escq(s.app_name)+'</td><td>'+escq(s.category||'–')+'</td><td>'+escq(s.market||'–')+'</td><td style="max-width:340px">'+escq(s.pitch||'')+'</td><td class="dim">'+escq((s.submitted_at||'').slice(0,10))+'</td></tr>').join('') + '</tbody></table></div>'
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
function openApp(i) {
  showTab('plays');
  $('#q').value = ROWS[i].name;
  ['geo','cat','seen','mom'].forEach(id => $('#' + id).value = '');
  $('#gap').checked = false;
  render();
  const tr = document.querySelector('tr.approw[data-i="' + i + '"]');
  if (tr) { tr.click(); tr.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
}
$('#tc-geo').innerHTML = TC_GEOS.map(g => '<option value="' + g + '"' + (g === 'us' ? ' selected' : '') + '>' + flagEmoji(g) + ' ' + g.toUpperCase() + '</option>').join('');
$('#tc-chart').innerHTML = TC_CHARTS.map(c => '<option value="' + c + '">' + (CHART_LABELS[c] || c) + '</option>').join('');
['tc-geo','tc-chart'].forEach(id => $('#' + id).addEventListener('input', renderTopCharts));

document.querySelectorAll('th[data-k]').forEach(th => th.onclick = () => {
  const k = th.dataset.k;
  sortDir = sortKey === k ? -sortDir : (k === 'name' || k === 'category' || k === 'first_seen' ? 1 : -1);
  sortKey = k; render();
});
['q','geo','cat','seen','mom','gap'].forEach(id => $('#'+id).addEventListener('input', render));

// Tabs — show one focused section at a time
function showTab(t) {
  document.querySelectorAll('.tabbtn').forEach(b => b.classList.toggle('active', b.dataset.tab === t));
  document.querySelectorAll('.tabpane').forEach(p => p.classList.toggle('active', p.id === 'tab-' + t));
  if (t === 'admin') renderAdmin();
  if (t === 'submit') renderSubmitGate();
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
$('#login-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
const ssi = $('#submit-signin'); if (ssi) ssi.onclick = (e) => { e.preventDefault(); openLogin(); };
const sform = $('#submit-form');
if (sform) sform.onsubmit = async (e) => {
  e.preventDefault();
  if (!ME) { openLogin(); return; }
  $('#sf-msg').textContent = 'Submitting…';
  const r = await api('/api/submit', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ appName: $('#sf-name').value, category: $('#sf-cat').value, market: $('#sf-market').value, pitch: $('#sf-pitch').value, details: {} }) });
  if (r.status === 401) { setMe(null); openLogin(); return; }
  $('#sf-msg').textContent = r.ok ? '✓ Submitted, thank you!' : (r.data.error || 'Failed');
  if (r.ok) { ['sf-name','sf-cat','sf-market','sf-pitch'].forEach(id => { $('#'+id).value=''; }); if (ME.role==='admin') renderAdmin(); }
};

// Shareable hash routing (#/plays, #/category etc.)
function routeFromHash(){ const t = (location.hash||'').replace('#/','') || 'home'; if (document.getElementById('tab-'+t)) showTab(t); }
window.addEventListener('hashchange', routeFromHash);

ME = meHint();
renderAuth();
renderHome();
render();
renderTopCharts();
routeFromHash();
loadState().then(refreshAll);`;

  const html = pageShell({ title: 'Play Database', active: 'apps', app: 'apps', body, script });
  const out = path.join(process.cwd(), 'public', 'index.html');
  mkdirSync(path.dirname(out), { recursive: true });
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
      log.info('dashboard publish skipped — create a public "dashboard" bucket in Supabase Storage to go live');
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
