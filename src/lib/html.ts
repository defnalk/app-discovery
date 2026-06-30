/** Shared page shell: top nav (Apps | Leads), dark minimal styling. */

export const NAV = [
  { key: 'apps', label: 'Apps', href: '/' },
  { key: 'pipeline', label: 'Pipeline', href: '/leads' },
  { key: 'approvals', label: 'Approval Queue', href: '/leads/approvals' },
  { key: 'campaigns', label: 'Campaigns', href: '/leads/campaigns' },
  { key: 'performance', label: 'Performance', href: '/leads/performance' },
  { key: 'strategy', label: 'Strategy', href: '/leads/strategy' },
  { key: 'settings', label: 'Settings', href: '/leads/settings' },
] as const;

export const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** JSON safe to embed inside a <script> tag. */
export const embedJson = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');

export function pageShell(opts: { title: string; active: string; body: string; script?: string; app?: 'apps' | 'leads' }) {
  const app = opts.app ?? (opts.active === 'apps' ? 'apps' : 'leads');
  const tabs = app === 'apps' ? NAV.filter((n) => n.key === 'apps') : NAV.filter((n) => n.key !== 'apps');
  const brand = app === 'apps' ? 'Plays Database' : '8x leads';
  const tab = (n: (typeof NAV)[number]) =>
    `<a href="${n.href}" class="tab${opts.active === n.key ? ' active' : ''}">${n.label}</a>`;
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(opts.title)}</title>
<style>
  /* ── Design system v1 ─────────────────────────────────────────────── */
  :root {
    --bg:#0c0f14; --bg-elev:#11151c; --panel:#161b24; --panel-2:#1b212c;
    --line:#262d3b; --line-2:#313a4c;
    --txt:#e7ecf4; --txt-2:#aab6c8; --dim:#909cb0;
    --acc:#4da3ff; --acc-2:#76b8ff; --acc-ink:#06121f;
    --good:#3fcf8e; --good-bg:#0f2e20; --warn:#ffb347; --warn-bg:#352711; --bad:#ff6b6b; --bad-bg:#3a1414;
    --r-sm:6px; --r:9px; --r-lg:13px; --r-full:999px;
    --shadow:0 1px 0 rgba(0,0,0,.05), 0 14px 30px -20px rgba(0,0,0,.6);
    --ring:0 0 0 3px rgba(77,163,255,.35);
    --ease:cubic-bezier(.4,0,.2,1);
    --font:ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
    --mono:ui-monospace,'SF Mono','JetBrains Mono',Menlo,monospace;
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--txt); font-family:var(--font); font-size:14px; line-height:1.55; -webkit-font-smoothing:antialiased; text-rendering:optimizeLegibility; }
  h1,h2,h3,h4 { letter-spacing:-.012em; }
  a { color:var(--acc); text-decoration:none; transition:color .15s var(--ease); } a:hover { color:var(--acc-2); }
  ::selection { background:rgba(77,163,255,.28); }
  a:focus-visible, button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible, [tabindex]:focus-visible, summary:focus-visible { outline:none; box-shadow:var(--ring); border-radius:var(--r-sm); }
  header { display:flex; align-items:center; gap:18px; padding:13px 22px; border-bottom:1px solid var(--line); background:linear-gradient(180deg,var(--panel),var(--bg-elev)); flex-wrap:wrap; }
  header h1 { font-size:17px; font-weight:700; margin:0 14px 0 0; white-space:nowrap; line-height:1; letter-spacing:-.02em; }
  .navgroup { display:flex; gap:2px; align-items:center; flex-wrap:wrap; }
  .tab { color:var(--dim); text-decoration:none; padding:6px 11px; border-radius:var(--r-sm); font-weight:600; font-size:13.5px; transition:background .15s var(--ease),color .15s var(--ease); }
  .tab.active { color:var(--txt); background:var(--line); }
  .tab:hover { color:var(--txt); background:rgba(255,255,255,.04); }
  main { padding:22px 22px 56px; max-width:1500px; margin:0 auto; }
  .panel { background:var(--panel); border:1px solid var(--line); border-radius:var(--r-lg); padding:16px; margin-bottom:16px; box-shadow:var(--shadow); }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th, td { text-align:left; padding:9px 11px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--dim); font-weight:600; cursor:pointer; user-select:none; white-space:nowrap; position:sticky; top:0; background:var(--panel); z-index:2; letter-spacing:.01em; }
  th.sorth:hover, th:hover { color:var(--acc); }
  tbody tr { transition:background .12s var(--ease); }
  tr:hover td { background:rgba(255,255,255,.028); }
  input[type=text], input[type=search], select, input[type=number], input[type=date], textarea {
    background:var(--bg-elev); color:var(--txt); border:1px solid var(--line-2); border-radius:var(--r-sm); padding:7px 10px; font-size:13px; font-family:inherit; transition:border-color .15s var(--ease),box-shadow .15s var(--ease); }
  input:focus, select:focus, textarea:focus { outline:none; border-color:var(--acc); box-shadow:var(--ring); }
  ::placeholder { color:var(--dim); opacity:.85; }
  .filters { display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
  .filters label { color:var(--dim); font-size:12px; display:flex; gap:6px; align-items:center; }
  .pill { display:inline-block; padding:2px 8px; border-radius:var(--r-full); font-size:11px; font-weight:500; background:var(--line); color:var(--txt-2); margin:0 3px 2px 0; }
  .pill.gap { background:var(--warn-bg); color:var(--warn); }
  .pill.new { background:var(--good-bg); color:var(--good); }
  .flag { color:var(--bad); font-weight:700; }
  .dim { color:var(--dim); }
  .num { text-align:right; font-variant-numeric:tabular-nums; }
  .stat { display:inline-flex; flex-direction:column; padding:10px 16px; border:1px solid var(--line); border-radius:var(--r); margin:0 8px 8px 0; min-width:110px; cursor:pointer; background:var(--panel); transition:border-color .15s var(--ease),transform .12s var(--ease); }
  .stat:hover { border-color:var(--line-2); transform:translateY(-1px); }
  .stat b { font-size:20px; font-weight:700; }
  .stat span { color:var(--dim); font-size:11px; }
  .stat.active { border-color:var(--acc); }
  button { background:var(--acc); color:var(--acc-ink); border:0; border-radius:var(--r-sm); padding:8px 15px; font-weight:600; cursor:pointer; font-size:13px; font-family:inherit; transition:filter .15s var(--ease),transform .05s var(--ease); }
  button:hover { filter:brightness(1.08); }
  button:active { transform:translateY(1px); }
  button:disabled { opacity:.5; cursor:not-allowed; }
  button.ghost { background:var(--line); color:var(--txt); } button.ghost:hover { background:var(--line-2); filter:none; }
  button.danger { background:var(--bad); color:#fff; }
  .muted-note { color:var(--dim); font-size:12px; margin-top:6px; }
  sparkline, svg.spark { display:block; }
  .skeleton { position:relative; overflow:hidden; background:var(--line); border-radius:var(--r-sm); }
  .skeleton::after { content:''; position:absolute; inset:0; transform:translateX(-100%); background:linear-gradient(90deg,transparent,rgba(255,255,255,.06),transparent); animation:shimmer 1.3s infinite; }
  @keyframes shimmer { 100% { transform:translateX(100%); } }
  @media (prefers-reduced-motion:reduce){ *{ animation:none!important; transition:none!important; } }
</style></head>
<body>
<header>
  <h1><a href="${app === 'apps' ? '/' : '/leads'}" style="color:inherit;text-decoration:none" title="Back to ${brand}">${brand}</a></h1>
  <nav class="navgroup">${tabs.map(tab).join('')}</nav>
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
  if (pts.length < 2) return `<span class="dim">-</span>`;
  return `<svg class="spark" width="${w}" height="${h}"><polyline points="${pts.join(' ')}" fill="none" stroke="#4da3ff" stroke-width="1.5"/></svg>`;
}
