// DBC Flow dashboard — vanilla JS, no build step.
const $ = (s, el = document) => el.querySelector(s);
const api = (p) => fetch(p).then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status))));

// ---------- formatters ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const short = (a) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : '—');
function usd(v, { sign = false } = {}) {
  if (v == null || !isFinite(v)) return '—';
  const s = sign && v > 0 ? '+' : v < 0 ? '−' : '';
  const a = Math.abs(v);
  const f = a >= 1e9 ? (a / 1e9).toFixed(2) + 'B' : a >= 1e6 ? (a / 1e6).toFixed(2) + 'M' : a >= 1e3 ? (a / 1e3).toFixed(1) + 'K' : a >= 1 ? a.toFixed(0) : a.toFixed(2);
  return `${s}$${f}`;
}
function num(v, d = 2) {
  if (v == null || !isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  if (a >= 1) return v.toFixed(d);
  if (a === 0) return '0';
  return v.toPrecision(3);
}
function dur(sec) {
  if (sec == null) return '—';
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86400) return `${(sec / 3600).toFixed(1)}h`;
  return `${(sec / 86400).toFixed(1)}d`;
}
const ago = (ts) => dur((Date.now() - ts) / 1000);
const clock = (ts) => new Date(ts).toLocaleTimeString([], { hour12: false });
const pctClass = (v) => (v == null ? 'mut' : v >= 0 ? 'pos' : 'neg');
const tokCell = (p) => `<div class="tok">${p.image ? `<img src="${esc(p.image)}" loading="lazy" alt="" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'ph',textContent:'?'}))">` : `<span class="ph">${esc((p.symbol || '?').slice(0, 2))}</span>`}<div class="nm"><span class="sym">${esc(p.symbol || short(p.mint))}${p.spoofedTicker ? ' <span class="badge" style="color:var(--sell);border-color:#5a2030" title="Ticker contains hidden bidi/zero-width characters (impersonation trick)">⚠ spoof</span>' : ''}</span><span class="q">/${esc(p.quoteSymbol || '?')}${p.createdAt ? ` · ${ago(p.createdAt)}` : ''}</span></div></div>`;

// ---------- status pills ----------
let solPrice = null;
function renderStats(s) {
  $('#pills').innerHTML = `
    <span class="pill"><i class="dot ${s.wsConnected ? 'on' : ''}"></i><b>${s.wsConnected ? 'LIVE' : 'OFFLINE'}</b> mainnet</span>
    <span class="pill"><b>${s.txProcessedPerMin}</b> DBC tx/min</span>
    <span class="pill">coverage <b>${s.coveragePct}%</b></span>
    <span class="pill"><b>${s.pools}</b> pools tracked</span>
    <span class="pill"><b>${s.launchpads}</b> launchpads</span>
    <span class="pill"><b>${s.totals.events.toLocaleString()}</b> events</span>`;
  $('#foot-stats').textContent = `uptime ${dur(s.uptimeSec)} · ${s.totals.processed.toLocaleString()} tx decoded · ${s.rpc.calls.toLocaleString()} RPC calls`;
}

// ---------- radar ----------
const RADAR = {
  near: '/api/pools?status=bonding&sort=progress&limit=25',
  hot: '/api/pools?sort=volume5m&limit=25',
  new: '/api/pools?sort=new&newOnly=true&limit=25',
  grad: '/api/pools?sort=recent&status=migrated&limit=25',
};
let radarTab = 'near';
async function loadRadar() {
  try {
    let { pools } = await api(RADAR[radarTab]);
    if (radarTab === 'grad') {
      const g = await api('/api/pools?sort=recent&status=graduated&limit=25');
      pools = [...g.pools, ...pools].sort((a, b) => (b.migratedAt || b.graduatedAt || 0) - (a.migratedAt || a.graduatedAt || 0));
    }
    if (radarTab === 'hot') pools = pools.filter((p) => p.m5.volumeUsd > 0);
    $('#radar-body').innerHTML = pools.length ? pools.map((p) => {
      const done = p.status !== 'bonding';
      const prog = done ? 100 : p.progress ?? 0;
      const badge = p.status === 'migrated' ? `<span class="badge mig">${esc(p.migrationTarget || 'DAMM')}</span>` : p.status === 'graduated' ? '<span class="badge mig">graduated</span>' : '';
      return `<tr data-pool="${p.pool}">
        <td>${tokCell(p)}</td>
        <td><div class="prog"><div class="bar ${done ? 'done' : ''}"><i style="width:${prog}%"></i></div><span>${p.progress == null && !done ? '—' : prog.toFixed(1) + '%'}</span>${badge}</div></td>
        <td class="mut">${done ? '✓' : dur(p.etaSec)}</td>
        <td class="r">${usd(p.mcapUsd)}</td>
        <td class="r">${usd(p.m5.volumeUsd)}</td>
        <td class="r ${pctClass(p.m5.netFlowUsd)}">${usd(p.m5.netFlowUsd, { sign: true })}</td></tr>`;
    }).join('') : `<tr><td colspan="6" class="empty">Nothing here yet — data fills in as pools trade.</td></tr>`;
  } catch { /* retry next tick */ }
}
$('#radar-tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  radarTab = b.dataset.tab;
  [...$('#radar-tabs').children].forEach((x) => x.classList.toggle('on', x === b));
  loadRadar();
});
$('#radar-body').addEventListener('click', (e) => { const tr = e.target.closest('tr[data-pool]'); if (tr) openPool(tr.dataset.pool); });

// ---------- tape ----------
let tapeFilter = 'all';
const LIFE = new Set(['pool_created', 'near_graduation', 'graduated', 'migrated']);
function tapeMatch(e) {
  switch (tapeFilter) {
    case 'buy': return e.type === 'swap' && e.side === 'buy';
    case 'sell': return e.type === 'swap' && e.side === 'sell';
    case 'whale': return e.flags?.includes('whale');
    case 'sniper': return e.flags?.includes('sniper');
    case 'lifecycle': return LIFE.has(e.type);
    default: return true;
  }
}
const poolLink = (e) => `<a class="pl" data-pool="${e.pool}">${esc(e.symbol || short(e.mint))}</a>`;
function lifeText(e) {
  switch (e.type) {
    case 'pool_created': return ['🚀', `${poolLink(e)} launched on DBC <span class="mut">/${esc(e.quoteSymbol || '?')} · creator ${short(e.creator)}</span>`];
    case 'near_graduation': return ['🔥', `${poolLink(e)} hit <b>${e.progress.toFixed(1)}%</b> of the curve${e.etaSec ? ` <span class="mut">· ETA ${dur(e.etaSec)}</span>` : ''}`];
    case 'graduated': return ['🎓', `${poolLink(e)} completed its bonding curve${e.timeToGraduateSec ? ` in ${dur(e.timeToGraduateSec)}` : ''} <span class="mut">· ${num(e.quoteReserve)} ${esc(e.quoteSymbol || '')} raised</span>`];
    case 'migrated': return ['🌊', `${poolLink(e)} migrated to <b>${esc(e.target)}</b> <a href="https://www.meteora.ag/dammv2/${e.dammPool}" target="_blank" rel="noopener">pool ↗</a>`];
    default: return ['•', e.type];
  }
}
function tapeRow(e) {
  if (e.type === 'swap') {
    const flags = (e.flags || []).map((f) => `<span class="flag ${f}">${f}</span>`).join('');
    return `<span class="t-time">${clock(e.ts)}</span>
      <span class="t-main"><span class="side ${e.side}">${e.side.toUpperCase()}</span>${poolLink(e)} <span class="mut">${num(e.quoteAmount)} ${esc(e.quoteSymbol || '')}${e.progress != null ? ` · ${e.progress.toFixed(1)}%` : ''} · <a class="wallet" href="https://solscan.io/account/${e.trader}" target="_blank" rel="noopener">${short(e.trader)}</a></span>${flags}</span>
      <span class="t-usd ${e.side === 'buy' ? 'pos' : 'neg'}">${usd(e.usd)}</span>`;
  }
  const [ic, txt] = lifeText(e);
  return `<span class="t-time">${clock(e.ts)}</span><span class="t-main">${ic} ${txt}</span><span></span>`;
}
const tapeEl = $('#tape');
function pushTape(e, flash = true) {
  if (!tapeMatch(e)) return;
  const li = document.createElement('li');
  li.innerHTML = tapeRow(e);
  if (flash) li.classList.add('flash');
  tapeEl.prepend(li);
  while (tapeEl.children.length > 150) tapeEl.lastChild.remove();
}
const lifeEl = $('#life');
function pushLife(e) {
  if (!LIFE.has(e.type)) return;
  if (lifeEl.firstElementChild?.classList.contains('empty')) lifeEl.innerHTML = '';
  const [ic, txt] = lifeText(e);
  const li = document.createElement('li');
  li.innerHTML = `<span class="t-time">${clock(e.ts)}</span><span class="t-main">${txt}</span><span class="ic">${ic}</span>`;
  lifeEl.prepend(li);
  while (lifeEl.children.length > 60) lifeEl.lastChild.remove();
}
const recent = [];
async function reloadTape() {
  tapeEl.innerHTML = '';
  recent.filter(tapeMatch).slice(-150).forEach((e) => pushTape(e, false));
}
$('#tape-filters').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  tapeFilter = b.dataset.f;
  [...$('#tape-filters').children].forEach((x) => x.classList.toggle('on', x === b));
  reloadTape();
});
document.addEventListener('click', (e) => { const a = e.target.closest('a.pl[data-pool]'); if (a) { e.preventDefault(); openPool(a.dataset.pool); } });

// ---------- launchpads & traders ----------
async function loadPads() {
  try {
    const { launchpads } = await api('/api/launchpads?limit=12');
    $('#pads-body').innerHTML = launchpads.map((l) => `<tr>
      <td><a class="wallet" href="https://solscan.io/account/${l.config}" target="_blank" rel="noopener">${short(l.config)}</a> <span class="badge">${l.threshold ? num(l.threshold) + ' ' + (l.quoteMint?.startsWith('So111') ? 'SOL' : l.quoteMint?.startsWith('EPjF') ? 'USDC' : 'q') : '?'}</span></td>
      <td class="r">${l.pools}</td><td class="r">${l.created}</td><td class="r">${l.graduated || l.migrated ? Math.max(l.graduated, l.migrated) : 0}</td>
      <td class="r">${usd(l.volumeUsd)}</td><td class="r">${usd(l.feesUsd)}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">—</td></tr>';
  } catch {}
}
let traderSort = 'volumeUsd';
async function loadTraders() {
  try {
    const { traders } = await api(`/api/traders?sort=${traderSort}&limit=12`);
    $('#traders-body').innerHTML = traders.map((t) => `<tr>
      <td><a class="wallet" href="https://solscan.io/account/${t.wallet}" target="_blank" rel="noopener">${short(t.wallet)}</a></td>
      <td class="r pos">${t.buys}</td><td class="r neg">${t.sells}</td><td class="r">${t.pools}</td><td class="r">${t.snipes}</td><td class="r">${usd(t.volumeUsd)}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">—</td></tr>';
  } catch {}
}
$('#trader-tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  traderSort = b.dataset.s;
  [...$('#trader-tabs').children].forEach((x) => x.classList.toggle('on', x === b));
  loadTraders();
});

// ---------- charts (canvas, no deps) ----------
function lineChart(canvas, series, { xFmt = (v) => v, yFmt = (v) => v, marker } = {}) {
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const pad = { l: 58, r: 14, t: 14, b: 26 };
  const pts = series.flatMap((s) => s.points);
  if (pts.length < 2) { ctx.fillStyle = '#5b6076'; ctx.font = '12px sans-serif'; ctx.fillText('Not enough data yet', W / 2 - 55, H / 2); return; }
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  if (marker) { xs.push(marker.x); ys.push(marker.y); }
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(0, ...ys), y1 = Math.max(...ys) * 1.05 || 1;
  const X = (v) => pad.l + ((v - x0) / (x1 - x0 || 1)) * (W - pad.l - pad.r);
  const Y = (v) => H - pad.b - ((v - y0) / (y1 - y0 || 1)) * (H - pad.t - pad.b);
  ctx.strokeStyle = '#242838'; ctx.fillStyle = '#5b6076'; ctx.font = '10.5px ui-monospace, monospace'; ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const v = y0 + ((y1 - y0) * i) / 4, y = Y(v);
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke();
    ctx.fillText(yFmt(v), 6, y + 3);
  }
  for (let i = 0; i <= 4; i++) {
    const v = x0 + ((x1 - x0) * i) / 4;
    const label = xFmt(v); const w = ctx.measureText(label).width;
    ctx.fillText(label, Math.min(W - pad.r - w, Math.max(pad.l, X(v) - w / 2)), H - 8);
  }
  for (const s of series) {
    if (s.points.length < 2) continue;
    ctx.beginPath();
    s.points.forEach((p, i) => (i ? ctx.lineTo(X(p.x), Y(p.y)) : ctx.moveTo(X(p.x), Y(p.y))));
    ctx.strokeStyle = s.color; ctx.lineWidth = 2; ctx.stroke();
    if (s.fill) {
      ctx.lineTo(X(s.points[s.points.length - 1].x), Y(y0)); ctx.lineTo(X(s.points[0].x), Y(y0)); ctx.closePath();
      const g = ctx.createLinearGradient(0, pad.t, 0, H - pad.b); g.addColorStop(0, s.fill); g.addColorStop(1, 'transparent');
      ctx.fillStyle = g; ctx.fill();
    }
  }
  if (marker) {
    ctx.beginPath(); ctx.arc(X(marker.x), Y(marker.y), 5.5, 0, Math.PI * 2);
    ctx.fillStyle = '#fff'; ctx.fill(); ctx.lineWidth = 3; ctx.strokeStyle = '#ff7a3d'; ctx.stroke();
    ctx.beginPath(); ctx.setLineDash([3, 4]); ctx.moveTo(X(marker.x), pad.t); ctx.lineTo(X(marker.x), H - pad.b); ctx.strokeStyle = 'rgba(255,122,61,.5)'; ctx.lineWidth = 1; ctx.stroke(); ctx.setLineDash([]);
  }
}

// ---------- pool drawer ----------
let openPoolId = null;
async function openPool(id) {
  openPoolId = id;
  $('#drawer').hidden = false;
  $('#drawer-body').innerHTML = '<p class="mut">Loading…</p>';
  history.replaceState(null, '', `#pool=${id}`);
  let p;
  try { p = await api(`/api/pools/${id}`); } catch { $('#drawer-body').innerHTML = '<p class="mut">Pool not observed yet.</p>'; return; }
  const curve = p.config ? await api(`/api/curve/${p.config}`).catch(() => null) : null;
  if (openPoolId !== id) return;
  const host = location.origin;
  const done = p.status !== 'bonding';
  $('#drawer-body').innerHTML = `
    <div class="d-head">
      ${p.image ? `<img src="${esc(p.image)}" alt="">` : '<span class="ph"></span>'}
      <div>
        <h3>${esc(p.symbol || short(p.mint))} <span class="mut" style="font-weight:400;font-size:14px">${esc(p.name || '')}</span></h3>
        <div class="links">
          <a href="https://solscan.io/token/${p.mint}" target="_blank" rel="noopener">Mint ↗</a>
          <a href="https://solscan.io/account/${p.pool}" target="_blank" rel="noopener">DBC pool ↗</a>
          ${p.dammPool ? `<a href="https://www.meteora.ag/dammv2/${p.dammPool}" target="_blank" rel="noopener">DAMM v2 pool ↗</a>` : ''}
          <a href="https://jup.ag/swap/SOL-${p.mint}" target="_blank" rel="noopener">Trade ↗</a>
          <a href="${host}/api/pools/${p.pool}" target="_blank" rel="noopener">JSON ↗</a>
        </div>
      </div>
    </div>
    <div class="prog"><div class="bar ${done ? 'done' : ''}" style="flex:1;height:12px"><i style="width:${done ? 100 : p.progress ?? 0}%"></i></div><span style="width:auto">${done ? (p.status === 'migrated' ? '→ ' + esc(p.migrationTarget) : 'graduated') : (p.progress ?? 0).toFixed(2) + '%'}</span></div>
    <div class="kpis">
      <div class="kpi"><div class="l">Market cap</div><div class="v">${usd(p.mcapUsd)}</div></div>
      <div class="kpi"><div class="l">Raised / target</div><div class="v">${num(p.reserve)} / ${num(p.threshold)} <small class="mut">${esc(p.quoteSymbol || '')}</small></div></div>
      <div class="kpi"><div class="l">Grad. ETA</div><div class="v">${done ? '✓' : dur(p.etaSec)}</div></div>
      <div class="kpi"><div class="l">Vol 5m / 1h</div><div class="v">${usd(p.m5.volumeUsd)} / ${usd(p.h1.volumeUsd)}</div></div>
      <div class="kpi"><div class="l">Net flow 5m</div><div class="v ${pctClass(p.m5.netFlowUsd)}">${usd(p.m5.netFlowUsd, { sign: true })}</div></div>
      <div class="kpi"><div class="l">Buys / sells</div><div class="v"><span class="pos">${p.buys}</span> / <span class="neg">${p.sells}</span></div></div>
      <div class="kpi"><div class="l">Traders</div><div class="v">${p.traders}</div></div>
      <div class="kpi"><div class="l">Snipers · whales</div><div class="v">${p.snipers} · ${p.whaleBuys}</div></div>
      <div class="kpi"><div class="l">Dev buys / sells</div><div class="v">${p.devBuys} / ${p.devSells}</div></div>
      <div class="kpi"><div class="l">Change 5m</div><div class="v ${pctClass(p.change5m)}">${p.change5m == null ? '—' : p.change5m.toFixed(1) + '%'}</div></div>
    </div>

    <div class="d-sec"><h4>Bonding progress (live)</h4><canvas class="chart" id="c-prog"></canvas></div>

    ${curve ? `<div class="d-sec"><h4>Curve explorer — config ${short(p.config)}</h4>
      <canvas class="chart" id="c-curve"></canvas>
      <div class="legend"><span><i style="background:#ff7a3d"></i>price along the curve (${esc(curve.quoteSymbol)} per token)</span><span>● current position</span><span>${curve.segments} liquidity segments</span></div>
      <div class="params" style="margin-top:12px">
        <div><span>Migration threshold</span><b>${num(curve.threshold)} ${esc(curve.quoteSymbol)}</b></div>
        <div><span>Migrates to</span><b>${esc(curve.migrationTarget)}</b></div>
        <div><span>Start price</span><b>${num(curve.startPrice)}</b></div>
        <div><span>Migration price</span><b>${num(curve.migrationPrice)}</b></div>
        <div><span>Price multiple</span><b>${num(curve.migrationPrice / curve.startPrice, 1)}×</b></div>
        <div><span>Base fee (cliff)</span><b>${(Number(curve.baseFee.cliffFeeNumerator) / 1e7).toFixed(2)}%</b></div>
        <div><span>Fee scheduler</span><b>${['linear', 'exponential', 'rate limiter', 'mcap linear', 'mcap exp.'][curve.baseFee.mode] ?? curve.baseFee.mode}</b></div>
        <div><span>Dynamic fee</span><b>${curve.dynamicFee ? 'on' : 'off'}</b></div>
        <div><span>Creator fee share</span><b>${curve.creatorFeePct}%</b></div>
        <div><span>Migration fee</span><b>${curve.migrationFeePct}%</b></div>
      </div></div>` : ''}

    <div class="d-sec"><h4>Stream this pool <button class="copy" data-copy="snip-sse">copy</button></h4>
<pre class="snip" id="snip-sse">// Browser or Node 18+
const es = new EventSource('${host}/api/stream?pool=${p.pool}');
es.addEventListener('swap', (m) => console.log(JSON.parse(m.data)));
es.addEventListener('graduated', (m) => console.log('🎓', JSON.parse(m.data)));</pre></div>

    <div class="d-sec"><h4>Recent activity</h4><ul class="tape-list" style="max-height:340px">${p.events.slice().reverse().slice(0, 60).map((e) => `<li>${tapeRow(e)}</li>`).join('') || '<li class="empty">—</li>'}</ul></div>`;

  const h = p.history || [];
  lineChart($('#c-prog'), [{ points: h.map((x) => ({ x: x.t, y: x.progress })), color: '#ff7a3d', fill: 'rgba(255,122,61,.25)' }],
    { xFmt: (v) => clock(v), yFmt: (v) => v.toFixed(0) + '%' });
  if (curve) {
    const cur = p.reserve != null && p.priceQuote != null ? { x: done ? curve.threshold : p.reserve, y: p.priceQuote } : null;
    lineChart($('#c-curve'), [{ points: curve.points.map((x) => ({ x: x.quote, y: x.price })), color: '#ff7a3d', fill: 'rgba(255,122,61,.18)' }],
      { xFmt: (v) => num(v, 1) + ' ' + curve.quoteSymbol, yFmt: (v) => num(v), marker: cur });
  }
}
function closeDrawer() { $('#drawer').hidden = true; openPoolId = null; history.replaceState(null, '', location.pathname); }
$('#drawer-close').addEventListener('click', closeDrawer);
$('#drawer').addEventListener('click', (e) => { if (e.target.id === 'drawer') closeDrawer(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-copy]'); if (!b) return;
  navigator.clipboard?.writeText($('#' + b.dataset.copy).textContent); b.textContent = 'copied ✓'; setTimeout(() => (b.textContent = 'copy'), 1500);
});

// ---------- live stream ----------
function connect() {
  const es = new EventSource('/api/stream');
  const onEv = (m) => {
    const e = JSON.parse(m.data);
    recent.push(e); if (recent.length > 600) recent.shift();
    pushTape(e);
    pushLife(e);
  };
  ['swap', 'pool_created', 'graduated', 'migrated', 'near_graduation'].forEach((t) => es.addEventListener(t, onEv));
  es.addEventListener('stats', (m) => renderStats(JSON.parse(m.data)));
  es.onerror = () => renderStats({ wsConnected: false, txProcessedPerMin: 0, coveragePct: 0, pools: 0, launchpads: 0, totals: { events: 0, processed: 0 }, rpc: { calls: 0 }, uptimeSec: 0 });
}

async function boot() {
  api('/api/stats').then(renderStats).catch(() => {});
  const { events } = await api('/api/events?limit=300').catch(() => ({ events: [] }));
  events.forEach((e) => { recent.push(e); pushTape(e, false); pushLife(e); });
  connect();
  loadRadar(); loadPads(); loadTraders();
  setInterval(loadRadar, 3000);
  setInterval(() => { loadPads(); loadTraders(); }, 8000);
  const m = location.hash.match(/pool=(\w+)/); if (m) openPool(m[1]);
}
boot();
