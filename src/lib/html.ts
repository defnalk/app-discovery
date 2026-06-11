/** Shared page shell: top nav (Apps | Leads), dark minimal styling. */

export const NAV = [
  { key: 'apps', label: 'Apps', href: '/' },
  { key: 'pipeline', label: 'Pipeline', href: '/leads' },
  { key: 'approvals', label: 'Approval Queue', href: '/leads/approvals' },
  { key: 'performance', label: 'Performance', href: '/leads/performance' },
  { key: 'settings', label: 'Settings', href: '/leads/settings' },
] as const;

export const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** JSON safe to embed inside a <script> tag. */
export const embedJson = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');

export function pageShell(opts: { title: string; active: string; body: string; script?: string }) {
  const appsTabs = NAV.filter((n) => n.key === 'apps');
  const leadTabs = NAV.filter((n) => n.key !== 'apps');
  const tab = (n: (typeof NAV)[number]) =>
    `<a href="${n.href}" class="tab${opts.active === n.key ? ' active' : ''}">${n.label}</a>`;
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(opts.title)}</title>
<style>
  :root { --bg:#0e1116; --panel:#161b24; --line:#252c3a; --txt:#dbe2ee; --dim:#8694ab; --acc:#4da3ff; --good:#3fcf8e; --warn:#ffb347; --bad:#ff6b6b; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--txt); font:14px/1.5 -apple-system,'Segoe UI',Roboto,sans-serif; }
  header { display:flex; align-items:center; gap:18px; padding:10px 20px; border-bottom:1px solid var(--line); background:var(--panel); position:sticky; top:0; z-index:5; flex-wrap:wrap; }
  header h1 { font-size:15px; margin:0 14px 0 0; white-space:nowrap; }
  .navgroup { display:flex; gap:4px; align-items:center; }
  .navgroup .grouplabel { color:var(--dim); font-size:11px; text-transform:uppercase; letter-spacing:.08em; margin:0 6px; }
  .tab { color:var(--dim); text-decoration:none; padding:5px 10px; border-radius:6px; }
  .tab.active { color:var(--txt); background:var(--line); }
  .tab:hover { color:var(--txt); }
  main { padding:18px 20px; max-width:1500px; margin:0 auto; }
  .panel { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:14px; margin-bottom:16px; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th, td { text-align:left; padding:7px 9px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--dim); font-weight:600; cursor:pointer; user-select:none; white-space:nowrap; position:sticky; top:49px; background:var(--panel); }
  tr:hover td { background:#1a2130; }
  input[type=text], input[type=search], select, input[type=number], input[type=date] {
    background:var(--bg); color:var(--txt); border:1px solid var(--line); border-radius:6px; padding:6px 9px; font-size:13px; }
  .filters { display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
  .filters label { color:var(--dim); font-size:12px; display:flex; gap:6px; align-items:center; }
  .pill { display:inline-block; padding:1px 7px; border-radius:99px; font-size:11px; background:var(--line); color:var(--txt); margin:0 3px 2px 0; }
  .pill.gap { background:#3b2a14; color:var(--warn); }
  .pill.new { background:#10301f; color:var(--good); }
  .flag { color:var(--bad); font-weight:700; }
  .dim { color:var(--dim); }
  .num { text-align:right; font-variant-numeric:tabular-nums; }
  .stat { display:inline-flex; flex-direction:column; padding:10px 16px; border:1px solid var(--line); border-radius:10px; margin:0 8px 8px 0; min-width:110px; cursor:pointer; background:var(--panel); }
  .stat b { font-size:20px; }
  .stat span { color:var(--dim); font-size:11px; }
  .stat.active { border-color:var(--acc); }
  button { background:var(--acc); color:#06121f; border:0; border-radius:6px; padding:7px 14px; font-weight:600; cursor:pointer; font-size:13px; }
  button.ghost { background:var(--line); color:var(--txt); }
  button.danger { background:var(--bad); color:#1d0606; }
  .muted-note { color:var(--dim); font-size:12px; margin-top:6px; }
  sparkline, svg.spark { display:block; }
</style></head>
<body>
<header>
  <h1>8x discovery</h1>
  <nav class="navgroup"><span class="grouplabel">Apps</span>${appsTabs.map(tab).join('')}</nav>
  <nav class="navgroup"><span class="grouplabel">Leads</span>${leadTabs.map(tab).join('')}</nav>
</header>
<main>${opts.body}</main>
${opts.script ? `<script>${opts.script}</script>` : ''}
</body></html>`;
}

/** Inline SVG sparkline for rank-over-time (lower rank = higher point). */
export function sparkline(ranks: (number | null)[], maxRank = 100): string {
  const w = 110, h = 26;
  const pts = ranks
    .map((r, i) => (r == null ? null : `${(i / Math.max(ranks.length - 1, 1)) * w},${(Math.min(r, maxRank) / maxRank) * (h - 4) + 2}`))
    .filter(Boolean);
  if (pts.length < 2) return `<span class="dim">–</span>`;
  return `<svg class="spark" width="${w}" height="${h}"><polyline points="${pts.join(' ')}" fill="none" stroke="#4da3ff" stroke-width="1.5"/></svg>`;
}
