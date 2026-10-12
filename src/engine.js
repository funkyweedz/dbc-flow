// Moteur : ingestion temps réel (logsSubscribe) → file à priorités → getTransaction
// → décodage → enrichissement → état agrégé + bus d'events.
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { config, DBC_PROGRAM_ID, KNOWN_QUOTES } from './config.js';
import { rpc, rpcStats, currentRate } from './rpc.js';
import { decodeTransaction, ixNamesFromLogs } from './decoder.js';
import { save as saveSnapshot, load as loadSnapshot } from './persist.js';
import { ensurePool, ensureConfig, ensureToken, configs, quoteUsd, startAccountLoop, startPriceLoop } from './accounts.js';

export const bus = new EventEmitter();
bus.setMaxListeners(0);

// ---------- État ----------
export const poolState = new Map();     // pool -> stats agrégées
export const launchpads = new Map();    // config -> stats agrégées
export const traders = new Map();       // wallet -> { buys, sells, volumeUsd, pnlQuote… }
const events = [];                      // ring buffer d'events enrichis
let seq = 0;

const stats = {
  startedAt: Date.now(),
  seen: 0, processed: 0, dropped: 0, failed: 0, events: 0,
  wsConnected: false, lastWsMsg: 0,
  seenWindow: [], processedWindow: [],
};

const HIGH = /initialize|migrat|create_config|Initialize|Migrat|CreateConfig/;
const queue = { high: [], normal: [] };
const seenSigs = new Set();
const seenOrder = [];

function remember(sig) {
  if (seenSigs.has(sig)) return false;
  seenSigs.add(sig);
  seenOrder.push(sig);
  if (seenOrder.length > 20_000) seenSigs.delete(seenOrder.shift());
  return true;
}

function enqueue(sig, priority) {
  if (!remember(sig)) return;
  stats.seen++;
  stats.seenWindow.push(Date.now());
  const item = { sig, at: Date.now(), tries: 0 };
  if (priority === 'high') queue.high.push(item);
  else {
    queue.normal.push(item);
    while (queue.normal.length > config.maxQueue) { queue.normal.shift(); stats.dropped++; }
  }
}

// ---------- Ingestion WebSocket ----------
function connectWs() {
  const ws = new WebSocket(config.wsUrl);
  let ping;
  ws.on('open', () => {
    stats.wsConnected = true;
    console.log('[ws] connecté, abonnement aux logs du program DBC');
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'logsSubscribe',
      params: [{ mentions: [DBC_PROGRAM_ID] }, { commitment: 'confirmed' }] }));
    ping = setInterval(() => ws.readyState === 1 && ws.ping(), 25_000);
  });
  ws.on('message', (raw) => {
    stats.lastWsMsg = Date.now();
    let j;
    try { j = JSON.parse(raw); } catch { return; }
    const v = j.params?.result?.value;
    if (!v || v.err) return;
    const names = ixNamesFromLogs(v.logs);
    enqueue(v.signature, names.some((n) => HIGH.test(n)) ? 'high' : 'normal');
  });
  const retry = () => {
    clearInterval(ping);
    if (!stats.wsConnected) return;
    stats.wsConnected = false;
    console.warn('[ws] déconnecté, reconnexion dans 2s');
    setTimeout(connectWs, 2000);
  };
  ws.on('close', retry);
  ws.on('error', (e) => { console.warn('[ws]', e.message); ws.close(); });
  // Watchdog : si plus aucun message depuis 60s, on force une reconnexion.
  const wd = setInterval(() => {
    if (ws.readyState === 1 && Date.now() - stats.lastWsMsg > 60_000) { ws.terminate(); clearInterval(wd); }
    if (ws.readyState > 1) clearInterval(wd);
  }, 15_000);
}

// ---------- Workers ----------
const MIN_AGE_MS = 1200; // getTransaction renvoie null si la tx est trop fraîche
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function worker() {
  for (;;) {
    const item = queue.high.shift() ?? queue.normal.shift();
    if (!item) { await sleep(100); continue; }
    const age = Date.now() - item.at;
    if (age < MIN_AGE_MS) await sleep(MIN_AGE_MS - age);
    try {
      const tx = await rpc('getTransaction', [item.sig, { encoding: 'json', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }]);
      if (!tx) {
        if (++item.tries < 3) { item.at = Date.now(); queue.high.push(item); } else stats.failed++;
        continue;
      }
      stats.processed++;
      stats.processedWindow.push(Date.now());
      await processTx(tx, item.sig);
    } catch (e) {
      stats.failed++;
      if (stats.failed % 50 === 1) console.warn('[worker]', e.message);
    }
  }
}

async function processTx(tx, sig) {
  const raw = decodeTransaction(tx, sig);
  for (const ev of raw) {
    try { await handle(ev); } catch (e) { console.warn('[handle]', ev.type, e.message); }
  }
}

// ---------- Mode batch : getTransactionsForAddress (Helius) ----------
// Une requête = jusqu'à 100 transactions complètes, triées par slot croissant.
let lastSlot = 0;
async function pollBatch() {
  let pages = 0;
  let token;
  for (;;) {
    const opts = { transactionDetails: 'full', encoding: 'json', maxSupportedTransactionVersion: 1,
      limit: 100, filters: { status: 'succeeded' } };
    if (lastSlot) { opts.sortOrder = 'asc'; opts.filters.slot = { gte: lastSlot }; }
    else opts.sortOrder = 'desc'; // premier appel : on démarre sur les 100 dernières
    if (token) opts.paginationToken = token;
    const r = await rpc('getTransactionsForAddress', [DBC_PROGRAM_ID, opts]);
    const data = r?.data ?? [];
    if (!lastSlot) data.reverse();
    for (const tx of data) {
      const sig = tx.transaction.signatures[0];
      if (!remember(sig)) continue;
      stats.seen++; stats.seenWindow.push(Date.now());
      stats.processed++; stats.processedWindow.push(Date.now());
      await processTx(tx, sig);
      if (tx.slot > lastSlot) lastSlot = tx.slot;
    }
    if (!lastSlot && data.length) lastSlot = data[data.length - 1].slot;
    pages++;
    if (data.length < 100 || !r.paginationToken || pages >= 5 || opts.sortOrder === 'desc') break;
    token = r.paginationToken;
  }
}

function startBatchLoop() {
  stats.wsConnected = true; // pas de WS dans ce mode : on reporte l'état du poller
  const tick = async () => {
    const t0 = Date.now();
    try { await pollBatch(); stats.lastWsMsg = Date.now(); }
    catch (e) { stats.failed++; console.warn('[batch]', e.message); }
    setTimeout(tick, Math.max(200, config.pollMs - (Date.now() - t0)));
  };
  tick();
}

// ---------- Enrichissement ----------
const Q64 = 2 ** 64;
const ui = (raw, dec) => Number(raw) / 10 ** dec;

function priceFromSqrt(sqrt, baseDec, quoteDec) {
  const s = Number(sqrt) / Q64;
  return s * s * 10 ** (baseDec - quoteDec);
}

function getPoolStat(addr) {
  let p = poolState.get(addr);
  if (!p) {
    p = {
      pool: addr, status: 'bonding', firstSeen: Date.now(), createdAt: null, lastTradeAt: 0,
      trades: [], history: [], traderSet: new Set(), buys: 0, sells: 0,
      snipers: 0, sniperQuote: 0, whaleBuys: 0, devBuys: 0, devSells: 0,
      progress: null, priceQuote: null, priceUsd: null, mcapUsd: null, volumeUsd: 0,
    };
    poolState.set(addr, p);
  }
  return p;
}

function getLaunchpad(cfg) {
  let l = launchpads.get(cfg);
  if (!l) {
    l = { config: cfg, pools: new Set(), created: 0, graduated: 0, migrated: 0, volumeUsd: 0, trades: 0, fees: 0 };
    launchpads.set(cfg, l);
  }
  return l;
}

async function context(poolAddr, cfgHint) {
  const pool = await ensurePool(poolAddr);
  const cfgAddr = pool?.config ?? cfgHint;
  const cfg = cfgAddr ? await ensureConfig(cfgAddr) : null;
  const mint = pool?.mint;
  const [base, quote] = await Promise.all([
    mint ? ensureToken(mint) : null,
    cfg ? ensureToken(cfg.quoteMint) : null,
  ]);
  return { pool, cfg, cfgAddr, mint, base, quote };
}

function applyMeta(p, c) {
  p.config = c.cfgAddr;
  if (c.pool) { p.creator = c.pool.creator; p.mint = c.pool.mint; if (p.status === 'bonding') {
      if (c.pool.isMigrated) p.status = 'migrated';
      else if (c.pool.migrationProgress >= 1) p.status = 'graduated';
    } }
  if (c.base) { p.symbol = c.base.symbol; p.name = c.base.name; p.image = c.base.image; p.spoof = !!c.base.spoof; }
  if (c.cfg) {
    p.quoteMint = c.cfg.quoteMint;
    p.quoteSymbol = c.quote?.symbol ?? KNOWN_QUOTES[c.cfg.quoteMint]?.symbol ?? '?';
    p.migrationTarget = c.cfg.migrationOption === 1 ? 'DAMM v2' : 'DAMM v1';
  }
}

function emit(ev) {
  ev.id = ++seq;
  events.push(ev);
  if (events.length > config.eventBuffer) events.shift();
  stats.events++;
  bus.emit('event', ev);
}

async function handle(raw) {
  const c = await context(raw.pool, raw.config);
  const p = getPoolStat(raw.pool);
  applyMeta(p, c);
  const lp = getLaunchpad(c.cfgAddr ?? raw.config);
  lp.pools.add(raw.pool);
  if (c.cfg) lp.feeClaimer = c.cfg.feeClaimer;

  const baseDec = c.cfg?.baseDecimals ?? c.base?.decimals ?? 6;
  const quoteDec = c.quote?.decimals ?? KNOWN_QUOTES[c.cfg?.quoteMint]?.decimals ?? 9;
  const qUsd = c.cfg ? quoteUsd(c.cfg.quoteMint) : 0;
  const common = {
    type: raw.type, sig: raw.sig, slot: raw.slot, ts: raw.ts, pool: raw.pool, config: p.config,
    mint: p.mint, symbol: p.symbol, name: p.name, image: p.image, quoteSymbol: p.quoteSymbol,
  };

  if (raw.type === 'swap') {
    const baseAmt = ui(raw.baseRaw, baseDec);
    const quoteAmt = ui(raw.quoteRaw, quoteDec);
    const usd = quoteAmt * qUsd;
    const priceQuote = priceFromSqrt(raw.sqrtPrice, baseDec, quoteDec);
    const supply = c.base?.supply != null && c.base?.decimals != null
      ? c.base.supply / 10 ** c.base.decimals
      : c.cfg?.supplyPreMigration ? ui(c.cfg.supplyPreMigration, baseDec) : null;
    let progress = null;
    if (raw.quoteReserveRaw != null && raw.thresholdRaw > 0n) progress = Number(raw.quoteReserveRaw * 10000n / raw.thresholdRaw) / 100;
    else if (c.cfg?.thresholdRaw > 0n && c.pool) progress = null;
    progress = progress == null ? null : Math.min(100, progress);

    const isBuy = raw.side === 'buy';
    const sinceCreate = p.createdAt ? (raw.ts - p.createdAt) / 1000 : null;
    const sniper = isBuy && sinceCreate != null && sinceCreate <= config.sniperWindowSec;
    const isDev = p.creator && raw.signer === p.creator;
    const whale = isBuy && usd >= config.whaleUsd;

    // agrégats pool (l'état "courant" n'avance qu'avec des slots plus récents)
    const fresh = raw.slot >= (p.lastSlot ?? 0);
    if (fresh) {
      p.lastSlot = raw.slot;
      p.lastTradeAt = raw.ts;
      p.priceQuote = priceQuote;
      p.priceUsd = priceQuote * qUsd;
      p.mcapUsd = supply ? supply * p.priceUsd : null;
      if (progress != null && p.status === 'bonding') p.progress = progress;
      if (raw.thresholdRaw) p.thresholdUi = ui(raw.thresholdRaw, quoteDec);
      if (raw.quoteReserveRaw != null) p.reserveUi = ui(raw.quoteReserveRaw, quoteDec);
    }
    p.volumeUsd += usd;
    isBuy ? p.buys++ : p.sells++;
    p.traderSet.add(raw.signer);
    if (sniper) { p.snipers++; p.sniperQuote += quoteAmt; }
    if (whale) p.whaleBuys++;
    if (isDev) isBuy ? p.devBuys++ : p.devSells++;
    p.trades.push({ t: raw.ts, usd, side: raw.side, w: raw.signer });
    if (p.trades.length > 1500) p.trades.splice(0, p.trades.length - 1500);
    if (progress != null && fresh) {
      p.history.push({ t: raw.ts, progress, price: p.priceUsd || priceQuote, mcap: p.mcapUsd });
      if (p.history.length > 400) p.history.splice(0, p.history.length - 400);
    }

    // Fees : collect_fee_mode 0 → toujours en quote ; 1 → dans le token de sortie.
    const feeInBase = c.cfg?.collectFeeMode === 1 && isBuy;
    const feesUsd = feeInBase ? ui(raw.fees, baseDec) * (p.priceUsd || 0) : ui(raw.fees, quoteDec) * qUsd;
    p.feesUsd = (p.feesUsd ?? 0) + feesUsd;
    lp.volumeUsd += usd; lp.trades++; lp.fees += feesUsd;

    // agrégats trader
    let tr = traders.get(raw.signer);
    if (!tr) { tr = { wallet: raw.signer, buys: 0, sells: 0, volumeUsd: 0, pools: new Set(), snipes: 0, lastAt: 0 }; traders.set(raw.signer, tr); }
    isBuy ? tr.buys++ : tr.sells++;
    tr.volumeUsd += usd; tr.pools.add(raw.pool); tr.lastAt = raw.ts; if (sniper) tr.snipes++;

    const flags = [];
    if (whale) flags.push('whale');
    if (sniper) flags.push('sniper');
    if (isDev) flags.push('dev');
    const ev = { ...common, side: raw.side, trader: raw.signer, baseAmount: baseAmt, quoteAmount: quoteAmt, usd,
      priceQuote, priceUsd: p.priceUsd, mcapUsd: p.mcapUsd, progress, flags };
    emit(ev);

    // Alerte "near graduation" la première fois qu'on franchit le seuil.
    if (progress != null && progress >= config.nearGradPct && !p.nearGradAlerted && p.status === 'bonding') {
      p.nearGradAlerted = true;
      emit({ ...common, type: 'near_graduation', progress, etaSec: eta(p), mcapUsd: p.mcapUsd });
    }
    return;
  }

  if (raw.type === 'pool_created') {
    p.createdAt = raw.ts; p.creator = raw.creator; p.mint = raw.mint;
    lp.created++;
    emit({ ...common, mint: raw.mint, creator: raw.creator, migrationTarget: p.migrationTarget });
    return;
  }
  if (raw.type === 'graduated') {
    if (p.status === 'bonding') p.status = 'graduated';
    p.progress = 100; p.graduatedAt = raw.ts;
    lp.graduated++;
    emit({ ...common, quoteReserve: ui(raw.quoteReserve, quoteDec), mcapUsd: p.mcapUsd,
      timeToGraduateSec: p.createdAt ? (raw.ts - p.createdAt) / 1000 : null });
    return;
  }
  if (raw.type === 'migrated') {
    p.status = 'migrated'; p.dammPool = raw.dammPool; p.migratedAt = raw.ts; p.progress = 100;
    lp.migrated++;
    emit({ ...common, dammPool: raw.dammPool, target: raw.target });
  }
}

// ---------- Dérivés ----------
// ETA de graduation : vitesse de progression (régression simple) sur les 10 dernières minutes.
export function eta(p) {
  if (p.status !== 'bonding' || p.progress == null) return null;
  const since = Date.now() - 10 * 60_000;
  const h = p.history.filter((x) => x.t >= since);
  if (h.length < 3) return null;
  const n = h.length;
  const mt = h.reduce((s, x) => s + x.t, 0) / n;
  const mp = h.reduce((s, x) => s + x.progress, 0) / n;
  let num = 0, den = 0;
  for (const x of h) { num += (x.t - mt) * (x.progress - mp); den += (x.t - mt) ** 2; }
  const slope = den ? num / den : 0; // % par ms
  if (slope <= 0) return null;
  const sec = (100 - p.progress) / slope / 1000;
  return sec < 7 * 86400 ? Math.round(sec) : null;
}

function windowStats(p, ms) {
  const since = Date.now() - ms;
  let vol = 0, buys = 0, sells = 0, net = 0;
  const w = new Set();
  for (let i = p.trades.length - 1; i >= 0; i--) {
    const t = p.trades[i];
    if (t.t < since) break;
    vol += t.usd; w.add(t.w);
    if (t.side === 'buy') { buys++; net += t.usd; } else { sells++; net -= t.usd; }
  }
  return { volumeUsd: vol, buys, sells, netFlowUsd: net, traders: w.size };
}

function changePct(p, ms) {
  const since = Date.now() - ms;
  const old = p.history.find((x) => x.t >= since);
  const cur = p.history[p.history.length - 1];
  if (!old || !cur || !old.price) return null;
  return ((cur.price - old.price) / old.price) * 100;
}

export function serializePool(p, { withHistory = false } = {}) {
  const w5 = windowStats(p, 5 * 60_000);
  const w1h = windowStats(p, 60 * 60_000);
  const out = {
    pool: p.pool, mint: p.mint, symbol: p.symbol, name: p.name, image: p.image, config: p.config,
    creator: p.creator, quoteSymbol: p.quoteSymbol, spoofedTicker: !!p.spoof, status: p.status, migrationTarget: p.migrationTarget,
    dammPool: p.dammPool ?? null, progress: p.progress, etaSec: eta(p),
    priceUsd: p.priceUsd, priceQuote: p.priceQuote, mcapUsd: p.mcapUsd,
    reserve: p.reserveUi ?? null, threshold: p.thresholdUi ?? null,
    change5m: changePct(p, 5 * 60_000), change1h: changePct(p, 60 * 60_000),
    m5: w5, h1: w1h, volumeUsdTotal: p.volumeUsd, feesUsd: p.feesUsd ?? 0, buys: p.buys, sells: p.sells, traders: p.traderSet.size,
    snipers: p.snipers, whaleBuys: p.whaleBuys, devBuys: p.devBuys, devSells: p.devSells,
    createdAt: p.createdAt, firstSeen: p.firstSeen, lastTradeAt: p.lastTradeAt,
    graduatedAt: p.graduatedAt ?? null, migratedAt: p.migratedAt ?? null,
  };
  if (withHistory) out.history = p.history;
  return out;
}

export function serializeLaunchpad(l) {
  const cfg = configs.get(l.config);
  return {
    config: l.config, feeClaimer: l.feeClaimer ?? cfg?.feeClaimer ?? null, quoteMint: cfg?.quoteMint ?? null,
    pools: l.pools.size, created: l.created, graduated: l.graduated, migrated: l.migrated,
    volumeUsd: l.volumeUsd, trades: l.trades, feesUsd: l.fees,
    migrationTarget: cfg ? (cfg.migrationOption === 1 ? 'DAMM v2' : 'DAMM v1') : null,
    threshold: cfg?.thresholdRaw ? Number(cfg.thresholdRaw) / 10 ** (KNOWN_QUOTES[cfg.quoteMint]?.decimals ?? 9) : null,
    creatorFeePct: cfg?.creatorFeePct ?? null,
  };
}

export function recentEvents({ since = 0, types, pool, limit = 200 } = {}) {
  const out = [];
  for (let i = events.length - 1; i >= 0 && out.length < limit; i--) {
    const e = events[i];
    if (e.id <= since) break;
    if (types && !types.has(e.type) && !(types.has('whale') && e.flags?.includes('whale')) && !(types.has('sniper') && e.flags?.includes('sniper'))) continue;
    if (pool && e.pool !== pool) continue;
    out.push(e);
  }
  return out.reverse();
}

export function getStats() {
  const now = Date.now();
  const trim = (arr) => { while (arr.length && arr[0] < now - 60_000) arr.shift(); return arr.length; };
  const seenPm = trim(stats.seenWindow);
  const procPm = trim(stats.processedWindow);
  return {
    mode: config.ingestMode,
    uptimeSec: Math.round((now - stats.startedAt) / 1000),
    wsConnected: stats.wsConnected,
    txSeenPerMin: seenPm, txProcessedPerMin: procPm,
    coveragePct: seenPm ? Math.min(100, Math.round((procPm / seenPm) * 100)) : 100,
    totals: { seen: stats.seen, processed: stats.processed, dropped: stats.dropped, failed: stats.failed, events: stats.events },
    queue: { high: queue.high.length, normal: queue.normal.length },
    rpc: { ...rpcStats, rate: Number(currentRate().toFixed(2)) },
    pools: poolState.size, launchpads: launchpads.size, traders: traders.size,
  };
}

// Nettoyage mémoire : on oublie les pools inactifs.
function gc() {
  const cutoff = Date.now() - config.poolTtlMin * 60_000;
  for (const [k, p] of poolState) if (Math.max(p.lastTradeAt, p.firstSeen) < cutoff) poolState.delete(k);
  for (const [k, t] of traders) if (t.lastAt < cutoff) traders.delete(k);
}

async function backfill() {
  if (!config.backfill) return;
  try {
    const sigs = await rpc('getSignaturesForAddress', [DBC_PROGRAM_ID, { limit: config.backfill }]);
    sigs.filter((s) => !s.err).reverse().forEach((s) => enqueue(s.signature, 'normal'));
    console.log(`[backfill] ${sigs.length} tx récentes en file`);
  } catch (e) { console.warn('[backfill]', e.message); }
}

export function snapshot() {
  saveSnapshot({
    seq, lastSlot,
    pools: [...poolState.values()],
    launchpads: [...launchpads.values()],
    traders: [...traders.values()].sort((a, b) => b.volumeUsd - a.volumeUsd).slice(0, 5000),
    events: events.slice(-config.eventBuffer),
    totals: { seen: stats.seen, processed: stats.processed, events: stats.events },
  });
}

function restore() {
  const s = loadSnapshot();
  if (!s) return;
  const age = Date.now() - s.savedAt;
  if (age > config.poolTtlMin * 60_000) return; // trop vieux : on repart de zéro
  s.pools.forEach((p) => poolState.set(p.pool, p));
  s.launchpads.forEach((l) => launchpads.set(l.config, l));
  s.traders.forEach((t) => traders.set(t.wallet, t));
  events.push(...s.events);
  seq = s.seq;
  Object.assign(stats, s.totals);
  // On reprend l'ingestion là où on s'était arrêté si le trou est court (< 10 min), sinon au présent.
  if (age < 10 * 60_000) lastSlot = s.lastSlot;
  console.log(`[persist] état restauré (${poolState.size} pools, ${events.length} events, âge ${Math.round(age / 1000)}s)`);
}

export async function startEngine({ workers = 6 } = {}) {
  restore();
  setInterval(snapshot, 30_000);
  await startPriceLoop();
  startAccountLoop();
  if (config.ingestMode === 'batch') {
    console.log(`[engine] mode batch (getTransactionsForAddress, toutes les ${config.pollMs} ms)`);
    startBatchLoop();
  } else {
    console.log('[engine] mode single (logsSubscribe + getTransaction)');
    connectWs();
    await backfill();
    for (let i = 0; i < workers; i++) worker();
  }
  setInterval(gc, 60_000);
  setInterval(() => bus.emit('stats', getStats()), 5000);
}
