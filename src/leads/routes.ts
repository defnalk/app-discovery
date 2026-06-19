/**
 * Leads section: Pipeline, Approval Queue, Performance, Settings.
 * Server-rendered on each request. Read-only EXCEPT the two human gates:
 *   - POST /leads/approvals/(approve|reject)  — batch gate to Instantly
 *   - POST /leads/settings/resolve            — threshold suggestion gate
 * There is NO auto-approve path and none may be added.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { pageShell, esc, embedJson } from '../lib/html.ts';
import { log } from '../lib/log.ts';
import { getLeadsDb, FUNNEL_STAGES, type LeadJoined } from './db.ts';
import { tierOf, DEFAULT_TIERS } from './jobs.ts';
import { instantlyEnabled, pushLead } from './instantly.ts';

type Handler = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void> | void;

const send = (res: ServerResponse, status: number, body: string) => {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
};
const redirect = (res: ServerResponse, to: string, msg?: string) => {
  res.writeHead(303, { location: msg ? `${to}?msg=${encodeURIComponent(msg)}` : to });
  res.end();
};

async function formBody(req: IncomingMessage): Promise<URLSearchParams> {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return new URLSearchParams(raw);
}

const STAGE_LABELS: Record<string, string> = {
  raw: 'Raw ingested', icp_qualified: 'ICP qualified', pushed: 'Pushed to Instantly',
  sendable: 'Clean sendable', sent: 'Sent', replied: 'Replied', meeting: 'Meeting booked',
};

const fmtDate = (s: string | null | undefined) => (s ? s.slice(0, 10) : '–');
const pct = (n: number, d: number) => (d ? ((n / d) * 100).toFixed(1) + '%' : '–');

async function getTiers() {
  const config = await getLeadsDb().listActiveConfig();
  return (config.find((c) => c.key === 'tier_thresholds')?.value as { A: number; B: number } | undefined) ?? DEFAULT_TIERS;
}

// ================================================================ Clay contact webhook
/** Read a body that may arrive raw (stream) or already-parsed (serverless). */
async function rawBody(req: IncomingMessage): Promise<string> {
  const pre = (req as { body?: unknown }).body;
  if (pre != null) return typeof pre === 'string' ? pre : JSON.stringify(pre);
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw;
}
const sendJson = (res: ServerResponse, status: number, obj: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
};
const domKey = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').trim();

/**
 * Inbound webhook for Clay (auth handled by the entry layer via CLAY_WEBHOOK_TOKEN).
 * Accepts one record or an array; matches each to an existing lead by domain then
 * company and writes the real contact (email / phone / name / title) onto it —
 * unmatched records become new source_arm='clay' leads. This is the accurate
 * contact source replacing the bad Apollo/CSV phone+email data.
 */
async function clayIngest(req: IncomingMessage, res: ServerResponse) {
  const db = getLeadsDb();
  let payload: unknown;
  try { payload = JSON.parse((await rawBody(req)) || '{}'); }
  catch { return sendJson(res, 400, { error: 'invalid JSON body' }); }
  const records: Record<string, unknown>[] = Array.isArray(payload) ? payload as Record<string, unknown>[]
    : Array.isArray((payload as { records?: unknown[] }).records) ? (payload as { records: Record<string, unknown>[] }).records
    : [payload as Record<string, unknown>];

  const leads = await db.listLeadsJoined();
  const byId = new Map<string, LeadJoined>(leads.map((l) => [l.id, l]));
  const byDomain = new Map<string, LeadJoined>();
  const byCompany = new Map<string, LeadJoined>();
  for (const l of leads) {
    if (l.domain) byDomain.set(domKey(l.domain), l);
    if (l.company) byCompany.set(l.company.toLowerCase().trim(), l);
  }
  const str = (v: unknown): string | null => { const s = v == null ? '' : String(v).trim(); return s || null; };
  const now = new Date().toISOString();
  const updates: Parameters<typeof db.updateLeadContacts>[0] = [];
  const inserts: Parameters<typeof db.insertLeads>[0] = [];

  for (const r of records) {
    const domain = domKey(str(r.domain) ?? str(r.website) ?? str(r.company_domain) ?? '');
    const company = str(r.company) ?? str(r.company_name) ?? str(r.organization_name);
    const email = str(r.email)?.toLowerCase() ?? null;
    const phone = str(r.phone) ?? str(r.mobile_phone) ?? str(r.direct_phone) ?? str(r.work_phone);
    const name = str(r.contact_name) ?? ([str(r.first_name), str(r.last_name)].filter(Boolean).join(' ') || null);
    const title = str(r.contact_title) ?? str(r.title) ?? str(r.job_title);
    const linkedin = str(r.linkedin) ?? str(r.linkedin_url);
    const lid = str(r.lead_id);
    const match = (lid && byId.get(lid)) || (domain && byDomain.get(domain)) || (company && byCompany.get(company.toLowerCase()));
    if (match) {
      const rp = { ...((match.raw_payload as Record<string, unknown>) ?? {}), contact_source: 'clay', clay_phone: phone, clay_linkedin: linkedin, clay_enriched_at: now };
      updates.push({
        id: match.id,
        email: email ?? match.email,
        email_status: email ? 'clay_verified' : match.email_status,
        contact_name: name ?? match.contact_name,
        contact_title: title ?? match.contact_title,
        enriched_at: now,
        raw_payload: rp,
      });
    } else if (company || domain) {
      inserts.push({
        source_arm: 'clay', company, domain: domain || null, email,
        email_status: email ? 'clay_verified' : 'needs_lookup',
        contact_name: name, contact_title: title, category: str(r.category), hq: str(r.hq) ?? str(r.city),
        geo: str(r.geo), signal_source_url: null, enriched_at: email ? now : null,
        raw_payload: { contact_source: 'clay', clay_phone: phone, clay_linkedin: linkedin, clay_enriched_at: now },
      });
    }
  }
  const matched = updates.length ? await db.updateLeadContacts(updates) : 0;
  const created = inserts.length ? await db.insertLeads(inserts) : 0;
  log.info(`clay ingest: ${records.length} records -> ${matched} matched/updated, ${created} new`);
  sendJson(res, 200, { ok: true, received: records.length, matched_updated: matched, new_leads: created });
}

/**
 * Outbound TARGET LIST for Clay to import as a Source (GET). Returns the engine's
 * consumer-app targets (no off-ICP, no duplicates) so Clay finds CONTACTS for the
 * RIGHT companies. Token-gated by the entry layer. Clay "Result path": apps.
 * Optional filters: ?geo=in & ?category=Education & ?limit=500.
 * Echo lead_id back via the Clay webhook for an exact round-trip match.
 */
// Quality score for ranking Clay's import: verified live traction + curated source
// (NOT the weak auto-sourced app_discovery arm) + has a contact gap to fill.
function targetQuality(l: LeadJoined): number {
  const rp = (l.raw_payload as Record<string, unknown> | null) ?? {};
  let s = 0;
  if (rp.signal_verified) s += 3;                                            // real live App Store traction
  if (l.source_arm !== 'app_discovery') s += 2;                              // curated > auto-sourced (team insight)
  if (l.jaka_score != null) s += 1;                                          // human/LLM scored
  if (l.domain) s += 1;
  if (!l.email || (l.email_status ?? '').toLowerCase() === 'needs_lookup') s += 1; // a contact gap = a good Clay job
  return s;
}

async function targetsList(_req: IncomingMessage, res: ServerResponse, url: URL) {
  const db = getLeadsDb();
  const geo = url.searchParams.get('geo');
  const category = url.searchParams.get('category');
  const limit = Number(url.searchParams.get('limit')) || 0;
  const includeAuto = ['auto', 'all', '1'].includes(url.searchParams.get('include') ?? '');
  const missingOnly = url.searchParams.get('missing') === '1';
  let apps = (await db.listLeadsJoined()).filter((l) => {
    const rp = (l.raw_payload as Record<string, unknown> | null) ?? {};
    if (rp.icp_type || rp.duplicate || !(l.company || l.domain)) return false;
    if (!includeAuto && l.source_arm === 'app_discovery') return false;        // skip weak auto-sourced by default
    if (missingOnly && l.email && (l.email_status ?? '').toLowerCase() !== 'needs_lookup') return false;
    return true;
  });
  if (geo) apps = apps.filter((l) => (l.geo ?? '').toLowerCase() === geo.toLowerCase());
  if (category) apps = apps.filter((l) => (l.category ?? '').toLowerCase() === category.toLowerCase());
  // best leads first, so a ?limit (trial-credit budget) spends on the highest-quality targets
  apps.sort((a, b) => targetQuality(b) - targetQuality(a) || (Number(b.jaka_score ?? 0) - Number(a.jaka_score ?? 0)));
  const out = (limit > 0 ? apps.slice(0, limit) : apps).map((l, i) => {
    const rp = (l.raw_payload as Record<string, unknown> | null) ?? {};
    const sig = (rp.signal as Record<string, unknown> | undefined) ?? {};
    return {
      priority: i + 1,
      quality_score: targetQuality(l),
      lead_id: l.id,
      company: l.company,
      domain: l.domain,
      category: l.category,
      geo: l.geo,
      source_arm: l.source_arm,
      needs_contact: !l.email || (l.email_status ?? '').toLowerCase() === 'needs_lookup',
      jaka_score: l.jaka_score,
      app_name: (sig.app_name as string | undefined) ?? null,
      chart_rank: (sig.best_rank as number | undefined) ?? null,
      geos_charting: Array.isArray(sig.geos_live) ? (sig.geos_live as string[]).join(', ') : null,
      geo_gap: Array.isArray(sig.geo_gap) ? (sig.geo_gap as string[]).join(', ') : null,
      store_url: l.signal_source_url,
    };
  });
  // Clay's HTTP Source imports a top-level array with zero path config when given
  // ?format=array. Default stays a labelled object (count/ranked_by) for humans.
  if ((url.searchParams.get('format') ?? '') === 'array') return sendJson(res, 200, out);
  sendJson(res, 200, {
    count: out.length,
    ranked_by: `quality desc — verified-traction + curated first; app_discovery auto-sourced ${includeAuto ? 'included' : 'excluded'}${missingOnly ? '; contact-gap only' : ''}`,
    apps: out,
  });
}

// Inline CRM write: reps set a call disposition / favorite / note from the dashboard.
// Auth = dashboard Basic Auth (the browser already holds it), same as the other pages.
const DISPOSITIONS = new Set(['', 'no_answer', 'voicemail', 'bad_number', 'wrong_icp', 'interested', 'not_interested', 'meeting', 'contacted']);
async function leadUpdate(req: IncomingMessage, res: ServerResponse) {
  const db = getLeadsDb();
  let body: Record<string, unknown>;
  try { body = JSON.parse((await rawBody(req)) || '{}'); } catch { return sendJson(res, 400, { error: 'invalid JSON' }); }
  const id = typeof body.id === 'string' ? body.id : '';
  if (!id) return sendJson(res, 400, { error: 'id required' });
  const lead = (await db.listLeadsJoined()).find((l) => l.id === id);
  if (!lead) return sendJson(res, 404, { error: 'not found' });
  const rp = { ...((lead.raw_payload as Record<string, unknown>) ?? {}) };
  if ('disposition' in body) {
    const d = String(body.disposition ?? '');
    if (!DISPOSITIONS.has(d)) return sendJson(res, 400, { error: 'bad disposition' });
    if (d) rp.disposition = d; else delete rp.disposition;
  }
  if ('favorite' in body) rp.favorite = Boolean(body.favorite);
  if ('note' in body) { const n = String(body.note ?? '').trim(); if (n) rp.note = n.slice(0, 1000); else delete rp.note; }
  rp.status_updated_at = new Date().toISOString();
  await db.updateLeadFields([{ id, raw_payload: rp }]);
  if (typeof body.stage === 'string' && body.stage) await db.updateLeadStages(new Map([[id, body.stage]]));
  sendJson(res, 200, { ok: true, id, disposition: rp.disposition ?? null, favorite: Boolean(rp.favorite), note: rp.note ?? null });
}

// ================================================================ Pipeline
async function pipelinePage(_req: IncomingMessage, res: ServerResponse, url: URL) {
  const db = getLeadsDb();
  const [leads, funnel, tiers, events] = await Promise.all([
    db.listLeadsJoined(), db.getFunnelRollups(), getTiers(), db.listEvents(),
  ]);
  const totals = new Map(funnel.filter((f) => f.source_arm === '*' && f.geo === '*').map((f) => [f.stage, f.count]));
  const msg = url.searchParams.get('msg');
  // Default to consumer apps only; off-ICP leads (incumbents / D2C brands / B2B) are
  // tagged raw_payload.icp_type and hidden unless ?icp=all.
  const icpView = url.searchParams.get('icp') === 'all' ? 'all' : 'consumer';
  const isOffIcp = (l: LeadJoined) => Boolean((l.raw_payload as Record<string, unknown> | null)?.icp_type);
  const offIcpCount = leads.filter(isOffIcp).length;
  const shown = icpView === 'all' ? leads : leads.filter((l) => !isOffIcp(l));

  // delta-CRM: per-lead event timeline (latest 12)
  const eventsByLead = new Map<string, { type: string; at: string }[]>();
  for (const e of events) {
    if (!e.lead_id) continue;
    (eventsByLead.get(e.lead_id) ?? eventsByLead.set(e.lead_id, []).get(e.lead_id)!).push({ type: e.type, at: e.occurred_at });
  }

  const arms = [...new Set(shown.map((l) => l.source_arm))].sort();
  const geos = [...new Set(shown.map((l) => l.geo ?? 'unknown'))].sort();
  const categories = [...new Set(shown.map((l) => l.category).filter(Boolean))].sort() as string[];
  const rows = shown.map((l) => {
    const rp = (l.raw_payload as Record<string, unknown> | null) ?? {};
    const sig = (rp.signal as Record<string, unknown> | undefined) ?? undefined;
    return {
      ...l,
      tier: tierOf(l.jaka_score, tiers),
      created: fmtDate(l.created_at),
      // Phone for the cold-call campaign: prefer the Clay-sourced number (verified),
      // fall back to the original Apollo/CSV import number (suspect — flagged 'legacy'
      // in the UI, since the team confirmed many of those are wrong).
      phone: (rp.clay_phone as string | undefined) || (rp.phone as string | undefined) || null,
      phone_src: rp.clay_phone ? 'clay' : (rp.phone ? 'legacy' : null),
      // Real provenance only: the source list/file it came from, and a verified-traction
      // timestamp when the engine actually matched it to a live app (not the old import-time
      // "enriched" stamp, which asserted an enrichment that never happened).
      list: (rp.list as string | undefined) ?? null,
      verifiedAt: (rp.signal_verified && sig?.verified_at) ? fmtDate(sig.verified_at as string) : null,
      events: (eventsByLead.get(l.id) ?? []).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 12),
    };
  });

  const body = `
<style>
.chip{cursor:pointer;border:1px solid #2a3340;background:none;color:#9aa7b8;padding:3px 10px;border-radius:14px;font-size:12px}
.chip:hover{border-color:var(--acc)} .chip.on{background:var(--acc);color:#000;border-color:var(--acc);font-weight:600}
th.sorth{cursor:pointer;user-select:none;white-space:nowrap} th.sorth:hover{color:var(--acc)}
td.clik{cursor:pointer} tr.leadrow:hover>td{background:#161c26}
#t thead th{position:sticky;top:0;background:#0d1219;z-index:2}
#stats span{white-space:nowrap}
</style>
${msg ? `<div class="panel" style="border-color:var(--good)">${esc(msg)}</div>` : ''}
<div id="funnel">
${FUNNEL_STAGES.map((s) => `<div class="stat" data-stage="${s}"><b>${totals.get(s) ?? 0}</b><span>${STAGE_LABELS[s]}</span></div>`).join('')}
</div>
<div class="panel" style="display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:10px">
  <div id="stats" style="display:flex;gap:16px;flex-wrap:wrap;font-size:13px;align-items:center"></div>
  <div style="display:flex;gap:8px;align-items:center">
    ${icpView === 'consumer'
      ? `<a href="?icp=all" class="pill" style="color:var(--acc)">show all types (${offIcpCount} hidden)</a>`
      : '<a href="?icp=consumer" class="pill" style="color:var(--acc)">← consumer apps only</a>'}
    <button id="exportBtn" class="pill" style="cursor:pointer;border:1px solid var(--acc);color:var(--acc);background:none">⬇ Export CSV</button>
  </div>
</div>
<div class="panel" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
  <span class="dim">Quick views:</span>
  <button class="chip" data-chip="">All</button>
  <button class="chip" data-chip="needs_email">📵 Needs email lookup</button>
  <button class="chip" data-chip="has_email">✉ Has email</button>
  <button class="chip" data-chip="clay">🟢 Clay-verified</button>
  <button class="chip" data-chip="verified">✓ Verified traction</button>
  <button class="chip" data-chip="geogap">🌍 Geo-gap</button>
  <span class="dim" style="border-left:1px solid #2a3340;padding-left:10px;margin-left:4px">Call status:</span>
  <button class="chip" data-chip="favorite">★ Favorites</button>
  <button class="chip" data-chip="uncalled">☎ Uncalled</button>
  <button class="chip" data-chip="badnum">❌ Bad number</button>
  <button class="chip" data-chip="interested">✅ Interested</button>
</div>
<div class="panel filters">
  <input type="search" id="q" placeholder="Search company / domain…" style="min-width:200px">
  <label>Arm <select id="arm"><option value="">all</option>${arms.map((a) => `<option>${esc(a)}</option>`).join('')}</select></label>
  <label>Geo <select id="geo"><option value="">all</option>${geos.map((g) => `<option>${esc(g)}</option>`).join('')}</select></label>
  <label>Category <select id="cat"><option value="">all</option>${categories.map((c) => `<option>${esc(c)}</option>`).join('')}</select></label>
  <label>Tier <select id="tier"><option value="">all</option><option>A</option><option>B</option><option>C</option></select></label>
  <label>Stage <select id="stage"><option value="">all</option>${FUNNEL_STAGES.map((s) => `<option value="${s}">${STAGE_LABELS[s]}</option>`).join('')}</select></label>
  <label>Email <select id="estatus"><option value="">all</option><option value="clay_verified">🟢 clay_verified</option><option>verified</option><option>unverified</option><option value="needs_lookup">needs_lookup</option><option>accept_all</option></select></label>
  <label>Added since <input type="date" id="since"></label>
  <span class="dim" id="count"></span>
</div>
<div class="panel" style="overflow-x:auto">
<table id="t"><thead><tr>
  <th style="width:24px"><input type="checkbox" id="selAll" title="Select all (filtered)"></th>
  <th data-k="company" class="sorth">Company</th><th>Contact</th><th data-k="phone" class="sorth">Phone</th><th data-k="email_status" class="sorth">Email</th>
  <th data-k="geo" class="sorth">Geo</th><th data-k="category" class="sorth">Category</th><th data-k="source_arm" class="sorth">Arm</th>
  <th data-k="jaka_score" class="num sorth">Score</th><th data-k="tier" class="sorth">Tier</th>
  <th data-k="market_status" class="sorth">Market</th><th>Reason</th><th data-k="stage" class="sorth">Stage</th><th>Provenance</th>
</tr></thead><tbody></tbody></table>
<p class="muted-note" id="footnote">funnel counts materialized nightly by funnel_rollup · click a column to sort · select rows to export a subset</p>
</div>`;

  const script = `
const ROWS = ${embedJson(rows)};
const STAGE_LABELS = ${embedJson(STAGE_LABELS)};
const $ = (s) => document.querySelector(s);
let sortKey = 'jaka_score', sortDir = -1, chip = '';
const selected = new Set();
function escq(s){ const d=document.createElement('div'); d.textContent=s??''; return d.innerHTML; }
const rp = (r) => r.raw_payload || {};
const needsEmail = (r) => !r.email || (r.email_status||'').toLowerCase()==='needs_lookup';
function passesChip(r){
  if(chip==='needs_email') return needsEmail(r);
  if(chip==='has_email')   return !!r.email;
  if(chip==='clay')        return rp(r).contact_source==='clay';
  if(chip==='verified')    return !!rp(r).signal_verified;
  if(chip==='geogap')      return !!(rp(r).signal && (rp(r).signal.geo_gap||[]).length);
  if(chip==='favorite')    return !!rp(r).favorite;
  if(chip==='uncalled')    return !rp(r).disposition;
  if(chip==='badnum')      return rp(r).disposition==='bad_number';
  if(chip==='interested')  return rp(r).disposition==='interested';
  return true;
}
function filtered(){
  const q=$('#q').value.toLowerCase(), arm=$('#arm').value, geo=$('#geo').value, cat=$('#cat').value,
    tier=$('#tier').value, estatus=$('#estatus').value, stage=$('#stage').value, since=$('#since').value;
  return ROWS.filter(r =>
    (!q || (r.company||'').toLowerCase().includes(q) || (r.domain||'').toLowerCase().includes(q) || (r.contact_name||'').toLowerCase().includes(q)) &&
    (!arm || r.source_arm===arm) && (!geo || (r.geo??'unknown')===geo) && (!cat || r.category===cat) &&
    (!tier || r.tier===tier) && (!stage || r.stage===stage) &&
    (!estatus || (r.email_status||'').toLowerCase()===estatus) &&
    (!since || r.created>=since) && passesChip(r));
}
function statsBar(rows){
  const withEmail=rows.filter(r=>r.email).length, need=rows.filter(needsEmail).length,
    withPhone=rows.filter(r=>r.phone).length, clayPhone=rows.filter(r=>r.phone_src==='clay').length,
    clay=rows.filter(r=>rp(r).contact_source==='clay').length, verif=rows.filter(r=>rp(r).signal_verified).length,
    called=rows.filter(r=>rp(r).disposition).length, bad=rows.filter(r=>rp(r).disposition==='bad_number').length;
  $('#stats').innerHTML = '<span><b>'+rows.length+'</b> leads</span>'+
    '<span style="color:#9aa7b8">☎ '+withPhone+' phone'+(clayPhone?' ('+clayPhone+' Clay ✓)':'')+'</span>'+
    '<span style="color:var(--good)">✉ '+withEmail+' email</span>'+
    '<span style="color:var(--bad)">📵 '+need+' need lookup</span>'+
    '<span style="color:var(--acc)">🟢 '+clay+' Clay</span>'+
    '<span>✓ '+verif+' verified</span>'+
    '<span style="color:#9aa7b8">☎ '+called+' worked</span>'+
    (bad?'<span style="color:var(--bad)">❌ '+bad+' bad #</span>':'')+
    '<span id="selcount" style="color:var(--acc)">'+(selected.size?('<b>'+selected.size+'</b> selected'):'')+'</span>';
}
function render(){
  document.querySelectorAll('#funnel .stat').forEach(el=>el.classList.toggle('active', el.dataset.stage===$('#stage').value));
  document.querySelectorAll('.chip').forEach(c=>c.classList.toggle('on', c.dataset.chip===chip));
  let rows=filtered();
  if(typeof rows[0]?.[sortKey]==='string') rows.sort((a,b)=>(a[sortKey]||'').localeCompare(b[sortKey]||'')*sortDir);
  else rows.sort((a,b)=>((a[sortKey]??-Infinity)-(b[sortKey]??-Infinity))*sortDir);
  statsBar(rows);
  $('#count').textContent = rows.length+' shown';
  document.querySelectorAll('th.sorth').forEach(th=>{ th.textContent=th.textContent.replace(/ *[▾▴]$/,''); if(th.dataset.k===sortKey) th.textContent+=' '+(sortDir<0?'▾':'▴'); });
  $('#t tbody').innerHTML = rows.slice(0,1000).map(r=>{ const i=ROWS.indexOf(r); const es=(r.email_status||'').toLowerCase();
    const pillStyle = es==='clay_verified'?' style="background:var(--good);color:#000"':needsEmail(r)?' style="background:var(--bad);color:#fff"':'';
    return '<tr class="leadrow" data-i="'+i+'">'+
    '<td><input type="checkbox" class="rowsel" data-i="'+i+'"'+(selected.has(i)?' checked':'')+'></td>'+
    '<td class="clik"><b>'+escq(r.company||'–')+'</b> <span class="dispchip">'+dispChip(r)+'</span><br><span class="dim">'+escq(r.domain||'')+'</span></td>'+
    '<td class="clik">'+escq(r.contact_name||'–')+'<br><span class="dim">'+escq(r.contact_title||'')+'</span></td>'+
    '<td>'+(r.phone
      ? '<a href="tel:'+escq(r.phone)+'" style="color:var(--acc);white-space:nowrap">'+escq(r.phone)+'</a><br>'+(r.phone_src==='clay'
          ? '<span class="pill" style="background:var(--good);color:#000">Clay ✓</span>'
          : '<span class="pill" style="background:var(--bad);color:#fff" title="original Apollo/CSV number — unverified, may be wrong">old</span>')
      : '<span class="dim">–</span>')+'</td>'+
    '<td>'+escq(r.email||'–')+'<br><span class="pill"'+pillStyle+'>'+escq(r.email_status||'?')+'</span></td>'+
    '<td>'+escq(r.geo||'–')+'</td><td>'+escq(r.category||'–')+'</td>'+
    '<td><span class="pill">'+escq(r.source_arm)+'</span></td>'+
    '<td class="num"><b>'+(r.jaka_score??'–')+'</b></td><td>'+r.tier+'</td>'+
    '<td>'+escq(r.market_status||'–')+'</td>'+
    '<td class="clik" style="max-width:240px">'+escq((r.reason||'–').slice(0,110))+'</td>'+
    '<td>'+(STAGE_LABELS[r.stage]||escq(r.stage||'raw'))+'</td>'+
    '<td><span class="dim">src:</span> '+escq(r.source_arm)+
      (r.signal_source_url&&r.signal_source_url.startsWith('http')?' · <a href="'+escq(r.signal_source_url)+'" target="_blank" style="color:var(--acc)">signal</a>':'')+
      '<br><span class="dim">'+(r.list?'list: '+escq(r.list):'added '+r.created)+(r.verifiedAt?' · ✓ verified':'')+'</span></td></tr>';
  }).join('');
  $('#footnote').textContent = (rows.length>1000?'showing first 1000 of '+rows.length+' — narrow with filters':rows.length+' leads')+' · click a column to sort · select rows then Export CSV';
  $('#selAll').checked = rows.length>0 && rows.every(r=>selected.has(ROWS.indexOf(r)));
  document.querySelectorAll('.rowsel').forEach(cb=>cb.onclick=(e)=>{ e.stopPropagation(); const i=+cb.dataset.i;
    cb.checked?selected.add(i):selected.delete(i); $('#selcount').innerHTML = selected.size?('<b>'+selected.size+'</b> selected'):''; });
  document.querySelectorAll('tr.leadrow .clik').forEach(td=>td.onclick=()=>{
    const tr=td.closest('tr'); const open=tr.nextElementSibling?.classList.contains('detail');
    document.querySelectorAll('tr.detail').forEach(d=>d.remove());
    if(open) return;
    const d=document.createElement('tr'); d.className='detail';
    d.innerHTML='<td colspan="14" style="background:#11161f;padding:14px 18px">'+leadDetail(ROWS[+tr.dataset.i])+'</td>';
    tr.after(d);
  });
}
function exportCSV(){
  const rows = selected.size ? ROWS.filter((_,i)=>selected.has(i)) : filtered();
  const cols=['company','domain','contact_name','contact_title','phone','phone_src','email','email_status','geo','category','source_arm','jaka_score','tier','stage','market_status','reason'];
  const esc=v=>{ const s=(v==null?'':String(v)).replace(/"/g,'""'); return /[",\\n]/.test(s)?'"'+s+'"':s; };
  const csv=[cols.join(',')].concat(rows.map(r=>cols.map(c=>esc(r[c])).join(','))).join('\\n');
  const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));
  a.download='leads_export_'+rows.length+'.csv'; a.click();
}
const DISP = {no_answer:['No answer','#7d8694'],voicemail:['Voicemail','#7d8694'],bad_number:['❌ Bad #','#ff6b6b'],wrong_icp:['⚠ Wrong ICP','#ffb347'],interested:['✅ Interested','#3fcf8e'],not_interested:['Not interested','#7d8694'],meeting:['📅 Meeting','#3fcf8e'],contacted:['☎ Contacted','#4da3ff']};
function dispChip(r){ const p=r.raw_payload||{}; const d=p.disposition;
  return (p.favorite?'<span title="favorite" style="color:gold">★</span> ':'') + (d&&DISP[d]?'<span class="pill" style="background:'+DISP[d][1]+';color:#000">'+DISP[d][0]+'</span>':''); }
async function saveLead(id, patch){
  const r=ROWS.find(x=>x.id===id); if(!r) return;
  let j; try{ const res=await fetch('/leads/update',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(Object.assign({id},patch))}); j=await res.json(); }catch(e){ j={error:String(e)}; }
  if(!j||!j.ok){ alert('Save failed: '+((j&&j.error)||'?')); return; }
  r.raw_payload=r.raw_payload||{};
  if('disposition' in patch){ if(patch.disposition) r.raw_payload.disposition=patch.disposition; else delete r.raw_payload.disposition; }
  if('favorite' in patch) r.raw_payload.favorite=patch.favorite;
  if('note' in patch){ if(patch.note) r.raw_payload.note=patch.note; else delete r.raw_payload.note; }
  const tr=document.querySelector('tr.leadrow[data-i="'+ROWS.indexOf(r)+'"]');
  if(tr){ const b=tr.querySelector('.dispchip'); if(b) b.innerHTML=dispChip(r);
    const det=tr.nextElementSibling; if(det&&det.classList.contains('detail')) det.firstElementChild.innerHTML=leadDetail(r); }
}
function dispControls(r){ const cur=(r.raw_payload||{}).disposition||''; const fav=(r.raw_payload||{}).favorite;
  const btn=(k)=>'<button onclick="saveLead(\\''+r.id+'\\',{disposition:\\''+(cur===k?'':k)+'\\'})" class="pill" style="cursor:pointer;margin:2px;border:1px solid '+(cur===k?DISP[k][1]:'#2a3340')+';'+(cur===k?'background:'+DISP[k][1]+';color:#000':'background:none;color:#9aa7b8')+'">'+DISP[k][0]+'</button>';
  return '<div style="max-width:420px">'+(r.phone
      ? '<p style="margin:0 0 8px;font-size:16px">☎ <a href="tel:'+escq(r.phone)+'" style="color:var(--acc);font-weight:700">'+escq(r.phone)+'</a> '+(r.phone_src==='clay'
          ? '<span class="pill" style="background:var(--good);color:#000">Clay ✓</span>'
          : '<span class="pill" style="background:var(--bad);color:#fff" title="original Apollo/CSV number — unverified, may be wrong">old / unverified</span>')+'</p>'
      : '<p class="dim" style="margin:0 0 8px">no phone on file — needs Clay lookup</p>')+
    '<h4 style="margin:0 0 6px">Call disposition</h4>'+Object.keys(DISP).map(btn).join('')+
    ' <button onclick="saveLead(\\''+r.id+'\\',{favorite:'+(!fav)+'})" class="pill" style="cursor:pointer;margin:2px">'+(fav?'★ favorited':'☆ favorite')+'</button>'+
    '<div style="margin-top:8px"><textarea id="note_'+r.id+'" rows="2" placeholder="rep note…" style="width:100%;background:#0d1219;color:#e6edf3;border:1px solid #2a3340;border-radius:6px;padding:6px">'+escq((r.raw_payload||{}).note||'')+'</textarea>'+
    '<button onclick="saveLead(\\''+r.id+'\\',{note:document.getElementById(\\'note_'+r.id+'\\').value})" class="pill" style="cursor:pointer;color:var(--acc);margin-top:4px">Save note</button></div></div>';
}
function talkingPoints(r){
  const p=r.raw_payload||{}; const cat=(r.category||'consumer app');
  const pts=[];
  if(p.signal_verified && p.signal && p.signal.momentum_score!=null)
    pts.push('Live traction — '+cat+' gaining momentum'+(p.signal.best_rank?(' (chart rank #'+p.signal.best_rank+')'):'')+'. Strong moment to scale paid UGC before CAC climbs.');
  else if(p.expansion_signal)
    pts.push('Growth signal: '+String(p.expansion_signal).slice(0,140));
  pts.push('8x delivers creator UGC at volume — '+cat+' apps convert well with native, high-output creator ads.');
  if(p.signal && (p.signal.geo_gap||[]).length)
    pts.push('Geo arbitrage: live in '+(p.signal.geo_gap||[]).slice(0,3).join(', ')+'. Lower creator CPMs there stretch the same budget further.');
  else
    pts.push('Ask about current paid channels (Meta / TikTok) and creative fatigue — that is where 8x plugs in.');
  return pts.slice(0,3);
}
function callerBrief(r){
  const p=r.raw_payload||{}; const li=p.clay_linkedin;
  const links=[];
  if(r.domain) links.push('<a href="https://'+escq(r.domain)+'" target="_blank" style="color:var(--acc)">🌐 '+escq(r.domain)+'</a>');
  if(li) links.push('<a href="'+escq(li)+'" target="_blank" style="color:var(--acc)">💼 LinkedIn</a>');
  const whatdo = p.why_selected || p.expansion_signal || (r.reason && r.reason!=='unclassified' ? r.reason : '');
  return '<div style="background:#0d1722;border:1px solid var(--acc);border-radius:8px;padding:12px 16px;margin-bottom:14px">'+
    '<div style="display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:8px">'+
      '<h4 style="margin:0;font-size:15px">📋 Caller brief — '+escq(r.company||'–')+'</h4>'+
      '<span class="dim">'+escq(r.category||'app')+' · '+escq(r.geo||'–')+(r.market_status?' · '+escq(r.market_status):'')+'</span></div>'+
    (links.length?'<p style="margin:6px 0">'+links.join(' &nbsp;·&nbsp; ')+'</p>':'')+
    '<p style="margin:6px 0"><b>Contact:</b> '+escq(r.contact_name||'—')+(r.contact_title?' · '+escq(r.contact_title):'')+
      (r.phone?' · ☎ <a href="tel:'+escq(r.phone)+'" style="color:var(--acc)">'+escq(r.phone)+'</a>'+(r.phone_src==='legacy'?' <span class="dim">(unverified #)</span>':''):' · <span class="dim">no phone</span>')+
      (r.email?' · ✉ '+escq(r.email):'')+'</p>'+
    (whatdo?'<p style="margin:6px 0"><b>What they do:</b> '+escq(String(whatdo).slice(0,220))+'</p>':'')+
    '<p style="margin:8px 0 2px"><b>Suggested 8x talking points</b></p>'+
    '<ul style="margin:2px 0 0;padding-left:18px">'+talkingPoints(r).map(t=>'<li style="margin:2px 0">'+escq(t)+'</li>').join('')+'</ul>'+
  '</div>';
}
function leadDetail(r) {
  const p = r.raw_payload || {};
  const signals = [
    p.expansion_signal ? '<p style="margin:4px 0">' + (p.signal_verified
      ? '<span style="background:var(--acc);color:#000;padding:1px 6px;border-radius:4px;font-size:11px;font-weight:600">✓ LIVE TRACTION</span> '
      : '<span class="pill" title="not verified against live store data">unverified</span> ') + '<b>Signal:</b> ' + escq(p.expansion_signal) + '</p>' : '',
    p.hiring_signal ? '<p style="margin:4px 0"><b>Hiring signal:</b> ' + escq(p.hiring_signal) + '</p>' : '',
    p.why_selected ? '<p style="margin:4px 0"><b>Why selected:</b> ' + escq(p.why_selected) + '</p>' : '',
    p.band ? '<p style="margin:4px 0"><b>ICP fit (heuristic):</b> ' + escq(String(p.band).split(': ').pop()) + (p.confidence ? ' <span class="dim">· confidence ' + escq(String(p.confidence)) + '</span>' : '') + '</p>' : '',
    (p.signal_verified && p.signal && p.signal.momentum_score != null) ? '<p style="margin:4px 0"><b>App momentum:</b> ' + p.signal.momentum_score + ' <span class="dim">(live App Store data, rank #' + escq(String(p.signal.best_rank ?? '–')) + ')</span></p>' : '',
  ].join('');
  const timeline = (r.events||[]).map(e =>
    '<tr><td>' + e.at.slice(0, 10) + '</td><td>' + escq(e.type) + '</td></tr>').join('');
  return callerBrief(r) +
    '<div style="display:flex;gap:28px;flex-wrap:wrap">' +
    dispControls(r) +
    '<div style="max-width:560px"><h4 style="margin:0 0 6px">Signals &amp; classification</h4>' +
      (signals || '<p class="dim">no stored signals</p>') +
      '<p style="margin:8px 0 4px"><b>Classifier reason:</b> ' + escq(r.reason || 'unclassified') + '</p>' +
      '<p class="dim" style="margin:4px 0">market: ' + escq(r.market_status||'–') + ' · fit: ' + escq(r.fit_verdict||'–') +
      ' · hq: ' + escq(r.hq||'–') + '</p>' +
      '<p class="dim" style="margin:4px 0">provenance: ' + escq(r.source_arm) +
      (r.list ? ' · from <b>' + escq(r.list) + '</b>' : '') + ' · added ' + r.created +
      (r.verifiedAt ? ' · <span style="color:var(--acc)">✓ live traction verified ' + escq(r.verifiedAt) + '</span>' : '') +
      (r.signal_source_url && r.signal_source_url.startsWith('http') ? ' · <a href="' + escq(r.signal_source_url) + '" target="_blank" style="color:var(--acc)">source ↗</a>' : '') + '</p></div>' +
    '<div><h4 style="margin:0 0 6px">Activity (delta)</h4>' +
      '<table style="min-width:220px"><thead><tr><th>Date</th><th>Event</th></tr></thead><tbody>' +
      (timeline || '<tr><td colspan="2" class="dim">no events yet — instantly_sync runs nightly</td></tr>') +
      '</tbody></table></div></div>';
}
document.querySelectorAll('#funnel .stat').forEach(el => el.onclick = () => {
  $('#stage').value = $('#stage').value === el.dataset.stage ? '' : el.dataset.stage; render();
});
document.querySelectorAll('th[data-k]').forEach(th => th.onclick = () => {
  const k = th.dataset.k; sortDir = sortKey === k ? -sortDir : -1; sortKey = k; render();
});
document.querySelectorAll('.chip').forEach(c => c.onclick = () => { chip = chip===c.dataset.chip ? '' : c.dataset.chip; render(); });
$('#selAll').onclick = (e) => { filtered().forEach(r => { const i=ROWS.indexOf(r); e.target.checked ? selected.add(i) : selected.delete(i); }); render(); };
$('#exportBtn').onclick = exportCSV;
['q','arm','geo','cat','tier','stage','estatus','since'].forEach(id => $('#'+id).addEventListener('input', render));
render();`;

  send(res, 200, pageShell({ title: 'Leads · Pipeline', active: 'pipeline', body, script }));
}

// ================================================================ Approval Queue
async function approvalsPage(_req: IncomingMessage, res: ServerResponse, url: URL) {
  const db = getLeadsDb();
  const [pending, leads, tiers, approvals] = await Promise.all([
    db.listCampaigns('pending_approval'), db.listLeadsJoined(), getTiers(), db.listApprovals(),
  ]);
  const leadById = new Map(leads.map((l) => [l.id, l]));
  const msg = url.searchParams.get('msg');

  const batchHtml = await Promise.all(pending.map(async (c) => {
    const cls = await db.listCampaignLeads(c.id);
    const batchLeads = cls.map((cl) => leadById.get(cl.lead_id)).filter((l): l is LeadJoined => Boolean(l));
    const mix = (key: (l: LeadJoined) => string) => {
      const m = new Map<string, number>();
      batchLeads.forEach((l) => m.set(key(l), (m.get(key(l)) ?? 0) + 1));
      return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${esc(k)}: ${n}`).join(' · ');
    };
    const scores = batchLeads.map((l) => l.jaka_score).filter((s): s is number => s != null);
    const dist = scores.length
      ? `min ${Math.min(...scores)} · median ${scores.sort((a, b) => a - b)[Math.floor(scores.length / 2)]} · max ${Math.max(...scores)}`
      : 'no scores';

    return `
<div class="panel">
  <h3 style="margin-top:0">${esc(c.name)} <span class="pill">${batchLeads.length} leads</span></h3>
  <p class="dim">Arms: ${mix((l) => l.source_arm)}<br>Geos: ${mix((l) => l.geo ?? 'unknown')}<br>Score: ${dist}
  ${c.instantly_campaign_id ? '' : '<br><span class="flag">⚠ no instantly_campaign_id set — approval will fail until linked</span>'}</p>
  <form method="POST" action="/leads/approvals/approve">
    <input type="hidden" name="batch_id" value="${esc(c.id)}">
    <div style="max-height:340px;overflow:auto;margin-bottom:10px">
    <table><thead><tr><th>Exclude</th><th>Company</th><th>Contact</th><th>Email</th><th>Arm</th><th>Geo</th><th class="num">Score</th><th>Tier</th></tr></thead><tbody>
    ${batchLeads.map((l) => `<tr>
      <td><input type="checkbox" name="exclude" value="${esc(l.id)}"></td>
      <td><b>${esc(l.company ?? '–')}</b> <span class="dim">${esc(l.domain ?? '')}</span></td>
      <td>${esc(l.contact_name ?? '–')}</td>
      <td>${esc(l.email ?? '–')} <span class="pill">${esc(l.email_status ?? '?')}</span></td>
      <td><span class="pill">${esc(l.source_arm)}</span></td><td>${esc(l.geo ?? '–')}</td>
      <td class="num">${l.jaka_score ?? '–'}</td><td>${tierOf(l.jaka_score, tiers)}</td>
    </tr>`).join('')}
    </tbody></table></div>
    <label class="dim">Your name (required, recorded on the approval): <input type="text" name="approved_by" required></label>
    <label class="dim" style="margin-left:10px">Note: <input type="text" name="note" style="min-width:220px"></label>
    <div style="margin-top:10px;display:flex;gap:10px">
      <button type="submit">Approve batch → push to Instantly</button>
      <button type="submit" class="danger" formaction="/leads/approvals/reject">Reject with note</button>
    </div>
  </form>
</div>`;
  }));

  const history = approvals.slice(0, 20).map((a) =>
    `<tr><td>${fmtDate(a.created_at)}</td><td>${esc(a.batch_id.slice(0, 8))}</td><td>${a.status === 'approved' ? '✅ approved' : '❌ rejected'}</td><td>${esc(a.approved_by)}</td><td>${esc(a.note ?? '')}</td></tr>`).join('');

  const body = `
${msg ? `<div class="panel" style="border-color:var(--good)">${esc(msg)}</div>` : ''}
<p class="dim">Human gate #1 — nothing reaches Instantly without an approval record. There is no auto-approve.</p>
${batchHtml.join('') || '<div class="panel dim">No batches pending approval.</div>'}
<div class="panel"><h3 style="margin-top:0">Recent decisions</h3>
<table><thead><tr><th>Date</th><th>Batch</th><th>Decision</th><th>By</th><th>Note</th></tr></thead><tbody>${history || '<tr><td colspan="5" class="dim">none yet</td></tr>'}</tbody></table></div>`;

  send(res, 200, pageShell({ title: 'Leads · Approval Queue', active: 'approvals', body }));
}

async function approveAction(req: IncomingMessage, res: ServerResponse) {
  const db = getLeadsDb();
  const form = await formBody(req);
  const batchId = form.get('batch_id') ?? '';
  const approvedBy = (form.get('approved_by') ?? '').trim();
  const note = form.get('note') || null;
  const excluded = form.getAll('exclude');
  if (!approvedBy) return redirect(res, '/leads/approvals', 'Approval rejected: name is required.');

  const campaign = (await db.listCampaigns()).find((c) => c.id === batchId);
  if (!campaign || campaign.status !== 'pending_approval') return redirect(res, '/leads/approvals', 'Batch not found or not pending.');
  if (!campaign.instantly_campaign_id) return redirect(res, '/leads/approvals', 'Batch has no linked Instantly campaign id — link it first.');
  if (!instantlyEnabled()) return redirect(res, '/leads/approvals', 'INSTANTLY_API_KEY not configured on the server.');

  const cls = await db.listCampaignLeads(batchId);
  const leads = await db.listLeadsJoined();
  const leadById = new Map(leads.map((l) => [l.id, l]));
  const toPush = cls.filter((cl) => !excluded.includes(cl.lead_id));

  let pushed = 0, failed = 0;
  for (const cl of toPush) {
    const lead = leadById.get(cl.lead_id);
    if (!lead?.email) { failed++; continue; }
    try {
      const r = await pushLead(campaign.instantly_campaign_id, {
        email: lead.email,
        company_name: lead.company ?? undefined,
        first_name: lead.contact_name?.split(' ')[0],
        custom_variables: { source_arm: lead.source_arm, lead_id: lead.id },
      });
      await db.setCampaignLeadPushed(batchId, cl.lead_id, r.id ?? null, 'pushed');
      pushed++;
    } catch (err) {
      failed++;
      log.error(`approve: push failed for ${lead.email}`, { err: String(err) });
    }
  }

  await db.insertApproval({
    batch_id: batchId, lead_ids: toPush.map((c) => c.lead_id), excluded_lead_ids: excluded,
    status: 'approved', approved_by: approvedBy, note,
  });
  await db.setCampaignStatus(batchId, 'approved', new Date().toISOString());
  log.info(`approval: batch ${batchId} approved by ${approvedBy}: ${pushed} pushed, ${excluded.length} excluded, ${failed} failed`);
  redirect(res, '/leads/approvals', `Approved: ${pushed} leads pushed to Instantly (campaign stays paused until started inside Instantly), ${excluded.length} excluded, ${failed} failed.`);
}

async function rejectAction(req: IncomingMessage, res: ServerResponse) {
  const db = getLeadsDb();
  const form = await formBody(req);
  const batchId = form.get('batch_id') ?? '';
  const approvedBy = (form.get('approved_by') ?? '').trim();
  const note = form.get('note') || null;
  if (!approvedBy) return redirect(res, '/leads/approvals', 'Rejection not recorded: name is required.');
  if (!note) return redirect(res, '/leads/approvals', 'Rejection requires a note.');
  const cls = await db.listCampaignLeads(batchId);
  await db.insertApproval({ batch_id: batchId, lead_ids: cls.map((c) => c.lead_id), excluded_lead_ids: [], status: 'rejected', approved_by: approvedBy, note });
  await db.setCampaignStatus(batchId, 'rejected');
  redirect(res, '/leads/approvals', 'Batch rejected.');
}

// ================================================================ Performance
async function performancePage(_req: IncomingMessage, res: ServerResponse) {
  const db = getLeadsDb();
  const [leads, events, tiers] = await Promise.all([db.listLeadsJoined(), db.listEvents(), getTiers()]);
  const leadById = new Map(leads.map((l) => [l.id, l]));

  type ArmStats = { sent: number; open: number; reply: number; positive: number; meeting: number };
  const armStats = new Map<string, ArmStats>();
  const daily = new Map<string, Map<string, number>>(); // arm -> day -> replies
  for (const e of events) {
    const arm = e.lead_id ? leadById.get(e.lead_id)?.source_arm : undefined;
    if (!arm) continue;
    const s = armStats.get(arm) ?? { sent: 0, open: 0, reply: 0, positive: 0, meeting: 0 };
    if (e.type === 'sent') s.sent++;
    else if (e.type === 'open') s.open++;
    else if (e.type === 'reply') s.reply++;
    else if (e.type === 'positive_reply') s.positive++;
    else if (e.type === 'meeting') s.meeting++;
    armStats.set(arm, s);
    if (e.type === 'reply' || e.type === 'positive_reply') {
      const day = e.occurred_at.slice(0, 10);
      (daily.get(arm) ?? daily.set(arm, new Map()).get(arm)!).set(day, (daily.get(arm)!.get(day) ?? 0) + 1);
    }
  }

  const armsRanked = [...armStats.entries()].sort((a, b) => (b[1].reply / Math.max(b[1].sent, 1)) - (a[1].reply / Math.max(a[1].sent, 1)));
  const eligible = armsRanked.filter(([, s]) => s.sent >= 100);
  const meanReplyRate = eligible.length ? eligible.reduce((acc, [, s]) => acc + s.reply / s.sent, 0) / eligible.length : 0;

  const statRows = armsRanked.map(([arm, s]) => {
    const rr = s.sent ? s.reply / s.sent : 0;
    const under = s.sent >= 100 && meanReplyRate > 0 && rr < meanReplyRate * 0.5;
    return `<tr${under ? ' style="outline:1px solid var(--bad)"' : ''}>
      <td><span class="pill">${esc(arm)}</span>${under ? ' <span class="flag">⚠ underperforming</span>' : ''}</td>
      <td class="num">${s.sent}</td><td class="num">${s.open || '–'}</td>
      <td class="num">${s.reply}</td><td class="num"><b>${pct(s.reply, s.sent)}</b></td>
      <td class="num">${s.positive}</td><td class="num">${s.meeting}</td><td class="num"><b>${pct(s.meeting, s.sent)}</b></td></tr>`;
  }).join('');

  // 30-day reply time series per arm, one SVG.
  const days: string[] = [];
  for (let i = 29; i >= 0; i--) days.push(new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10));
  const colors = ['#4da3ff', '#3fcf8e', '#ffb347', '#ff6b6b', '#b78aff'];
  const arms = [...daily.keys()];
  const maxY = Math.max(1, ...arms.flatMap((a) => days.map((d) => daily.get(a)!.get(d) ?? 0)));
  const W = 720, H = 140;
  const lines = arms.map((arm, i) => {
    const pts = days.map((d, x) => `${(x / 29) * W},${H - ((daily.get(arm)!.get(d) ?? 0) / maxY) * (H - 10)}`).join(' ');
    return `<polyline points="${pts}" fill="none" stroke="${colors[i % colors.length]}" stroke-width="1.5"/>`;
  }).join('');
  const legend = arms.map((arm, i) => `<span class="pill" style="border-left:8px solid ${colors[i % colors.length]}">${esc(arm)}</span>`).join(' ');

  const replies = events
    .filter((e) => e.type === 'reply' || e.type === 'positive_reply')
    .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at)).slice(0, 100)
    .map((e) => {
      const l = e.lead_id ? leadById.get(e.lead_id) : undefined;
      if (!l) return '';
      return `<tr><td>${fmtDate(e.occurred_at)}</td><td><b>${esc(l.company ?? '–')}</b> <span class="dim">${esc(l.domain ?? '')}</span></td>
        <td><span class="pill">${esc(l.source_arm)}</span></td><td class="num">${l.jaka_score ?? '–'} (${tierOf(l.jaka_score, tiers)})</td>
        <td>${e.type === 'positive_reply' ? '<span style="color:var(--good)">positive</span>' : 'reply'}</td>
        <td>${l.signal_source_url && l.signal_source_url.startsWith('http') ? `<a href="${esc(l.signal_source_url)}" style="color:var(--acc)">signal</a>` : '<span class="dim">–</span>'}</td></tr>`;
    }).join('');

  const body = `
<p class="dim">A/B readout across strategy arms, fed nightly by instantly_sync. Arms flagged when reply rate &lt; 50% of the mean after 100+ sends.</p>
<div class="panel"><h3 style="margin-top:0">Per arm</h3>
<table><thead><tr><th>Arm</th><th class="num">Sent</th><th class="num">Opens</th><th class="num">Replies</th><th class="num">Reply rate</th><th class="num">Positive</th><th class="num">Meetings</th><th class="num">Meeting rate</th></tr></thead>
<tbody>${statRows || '<tr><td colspan="8" class="dim">no events yet — instantly_sync runs nightly</td></tr>'}</tbody></table></div>
<div class="panel"><h3 style="margin-top:0">Replies per day (30d) ${legend}</h3>
<svg width="${W}" height="${H}" style="max-width:100%">${lines}</svg></div>
<div class="panel"><h3 style="margin-top:0">Recent replies (traceable to arm, score, signal)</h3>
<table><thead><tr><th>Date</th><th>Lead</th><th>Arm</th><th class="num">Score</th><th>Type</th><th>Signal</th></tr></thead>
<tbody>${replies || '<tr><td colspan="6" class="dim">no replies yet</td></tr>'}</tbody></table></div>`;

  send(res, 200, pageShell({ title: 'Leads · Performance', active: 'performance', body }));
}

// ================================================================ Settings
async function settingsPage(_req: IncomingMessage, res: ServerResponse, url: URL) {
  const db = getLeadsDb();
  const [config, suggestions, audit] = await Promise.all([
    db.listActiveConfig(), db.listSuggestions('pending'), db.listAudit(),
  ]);
  const msg = url.searchParams.get('msg');

  const configRows = config.map((c) => `<tr>
    <td><b>${esc(c.key)}</b> <span class="dim">v${c.version}</span></td>
    <td><code>${esc(JSON.stringify(c.value))}</code></td>
    <td>${fmtDate(c.updated_at)}</td><td>${esc(c.updated_by ?? '–')}</td></tr>`).join('');

  const suggestionRows = suggestions.map((s) => `
<div class="panel" style="border-color:var(--warn)">
  <b>Suggestion #${s.id}</b> <span class="dim">${fmtDate(s.created_at)}</span>
  <p>${esc(s.rationale ?? '')}</p>
  <p class="dim">Proposed: <code>${esc(JSON.stringify(s.proposed))}</code><br>
  Evidence: <code>${esc(JSON.stringify(s.evidence))}</code></p>
  <form method="POST" action="/leads/settings/resolve" style="display:flex;gap:10px;align-items:center">
    <input type="hidden" name="id" value="${s.id}">
    <label class="dim">Your name: <input type="text" name="resolved_by" required></label>
    <button type="submit" name="action" value="accept">Accept (applies + audits)</button>
    <button type="submit" name="action" value="dismiss" class="ghost">Dismiss</button>
  </form>
</div>`).join('');

  const auditRows = audit.map((a) => `<tr><td>${fmtDate(a.created_at)}</td><td>${esc(a.setting)}</td>
    <td><code>${esc(JSON.stringify(a.old_value))}</code></td><td><code>${esc(JSON.stringify(a.new_value))}</code></td>
    <td>${esc(a.suggested_by)}</td><td>${esc(a.approved_by)}</td></tr>`).join('');

  const body = `
${msg ? `<div class="panel" style="border-color:var(--good)">${esc(msg)}</div>` : ''}
<p class="dim">Human gate #2 — thresholds are read-only here. The system queues suggestions from Performance data; a human accepts or dismisses each. No silent recalibration, no auto-applied edits, ever.</p>
<div class="panel"><h3 style="margin-top:0">Active scoring thresholds &amp; ICP rules</h3>
<table><thead><tr><th>Setting</th><th>Value</th><th>Last edited</th><th>Editor</th></tr></thead>
<tbody>${configRows || '<tr><td colspan="4" class="dim">no config rows — defaults in use (tier_thresholds ' + esc(JSON.stringify(DEFAULT_TIERS)) + ')</td></tr>'}</tbody></table></div>
<h3>Pending suggestions</h3>
${suggestionRows || '<div class="panel dim">none — suggestion_engine runs nightly</div>'}
<div class="panel"><h3 style="margin-top:0">Audit log</h3>
<table><thead><tr><th>Date</th><th>Setting</th><th>Old</th><th>New</th><th>Suggested by</th><th>Approved by</th></tr></thead>
<tbody>${auditRows || '<tr><td colspan="6" class="dim">no changes yet</td></tr>'}</tbody></table></div>`;

  send(res, 200, pageShell({ title: 'Leads · Settings', active: 'settings', body }));
}

async function resolveSuggestionAction(req: IncomingMessage, res: ServerResponse) {
  const db = getLeadsDb();
  const form = await formBody(req);
  const id = Number(form.get('id'));
  const action = form.get('action');
  const by = (form.get('resolved_by') ?? '').trim();
  if (!by || !Number.isFinite(id)) return redirect(res, '/leads/settings', 'Name is required.');

  if (action === 'dismiss') {
    await db.resolveSuggestion(id, 'rejected', by);
    return redirect(res, '/leads/settings', `Suggestion #${id} dismissed.`);
  }

  const s = await db.resolveSuggestion(id, 'approved', by);
  if (!s) return redirect(res, '/leads/settings', 'Suggestion not found or already resolved.');
  // Apply the accepted change as a new config version + audit row.
  const proposed = s.proposed as { setting?: string; change?: unknown; current?: unknown };
  if (proposed.setting && proposed.change !== undefined) {
    const config = await db.listActiveConfig();
    const old = config.find((c) => c.key === proposed.setting)?.value ?? proposed.current ?? null;
    const merged = typeof old === 'object' && old !== null && typeof proposed.change === 'object'
      ? { ...(old as object), ...(proposed.change as object) } : proposed.change;
    await db.insertConfigVersion(proposed.setting, merged, by);
    await db.insertAudit({ setting: proposed.setting, old_value: old, new_value: merged, suggested_by: 'system', approved_by: by });
  }
  log.info(`settings: suggestion #${id} accepted by ${by}`);
  redirect(res, '/leads/settings', `Suggestion #${id} accepted and applied.`);
}

// ================================================================ Strategy
async function strategyPage(_req: IncomingMessage, res: ServerResponse) {
  const db = getLeadsDb();
  const snap = await db.getLatestStrategySnapshot();
  // Day-over-day delta: compare against the last snapshot from a previous day.
  const dayStart = snap ? snap.computed_at.slice(0, 10) + 'T00:00:00Z' : '';
  const prev = snap ? await db.getStrategySnapshotBefore(dayStart) : null;
  const delta = (now: number, before: number | undefined) => {
    if (before == null || now === before) return '';
    const d = now - before;
    return ` <span style="color:${d > 0 ? 'var(--good)' : 'var(--bad)'};font-size:11px">${d > 0 ? '▲+' : '▼'}${d}</span>`;
  };
  const POOLS = ['in', 'br', 'tr', 'id', 'mx'];

  let crossTab = '<div class="panel dim">No snapshot yet — strategy_rollup runs nightly (or run <code>npm run nightly</code>).</div>';
  let armTab = '';
  if (snap) {
    const d = snap.data as {
      market: Record<string, Record<string, { hot: number; charting: number }>>;
      lead_book: Record<string, Record<string, { total: number; sendable: number; qualified: number }>>;
      lead_book_by_arm?: Record<string, Record<string, { total: number; sendable: number; qualified: number; sent: number; withEmail: number }>>;
      expansion_candidates_into_pool: Record<string, Record<string, number>>;
      geos?: string[];
    };

    if (d.lead_book_by_arm) {
      const pd = (prev?.data ?? null) as typeof d | null;
      const geos = d.geos ?? ['in', 'br', 'tr', 'id', 'mx', 'us', 'gb', 'de', 'fr', 'unknown'];
      const armRows = Object.entries(d.lead_book_by_arm).sort((a, b) => {
        const sum = (x: typeof a[1]) => Object.values(x).reduce((s, c) => s + c.total, 0);
        return sum(b[1]) - sum(a[1]);
      }).map(([arm, cells]) => {
        const sumUp = (cs: Record<string, { total: number; sendable: number; qualified: number; withEmail: number }> | undefined) =>
          Object.values(cs ?? {}).reduce((s, c) => ({
            total: s.total + c.total, sendable: s.sendable + c.sendable, qualified: s.qualified + c.qualified, withEmail: s.withEmail + c.withEmail,
          }), { total: 0, sendable: 0, qualified: 0, withEmail: 0 });
        const totals = sumUp(cells);
        const prevTotals = pd?.lead_book_by_arm ? sumUp(pd.lead_book_by_arm[arm]) : undefined;
        const geoCells = geos.map((g) => {
          const c = cells[g];
          if (!c) return '<td class="dim">–</td>';
          const p = pd?.lead_book_by_arm?.[arm]?.[g];
          return `<td><b>${c.total}</b>${delta(c.total, p?.total)}<br><span class="dim">${c.sendable}s${delta(c.sendable, p?.sendable)}/${c.qualified}q</span></td>`;
        }).join('');
        return `<tr><td><span class="pill">${esc(arm)}</span><br><span class="dim">${totals.withEmail} w/ email</span></td>
          <td class="num"><b>${totals.total}</b>${delta(totals.total, prevTotals?.total)}<br><span class="dim">${totals.sendable}s${delta(totals.sendable, prevTotals?.sendable)}/${totals.qualified}q${delta(totals.qualified, prevTotals?.qualified)}</span></td>${geoCells}</tr>`;
      }).join('');
      armTab = `<div class="panel" style="overflow-x:auto">
        <h3 style="margin-top:0">Leads by sourcing strategy × geo <span class="dim">(snapshot ${fmtDate(snap.computed_at)}${prev ? ` · Δ vs ${fmtDate(prev.computed_at)}` : ' · deltas appear after the next nightly snapshot'})</span></h3>
        <table><thead><tr><th>Strategy arm</th><th class="num">Total</th>${geos.map((g) => `<th>${g}</th>`).join('')}</tr></thead>
        <tbody>${armRows}</tbody></table>
        <p class="muted-note">s = clean sendable · q = ICP qualified · ▲▼ = change since the previous day's snapshot. The same split drives the A/B readout on Performance once sends begin.</p></div>`;
    }
    const buckets = [...new Set([...Object.keys(d.market), ...Object.keys(d.lead_book)])].sort();
    const heat = (hot: number) => hot >= 100 ? 'rgba(255,107,107,.18)' : hot >= 30 ? 'rgba(255,179,71,.14)' : 'transparent';
    const pd2 = (prev?.data ?? null) as typeof d | null;
    const rows = buckets.map((b) => {
      const cells = [...POOLS, 'unknown'].map((g) => {
        const lb = d.lead_book[b]?.[g];
        const mk = g === 'unknown' ? null : d.market[b]?.[g];
        const gap = g === 'unknown' ? 0 : d.expansion_candidates_into_pool[b]?.[g] ?? 0;
        if (!lb && !mk) return '<td class="dim">–</td>';
        const pmk = g === 'unknown' ? null : pd2?.market?.[b]?.[g];
        const plb = pd2?.lead_book?.[b]?.[g];
        return `<td style="background:${heat(mk?.hot ?? 0)}">
          <b>${lb?.total ?? 0}</b>${delta(lb?.total ?? 0, plb ? plb.total : undefined)} <span class="dim">leads</span> <span class="dim">(${lb?.sendable ?? 0}s/${lb?.qualified ?? 0}q)</span><br>
          <span class="dim">${mk ? `${mk.hot} hot${delta(mk.hot, pmk ? pmk.hot : undefined)} · ${gap} expanding in` : 'no chart data'}</span></td>`;
      }).join('');
      return `<tr><td><b>${esc(b)}</b></td>${cells}</tr>`;
    }).join('');
    crossTab = `<div class="panel" style="overflow-x:auto">
      <h3 style="margin-top:0">Lead book vs market heat <span class="dim">(snapshot ${fmtDate(snap.computed_at)}, refreshed nightly)</span></h3>
      <table><thead><tr><th>Industry</th>${[...POOLS, 'unknown'].map((g) => `<th>${g}</th>`).join('')}</tr></thead>
      <tbody>${rows}</tbody></table>
      <p class="muted-note">Cell = your leads (sendable/qualified) against hot apps (momentum ≥ 0.3) and apps expanding INTO that market (geo-gap). Red tint = heavy market heat.</p></div>`;
  }

  let doc = '';
  try {
    const md = (await import('node:fs')).readFileSync('docs/LEAD-STRATEGY.md', 'utf8');
    doc = '<div class="panel">' + md.split('\n').map((line) => {
      const e = esc(line).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
      if (line.startsWith('### ')) return `<h4 style="margin:14px 0 4px">${e.slice(4)}</h4>`;
      if (line.startsWith('## ')) return `<h3 style="margin:18px 0 6px">${e.slice(3)}</h3>`;
      if (line.startsWith('# ')) return `<h2 style="margin:0 0 6px">${e.slice(2)}</h2>`;
      if (line.startsWith('- ')) return `<li>${e.slice(2)}</li>`;
      if (/^\d+\. /.test(line)) return `<li>${e.replace(/^\d+\. /, '')}</li>`;
      if (line.startsWith('*') && line.endsWith('*')) return `<p class="dim">${e.replace(/^\*|\*$/g, '')}</p>`;
      return line.trim() ? `<p style="margin:6px 0">${e}</p>` : '';
    }).join('') + '</div>';
  } catch { /* doc optional */ }

  send(res, 200, pageShell({ title: 'Leads · Strategy', active: 'strategy', body: armTab + crossTab + doc }));
}

// ================================================================ registry
export function registerRoutes(routes: Map<string, Handler>) {
  routes.set('GET /leads/strategy', strategyPage);
  routes.set('GET /leads', pipelinePage);
  routes.set('GET /leads/approvals', approvalsPage);
  routes.set('POST /leads/approvals/approve', approveAction);
  routes.set('POST /leads/approvals/reject', rejectAction);
  routes.set('GET /leads/performance', performancePage);
  routes.set('GET /leads/settings', settingsPage);
  routes.set('POST /leads/settings/resolve', resolveSuggestionAction);
  routes.set('POST /leads/clay', clayIngest); // Clay sends enriched contacts IN (token-gated by entry layer)
  routes.set('GET /leads/targets', targetsList); // Clay imports the target company list OUT (token-gated)
  routes.set('POST /leads/update', leadUpdate); // inline CRM: rep sets disposition / favorite / note
}
