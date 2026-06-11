/**
 * Apps dashboard: static rebuild from the store into public/index.html.
 * Read-only. Search + filters (geo, category, first_seen window, momentum
 * threshold, geo_gap only), sortable by momentum, rank sparkline per row.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { log } from '../lib/log.ts';
import { getStore } from '../lib/store.ts';
import { pageShell, embedJson, sparkline, esc } from '../lib/html.ts';

const DAY = 86_400_000;

export async function buildDashboard() {
  const store = getStore();
  const startedAt = new Date().toISOString();
  const since = new Date(Date.now() - 14 * DAY).toISOString();
  const [apps, rollups, snaps] = await Promise.all([
    store.listApps(), store.listRollups(), store.listSnapshotsSince(since),
  ]);
  const appById = new Map(apps.map((a) => [a.id, a]));

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

  const rows = rollups
    .map((r) => {
      const app = appById.get(r.app_id);
      if (!app) return null;
      const series = days.map((d) => rankByAppDay.get(r.app_id)?.get(d) ?? null);
      return {
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
      };
    })
    .filter((r) => r != null)
    .sort((a, b) => b!.momentum - a!.momentum);

  const categories = [...new Set(rows.map((r) => r!.category).filter(Boolean))].sort();
  const geos = [...new Set(rows.flatMap((r) => r!.geos))].sort();

  const body = `
<div class="panel filters">
  <input type="search" id="q" placeholder="Search name / developer…" style="min-width:220px">
  <label>Geo <select id="geo"><option value="">all</option>${geos.map((g) => `<option>${esc(g)}</option>`).join('')}</select></label>
  <label>Category <select id="cat"><option value="">all</option>${categories.map((c) => `<option>${esc(c)}</option>`).join('')}</select></label>
  <label>First seen <select id="seen"><option value="">any time</option><option value="7">last 7d</option><option value="30">last 30d</option><option value="90">last 90d</option></select></label>
  <label>Momentum ≥ <input type="number" id="mom" step="0.05" style="width:70px"></label>
  <label><input type="checkbox" id="gap"> geo-gap only</label>
  <label><input type="checkbox" id="hideinc" checked> hide incumbents</label>
  <span class="dim" id="count"></span>
</div>
<div class="panel" style="overflow-x:auto">
<table id="t"><thead><tr>
  <th data-k="name">App</th><th data-k="category">Category</th><th>Geos live</th>
  <th>Rank 14d</th><th data-k="momentum" class="num">Momentum ▾</th><th data-k="best_rank" class="num">Best rank</th>
  <th data-k="rating_count" class="num">Verified ratings</th><th>Fact check</th><th data-k="first_seen">First caught</th>
</tr></thead><tbody></tbody></table>
<p class="muted-note">Built ${esc(startedAt)} · ${rows.length} apps · incumbents kept but excluded from shortlist · read-only</p>
</div>`;

  const script = `
const ROWS = ${embedJson(rows)};
const $ = (s) => document.querySelector(s);
let sortKey = 'momentum', sortDir = -1;
const fmt = (n) => n == null ? '–' : n >= 1e6 ? (n/1e6).toFixed(1)+'M' : n >= 1e3 ? (n/1e3).toFixed(1)+'k' : String(n);
function render() {
  const q = $('#q').value.toLowerCase(), geo = $('#geo').value, cat = $('#cat').value;
  const seen = $('#seen').value ? Date.now() - (+$('#seen').value)*864e5 : null;
  const mom = $('#mom').value === '' ? null : +$('#mom').value;
  const gap = $('#gap').checked, hideInc = $('#hideinc').checked;
  let rows = ROWS.filter(r =>
    (!q || r.name.toLowerCase().includes(q) || (r.developer||'').toLowerCase().includes(q)) &&
    (!geo || r.geos.includes(geo)) && (!cat || r.category === cat) &&
    (seen == null || new Date(r.first_seen).getTime() >= seen) &&
    (mom == null || r.momentum >= mom) && (!gap || r.geo_gap.length) && (!hideInc || !r.incumbent));
  if (typeof rows[0]?.[sortKey] === 'string') rows.sort((a,b)=> (a[sortKey]||'').localeCompare(b[sortKey]||'') * sortDir);
  else rows.sort((a,b)=> ((a[sortKey]??-Infinity) - (b[sortKey]??-Infinity)) * sortDir);
  $('#count').textContent = rows.length + ' shown';
  $('#t tbody').innerHTML = rows.map(r => '<tr>' +
    '<td><b>' + escq(r.name) + '</b>' + (r.incumbent ? ' <span class="pill">incumbent</span>' : '') +
      '<br><span class="dim">' + escq(r.developer||'') + ' · ' + r.store + '</span></td>' +
    '<td>' + escq(r.category||'–') + '</td>' +
    '<td>' + r.geos.map(g => '<span class="pill' + (r.new_geos.includes(g) ? ' new' : '') + '">' + g + '</span>').join('') +
      (r.geo_gap.length ? '<br><span class="dim">gap:</span> ' + r.geo_gap.map(g => '<span class="pill gap">' + g + '</span>').join('') : '') + '</td>' +
    '<td>' + r.spark + '</td>' +
    '<td class="num"><b>' + r.momentum.toFixed(2) + '</b></td>' +
    '<td class="num">' + (r.best_rank ?? '–') + '</td>' +
    '<td class="num">' + fmt(r.rating_count) + '</td>' +
    '<td>' + (r.flag ? '<span class="flag">⚠ suspect</span>' : '<span class="dim">ok</span>') + '</td>' +
    '<td>' + r.first_seen + '</td></tr>').join('');
}
function escq(s){ const d=document.createElement('div'); d.textContent=s; return d.innerHTML; }
document.querySelectorAll('th[data-k]').forEach(th => th.onclick = () => {
  const k = th.dataset.k;
  sortDir = sortKey === k ? -sortDir : (k === 'name' || k === 'category' || k === 'first_seen' ? 1 : -1);
  sortKey = k; render();
});
['q','geo','cat','seen','mom','gap','hideinc'].forEach(id => $('#'+id).addEventListener('input', render));
render();`;

  const html = pageShell({ title: 'App discovery', active: 'apps', body, script });
  const out = path.join(process.cwd(), 'public', 'index.html');
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, html);
  await store.recordRun('dashboard', startedAt, true, { rows: rows.length });
  log.info(`dashboard: ${rows.length} rows -> public/index.html`);
  return { rows: rows.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  buildDashboard().then((r) => log.info('dashboard build done', r));
}
