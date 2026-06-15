/**
 * Apps dashboard: static rebuild from the store into public/index.html.
 * Read-only. Search + filters (geo, category, first_seen window, momentum
 * threshold, geo_gap only), sortable by momentum, rank sparkline per row.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { log } from '../lib/log.ts';
import { getStore } from '../lib/store.ts';
import { pageShell, embedJson, sparkline, esc } from '../lib/html.ts';

const DAY = 86_400_000;

export async function buildDashboard() {
  const store = getStore();
  const startedAt = new Date().toISOString();
  const since = new Date(Date.now() - 14 * DAY).toISOString();
  const [apps, rollups, snaps, analyses, scores] = await Promise.all([
    store.listApps(), store.listRollups(), store.listSnapshotsSince(since), store.listAnalyses(), store.listScores(),
  ]);
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

  // Curation for the shared "Play Database" page: show only startup-built apps that
  // are fast to vibecode. Incumbents (Spotify, Google Maps, ChatGPT-scale) and
  // slow/unanalyzed builds are dropped from the page — they stay in the DB, just
  // off this view. Tighten to ['weekend','few_days'] for a strict ≤1-week list.
  const QUICK_BUILD = new Set(['weekend', 'few_days', 'week_or_two']);
  const rows = rollups
    .map((r) => {
      const app = appById.get(r.app_id);
      if (!app) return null;
      if (app.status === 'too_complex') return null; // dropped by analysis; kept in DB only
      if (r.is_incumbent) return null; // no Spotify / Google Maps / ChatGPT-scale apps
      const an = analysisById.get(r.app_id);
      if (!QUICK_BUILD.has(an?.buildability ?? '')) return null; // only quick-to-vibecode startup apps
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
  const BUILD_SPEED: Record<string, number> = { weekend: 1, few_days: 0.85, week_or_two: 0.6 };
  for (const r of rows) {
    const ideaN = clamp01((r!.idea ?? 0) / 10);
    const momN = clamp01((r!.momentum ?? 0) / momCap);
    const openN = r!.sat == null ? 0.5 : clamp01(1 - r!.sat);
    const buildN = BUILD_SPEED[r!.build ?? ''] ?? 0.4;
    const tractionN = clamp01(Math.log10(1 + (r!.rating_count ?? 0)) / ratingMax);
    let s = 0.30 * ideaN + 0.24 * momN + 0.16 * openN + 0.12 * buildN + 0.18 * tractionN;
    if (r!.flag) s *= 0.6; // unverified / suspect traction → discount
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
    { name: 'X / Twitter', desc: 'traction claims → fact-check', env: 'APIFY_TOKEN' },
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

  const body = `
<style>
  tr.approw.play-top td { background: rgba(63,207,142,0.09); }
  tr.approw.play-top:hover td { background: rgba(63,207,142,0.16); }
  tr.approw.play-top td:first-child { box-shadow: inset 3px 0 0 0 var(--good); }
  .playbadge { display:inline-block; min-width:34px; text-align:center; padding:1px 6px; border-radius:99px; font-size:11px; font-weight:700; background:#10301f; color:var(--good); margin-left:6px; }
  .play-hi { color: var(--good); font-weight:700; }
</style>
<details class="panel" style="padding:10px 14px">
  <summary style="cursor:pointer;color:var(--dim)">Data sources — what updates automatically tonight</summary>
  <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:8px;margin-top:10px">${sourcesHtml}</div>
  <p class="muted-note">A source activates the moment its key is added as a GitHub secret — no code changes. Nothing auto-sends: Apollo leads and Instantly batches always pass the human approval gate.</p>
</details>
<div class="panel">
  <div class="filters" style="margin-bottom:10px">
    <b>Top charts</b>
    <label>Geo <select id="tc-geo"></select></label>
    <label>Chart <select id="tc-chart"></select></label>
    <span class="dim">top ${TOP_N} tracked apps per category · #n = store chart rank · ${esc(latestDay)} · click an app for details</span>
  </div>
  <div id="tc-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:10px"></div>
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
  <th data-k="play" class="num">Play ▾</th>
  <th data-k="name">App</th><th data-k="category">Category</th><th>Geos live</th>
  <th>Rank 14d</th><th data-k="momentum" class="num">Momentum</th>
  <th data-k="idea" class="num">Idea</th><th data-k="build">Build</th><th data-k="sat" class="num">Satur.</th>
  <th data-k="rating_count" class="num">Verified ratings</th><th>Fact check</th><th data-k="first_seen">First caught</th>
</tr></thead><tbody></tbody></table>
<p class="muted-note">Built ${esc(startedAt)} · ${rows.length} startup apps buildable in ≤2 weeks with AI · <b class="play-hi">top 100 plays</b> (by combined Play score: idea + momentum + open market + build speed + traction) highlighted green &amp; pinned on top · click a row for per-geo deltas &amp; analysis · incumbents &amp; slow/too-complex builds removed · read-only</p>
</div>`;

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
  $('#count').textContent = rows.length + ' shown';
  $('#t tbody').innerHTML = rows.map((r, i) => '<tr class="approw' + (r.play_rank <= 100 ? ' play-top' : '') + '" data-i="' + ROWS.indexOf(r) + '" style="cursor:pointer">' +
    '<td class="num"><b' + (r.play_rank <= 100 ? ' class="play-hi"' : '') + '>' + (r.play != null ? r.play.toFixed(1) : '–') + '</b>' + (r.play_rank <= 100 ? '<span class="playbadge">#' + r.play_rank + '</span>' : '') + '</td>' +
    '<td><b>' + escq(r.name) + '</b>' + (r.incumbent ? ' <span class="pill">incumbent</span>' : '') +
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
    if (e.target.closest('a')) return;
    const open = tr.nextElementSibling?.classList.contains('detail');
    document.querySelectorAll('tr.detail').forEach(d => d.remove());
    if (open) return;
    const r = ROWS[+tr.dataset.i];
    const d = document.createElement('tr');
    d.className = 'detail';
    d.innerHTML = '<td colspan="12" style="background:#11161f;padding:14px 18px">' + detailHtml(r) + '</td>';
    tr.after(d);
  });
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
  return '<div style="display:flex;gap:28px;flex-wrap:wrap">' +
    '<div><h4 style="margin:0 0 6px">Rank deltas (7d) per geo</h4>' +
      '<table style="min-width:320px"><thead><tr><th>Geo</th><th class="num">Rank now</th><th class="num">Rank -7d</th><th class="num">Velocity</th><th class="num">Rating growth</th></tr></thead>' +
      '<tbody>' + (deltaRows || '<tr><td colspan="5" class="dim">no per-geo scores yet</td></tr>') + '</tbody></table></div>' +
    '<div style="max-width:520px"><h4 style="margin:0 0 6px">Analysis</h4>' +
      (an ? (
        '<p style="margin:4px 0"><b>Idea ' + (r.idea ?? '–') + '/10</b> — ' + escq(r.idea_note||'') + '</p>' +
        '<p style="margin:4px 0"><b>Buildability: ' + escq(r.build||'–') + '</b> — ' + escq(r.build_note||'') + '</p>' +
        '<p style="margin:4px 0"><b>Saturation ' + (r.sat != null ? (r.sat * 100).toFixed(0) + '%' : '–') + '</b> — ' + escq(r.sat_note||'') + '</p>'
      ) : '<p class="dim">not analyzed yet — top-momentum apps are analyzed nightly</p>') +
      '<p style="margin:8px 0 0"><a href="' + escq(r.store_url) + '" target="_blank" style="color:var(--acc)">open store listing ↗</a></p></div></div>';
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
render();
renderTopCharts();`;

  const html = pageShell({ title: 'Play Database', active: 'apps', app: 'apps', body, script });
  const out = path.join(process.cwd(), 'public', 'index.html');
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, html);
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
