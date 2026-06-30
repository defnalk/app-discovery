/**
 * Competitive Analysis section: product-side equivalent of the social-listening
 * tool. A Play manager enters an app + category; GET /compete renders the form
 * and a results shell, GET /compete/run streams the workflow's progress and the
 * final structured breakdown over Server-Sent Events. Read-only, no writes, no
 * gates. Registered on the apps server, the leads server, and the Vercel entry.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { pageShell, esc, embedJson } from '../lib/html.ts';
import { log } from '../lib/log.ts';
import { runCompetitiveAnalysis, type ProgressEvent } from './competitive.ts';
import { saveAnalysis, listAnalyses, getAnalysis, type AnalysisSummary } from './history.ts';

type Handler = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void> | void;

// ---------------------------------------------------------------- page
export async function competePage(
  _req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  opts: { app?: 'apps' | 'leads'; runBase?: string } = {},
) {
  const app = url.searchParams.get('app') ?? '';
  const category = url.searchParams.get('category') ?? '';
  const id = url.searchParams.get('id') ?? '';
  const runBase = opts.runBase ?? '/compete/run';

  // Load the saved history list, plus a specific past analysis if ?id= is set,
  // so the page restores prior runs without re-calling Claude. A store hiccup
  // must not blank the page, degrade to an empty history.
  let history: AnalysisSummary[] = [];
  let initial: unknown = null;
  try {
    [history, initial] = await Promise.all([
      listAnalyses(),
      id ? getAnalysis(id) : Promise.resolve(null),
    ]);
  } catch (err) {
    log.warn('compete: failed to load history', { err: String(err) });
  }

  const body = `
<style>
  /* Light / editorial theme to match the Plays dashboard (scoped to this page). */
  @import url('https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500..800&family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap');
  :root {
    --paper:#EFEEE9; --surface:#FCFBF8; --surface-2:#F6F4EE; --ink:#1B1B1A; --muted:#6E6E66; --faint:#9A9A90;
    --go:#0E7C66; --go-dark:#0A5F4E; --go-tint:#E4EFEA; --amber:#B97514; --rust:#B2462E;
    --display:"Bricolage Grotesque",Georgia,serif; --sans:"IBM Plex Sans",system-ui,sans-serif; --mono:"IBM Plex Mono",ui-monospace,monospace;
    --bg:#EFEEE9; --bg-elev:#FCFBF8; --panel:#FCFBF8; --panel-2:#F6F4EE; --line:#DDDCD3; --line-2:#CDCBC0;
    --txt:#1B1B1A; --txt-2:#6E6E66; --dim:#6E6E66; --acc:#0E7C66; --acc-2:#0A5F4E; --acc-ink:#FFFFFF;
    --good:#0E7C66; --warn:#B97514; --bad:#B2462E;
    --shadow:0 1px 0 rgba(0,0,0,.03), 0 10px 30px -18px rgba(0,0,0,.28); --ring:0 0 0 3px rgba(14,124,102,.25);
  }
  body { background:var(--paper); color:var(--ink); font-family:var(--sans); }
  h1,h2,h3,h4 { font-family:var(--display); letter-spacing:-.02em; }
  header { background:linear-gradient(180deg,var(--surface),var(--paper)); }
  header h1 { font-family:var(--display); font-weight:800; display:inline-flex; align-items:center; gap:11px; }
  header h1::before { content:'P'; display:grid; place-items:center; width:34px; height:34px; border-radius:9px; background:var(--ink); color:var(--paper); font-size:19px; transform:rotate(-4deg); flex:none; }
  .panel { background:var(--surface); box-shadow:var(--shadow); }
  button { color:#fff; } button:hover { filter:brightness(1.06); }
  input, select, textarea { background:var(--surface); }
  .cform { display:flex; gap:10px; flex-wrap:wrap; align-items:flex-end; }
  .cform label { display:flex; flex-direction:column; gap:4px; color:var(--dim); font-size:12px; }
  .cform input { min-width:240px; }
  #steps { display:flex; gap:10px; flex-wrap:wrap; margin-top:4px; }
  .pstep { display:flex; align-items:center; gap:8px; padding:8px 12px; border:1px solid var(--line); border-radius:10px; background:var(--panel); color:var(--dim); font-size:13px; }
  .pstep.active { border-color:var(--acc); color:var(--txt); }
  .pstep.done { border-color:var(--good); color:var(--txt); }
  .pstep .dot { width:9px; height:9px; border-radius:99px; background:var(--line); }
  .pstep.active .dot { background:var(--acc); animation:pulse 1s infinite; }
  .pstep.done .dot { background:var(--good); }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.3} }
  .ccard { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:16px; margin-bottom:14px; }
  .ccard h3 { margin:0 0 2px; font-size:16px; }
  .ccard .sub { color:var(--dim); font-size:12px; margin-bottom:10px; }
  .cgrid { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
  @media (max-width:860px){ .cgrid { grid-template-columns:1fr; } }
  .blk h4 { margin:0 0 6px; font-size:12px; text-transform:uppercase; letter-spacing:.04em; color:var(--dim); }
  .tier { border:1px solid var(--line); border-radius:8px; padding:8px 10px; margin-bottom:6px; }
  .tier b { color:var(--acc); }
  .icpmap { width:100%; border-collapse:collapse; font-size:12.5px; }
  .icpmap th, .icpmap td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
  .icpmap th { color:var(--dim); font-weight:600; }
  .icpmap .feat { color:var(--txt); font-weight:600; white-space:nowrap; }
  .icpmap .icp { color:var(--good); }
  .icp-tag { display:inline-block; background:var(--go-tint); color:var(--go-dark); padding:2px 8px; border-radius:99px; font-size:11px; margin:0 4px 4px 0; }
  .errbox { border-color:var(--bad) !important; color:var(--bad); }
  #histlist { list-style:none; margin:0; padding:0; }
  #histlist li { border-bottom:1px solid var(--line); }
  #histlist li:last-child { border-bottom:0; }
  .histrow { display:flex; gap:10px; align-items:baseline; padding:8px 6px; color:var(--txt); text-decoration:none; border-radius:6px; }
  .histrow:hover { background:var(--surface-2); }
  .histrow .hname { font-weight:600; }
  .histrow .hcat { color:var(--dim); }
  .histrow .hmeta { margin-left:auto; color:var(--dim); font-size:12px; white-space:nowrap; }
</style>
<p style="margin:0 0 14px"><a href="/" style="color:var(--go-dark);font-weight:600;text-decoration:none;font-size:14px">&larr; Back to Plays Database</a></p>
<div class="panel">
  <h2 style="margin:0 0 4px;font-size:18px">Competitive Analysis</h2>
  <p class="dim" style="margin:0 0 12px">Drop in an app and its category to map the competitive landscape, pricing, markets, feature sets, and which features serve which ICP. The product-side counterpart to the campaign social-listening tool.</p>
  <form id="cform" class="cform">
    <label>App <input type="text" id="app" name="app" placeholder="e.g. Luma" value="${esc(app)}" required></label>
    <label>Category / positioning <input type="text" id="category" name="category" placeholder="e.g. AI therapy" value="${esc(category)}" required></label>
    <button type="submit" id="runbtn">Analyze landscape</button>
  </form>
</div>

<div class="panel" id="progress" style="display:none">
  <div id="steps">
    <div class="pstep" data-k="discover"><span class="dot"></span><span>Finding competitors</span></div>
    <div class="pstep" data-k="fetch"><span class="dot"></span><span>Fetching store data</span></div>
    <div class="pstep" data-k="analyze"><span class="dot"></span><span>Analyzing with Claude</span></div>
  </div>
  <p class="dim" id="pdetail" style="margin:10px 0 0"></p>
</div>

<div id="results"></div>

<div class="panel" id="histpanel" style="${history.length ? '' : 'display:none'}">
  <h3 style="margin:0 0 8px;font-size:14px">Past analyses</h3>
  <ul id="histlist"></ul>
</div>

<script>
const RUN_BASE = ${JSON.stringify(runBase)};
const INITIAL = ${embedJson(initial)};
let HISTORY = ${embedJson(history)};
const $ = (s) => document.querySelector(s);
function escq(s){ const d=document.createElement('div'); d.textContent=s==null?'':String(s); return d.innerHTML; }

function setStep(k, status, detail){
  document.querySelectorAll('.pstep').forEach(el=>{
    if(el.dataset.k===k){ el.classList.remove('active','done'); el.classList.add(status==='done'?'done':'active'); }
  });
  if(detail) $('#pdetail').textContent = detail;
}

function renderResult(data){
  const r = $('#results');
  const meta = data.meta || {};
  const icps = (data.icps||[]).map(i=>'<span class="icp-tag">'+escq(i)+'</span>').join('');
  let html = '<div class="panel">'+
    '<h2 style="margin:0 0 6px;font-size:18px">'+escq(data.app)+', competitive landscape <span class="dim" style="font-size:13px">· '+escq(data.category)+'</span></h2>'+
    (data.summary?'<p style="margin:0 0 10px;line-height:1.6">'+escq(data.summary)+'</p>':'')+
    (icps?'<div><span class="dim" style="font-size:12px">ICPs in this category:</span><br>'+icps+'</div>':'')+
    '<p class="dim" style="margin:10px 0 0;font-size:12px">'+(data.competitors||[]).length+' competitors · '+escq(meta.model||'')+(meta.web_search?' · web-enriched':'')+' · '+(meta.candidates_found||0)+' candidates from '+escq((meta.sources||[]).join(', ')||'model knowledge')+'</p>'+
  '</div>';

  for(const c of (data.competitors||[])){
    const tiers = (c.pricing&&c.pricing.tiers||[]).map(t=>
      '<div class="tier"><b>'+escq(t.name)+'</b>, '+escq(t.price)+(t.billing?' <span class="dim">('+escq(t.billing)+')</span>':'')+
      ((t.highlights||[]).length?'<br><span class="dim" style="font-size:12px">'+(t.highlights||[]).map(escq).join(' · ')+'</span>':'')+'</div>').join('') || '<span class="dim">, </span>';
    const markets = (c.markets||[]).map(m=>'<span class="pill">'+escq(m)+'</span>').join('') || '<span class="dim">, </span>';
    const features = (c.features||[]).map(f=>'<span class="pill">'+escq(f)+'</span>').join('') || '<span class="dim">, </span>';
    const icpRows = (c.feature_icp_map||[]).map(m=>
      '<tr><td class="feat">'+escq(m.feature)+'</td><td class="icp">'+escq(m.icp)+'</td><td class="dim">'+escq(m.rationale)+'</td></tr>').join('')
      || '<tr><td colspan="3" class="dim">No feature→ICP mapping returned</td></tr>';
    html += '<div class="ccard">'+
      '<h3>'+escq(c.name)+'</h3>'+
      '<div class="sub">'+escq(c.developer||'')+(c.developer&&c.positioning?' · ':'')+escq(c.positioning||'')+'</div>'+
      '<div class="cgrid">'+
        '<div class="blk"><h4>Pricing, '+escq((c.pricing&&c.pricing.model)||'unknown')+'</h4>'+tiers+'</div>'+
        '<div class="blk"><h4>Markets</h4><div>'+markets+'</div>'+
          '<h4 style="margin-top:12px">Features</h4><div>'+features+'</div></div>'+
      '</div>'+
      '<div class="blk" style="margin-top:14px"><h4>Feature → ICP mapping</h4>'+
        '<table class="icpmap"><thead><tr><th>Feature</th><th>ICP it serves</th><th>Why it wins</th></tr></thead><tbody>'+icpRows+'</tbody></table></div>'+
      (c.notes?'<p class="dim" style="margin:12px 0 0"><b>Notes:</b> '+escq(c.notes)+'</p>':'')+
    '</div>';
  }
  r.innerHTML = html;
}

function showError(msg){
  $('#results').innerHTML = '<div class="panel errbox"><b>Analysis failed.</b> '+escq(msg)+'</div>';
}

function fmtWhen(s){ if(!s) return ''; try{ return new Date(s).toLocaleString(); }catch{ return s; } }
function renderHistory(){
  const panel=$('#histpanel'), list=$('#histlist');
  if(!HISTORY.length){ panel.style.display='none'; return; }
  panel.style.display='block';
  list.innerHTML = HISTORY.map(h=>
    '<li><a class="histrow" href="?id='+encodeURIComponent(h.id)+'">'+
      '<span class="hname">'+escq(h.app)+'</span><span class="hcat">'+escq(h.category)+'</span>'+
      '<span class="hmeta">'+(h.competitors||0)+' competitors'+(h.web_search?' · web':'')+' · '+escq(fmtWhen(h.generated_at))+'</span>'+
    '</a></li>').join('');
}

let es = null;
function run(app, category){
  if(es) es.close();
  $('#runbtn').disabled = true;
  $('#progress').style.display = 'block';
  $('#results').innerHTML = '';
  document.querySelectorAll('.pstep').forEach(el=>el.classList.remove('active','done'));
  $('#pdetail').textContent = 'Starting…';
  let got = false, finished = false; // finished = a terminal event arrived (result/error/done)

  es = new EventSource(RUN_BASE + (RUN_BASE.includes('?')?'&':'?') + 'app='+encodeURIComponent(app)+'&category='+encodeURIComponent(category));
  es.addEventListener('step', (ev)=>{ const d=JSON.parse(ev.data); setStep(d.step, d.status, d.detail); });
  es.addEventListener('result', (ev)=>{ got=true; const data=JSON.parse(ev.data); renderResult(data);
    if(data.id){
      HISTORY = [{id:data.id, app:data.app, category:data.category, generated_at:(data.meta||{}).generated_at, competitors:(data.competitors||[]).length, web_search:(data.meta||{}).web_search}].concat(HISTORY.filter(h=>h.id!==data.id));
      renderHistory();
      history.replaceState(null,'','?id='+encodeURIComponent(data.id));
    }
  });
  es.addEventListener('error', (ev)=>{ finished=true; if(ev.data){ try{ showError(JSON.parse(ev.data).message);}catch{ showError('stream error'); } } });
  es.addEventListener('done', ()=>{ finished=true; es.close(); $('#runbtn').disabled=false; $('#progress').style.display = got?'none':'block'; });
  // EventSource fires onerror on a normal server close too, only treat it as a
  // dropped connection if no terminal event (result/error/done) arrived first.
  es.onerror = ()=>{ if(!got && !finished){ showError('Connection lost before the analysis finished.'); } es.close(); $('#runbtn').disabled=false; };
}

$('#cform').addEventListener('submit', (e)=>{
  e.preventDefault();
  const app=$('#app').value.trim(), category=$('#category').value.trim();
  if(!app||!category) return;
  history.replaceState(null,'','/compete?app='+encodeURIComponent(app)+'&category='+encodeURIComponent(category));
  run(app, category);
});

renderHistory();
if(INITIAL){
  // Loaded a saved analysis (?id=), restore it without re-running.
  $('#app').value = INITIAL.app || '';
  $('#category').value = INITIAL.category || '';
  renderResult(INITIAL);
} else if($('#app').value.trim() && $('#category').value.trim()){
  // Fresh ?app&category link, run it.
  run($('#app').value.trim(), $('#category').value.trim());
}
</script>`;

  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(pageShell({ title: 'Competitive Analysis', active: 'compete', app: opts.app, body }));
}

// ---------------------------------------------------------------- SSE run
export async function competeRun(_req: IncomingMessage, res: ServerResponse, url: URL) {
  const app = (url.searchParams.get('app') ?? '').trim();
  const category = (url.searchParams.get('category') ?? '').trim();

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no', // disable proxy buffering so events flush immediately
  });
  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  if (!app || !category) {
    send('error', { message: 'Both an app and a category are required.' });
    send('done', {});
    res.end();
    return;
  }

  // Heartbeat keeps intermediaries from closing the idle connection during the
  // (potentially slow) Claude call.
  const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 15_000);
  try {
    const onProgress = (e: ProgressEvent) => send('step', e);
    const result = await runCompetitiveAnalysis(app, category, onProgress);
    // Persist so it stays in the history list; a save failure must not lose the
    // result the user is about to see.
    try { result.id = await saveAnalysis(result); }
    catch (saveErr) { log.warn('compete: failed to persist analysis', { err: String(saveErr) }); }
    send('result', result);
  } catch (err) {
    log.error('compete: run failed', { err: String(err), app, category });
    send('error', { message: err instanceof Error ? err.message : String(err) });
  } finally {
    clearInterval(heartbeat);
    send('done', {});
    res.end();
  }
}

export function registerCompeteRoutes(routes: Map<string, Handler>) {
  // Competitive analysis is a product-side (Play Database) feature, so render it
  // with the apps nav. In production it is served by the Play Database project's
  // own serverless function (src/compete/apps-entry.ts → public/api/compete.mjs);
  // this registration is for the local apps dev server.
  routes.set('GET /compete', (req, res, url) => competePage(req, res, url, { app: 'apps' }));
  routes.set('GET /compete/run', competeRun); // SSE: progress steps + final structured result
}
