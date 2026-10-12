import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config } from './config.js';
import {
  bus, startEngine, snapshot, ensureFresh, poolState, launchpads, traders, serializePool, serializeLaunchpad, recentEvents, getStats, eta,
} from './engine.js';
import { sampleCurve } from './curve.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => { res.setHeader('Access-Control-Allow-Origin', '*'); next(); });

// Le moteur démarre au premier appel (indispensable en serverless) ; avant chaque réponse API,
// on rattrape les tx manquées si l'instance a été suspendue.
app.use(['/api', '/health'], async (req, res, next) => {
  try {
    await startEngine();
    if (req.path !== '/stream') await ensureFresh();
  } catch (e) { console.warn('[engine]', e.message); }
  next();
});

const EVENT_TYPES = ['swap', 'pool_created', 'graduated', 'migrated', 'near_graduation', 'whale', 'sniper'];
const parseTypes = (q) => (q ? new Set(String(q).split(',').map((s) => s.trim()).filter(Boolean)) : null);
const clamp = (v, d, max) => Math.max(1, Math.min(max, Number(v) || d));

// JSON avec BigInt → string
app.set('json replacer', (_k, v) => (typeof v === 'bigint' ? v.toString() : v));

// ---------- REST ----------
app.get('/api/stats', (_req, res) => res.json(getStats()));

const SORTS = {
  progress: (p) => p.progress ?? -1,
  volume5m: (p) => p.m5.volumeUsd,
  volume1h: (p) => p.h1.volumeUsd,
  new: (p) => p.createdAt ?? p.firstSeen,
  mcap: (p) => p.mcapUsd ?? 0,
  eta: (p) => (p.etaSec == null ? -Infinity : -p.etaSec),
  netflow5m: (p) => p.m5.netFlowUsd,
  recent: (p) => p.lastTradeAt,
};

app.get('/api/pools', (req, res) => {
  const sort = SORTS[req.query.sort] ? req.query.sort : 'volume5m';
  const status = req.query.status;
  const minProgress = Number(req.query.minProgress) || 0;
  const quote = req.query.quote?.toUpperCase();
  const launchpad = req.query.config;
  let list = [...poolState.values()].filter((p) => p.mint).map((p) => serializePool(p));
  if (status) list = list.filter((p) => p.status === status);
  if (minProgress) list = list.filter((p) => (p.progress ?? 0) >= minProgress);
  if (quote) list = list.filter((p) => p.quoteSymbol === quote);
  if (launchpad) list = list.filter((p) => p.config === launchpad);
  if (req.query.newOnly === 'true') list = list.filter((p) => p.createdAt);
  list.sort((a, b) => SORTS[sort](b) - SORTS[sort](a));
  res.json({ sort, count: list.length, pools: list.slice(0, clamp(req.query.limit, 50, 500)) });
});

app.get('/api/pools/:pool', (req, res) => {
  const p = poolState.get(req.params.pool);
  if (!p) return res.status(404).json({ error: 'pool inconnu (pas encore observé)' });
  res.json({ ...serializePool(p, { withHistory: true }), events: recentEvents({ pool: p.pool, limit: 100 }) });
});

app.get('/api/launchpads', (req, res) => {
  const sort = ['volumeUsd', 'created', 'graduated', 'trades', 'pools', 'feesUsd'].includes(req.query.sort) ? req.query.sort : 'volumeUsd';
  const list = [...launchpads.values()].map(serializeLaunchpad).sort((a, b) => b[sort] - a[sort]);
  res.json({ sort, count: list.length, launchpads: list.slice(0, clamp(req.query.limit, 50, 500)) });
});

app.get('/api/traders', (req, res) => {
  const sort = ['volumeUsd', 'snipes', 'buys'].includes(req.query.sort) ? req.query.sort : 'volumeUsd';
  const list = [...traders.values()]
    .map((t) => ({ wallet: t.wallet, buys: t.buys, sells: t.sells, volumeUsd: t.volumeUsd, pools: t.pools.size, snipes: t.snipes, lastAt: t.lastAt }))
    .sort((a, b) => b[sort] - a[sort]);
  res.json({ sort, traders: list.slice(0, clamp(req.query.limit, 50, 500)) });
});

app.get('/api/events', (req, res) => {
  res.json({ events: recentEvents({
    since: Number(req.query.since) || 0, types: parseTypes(req.query.types), pool: req.query.pool,
    limit: clamp(req.query.limit, 100, 2000),
  }) });
});

app.get('/api/curve/:config', async (req, res) => {
  try {
    const c = await sampleCurve(req.params.config);
    if (!c) return res.status(404).json({ error: 'config introuvable' });
    res.json(c);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- SSE ----------
// /api/stream?types=graduated,whale&pool=XYZ  (supporte Last-Event-ID pour le replay)
app.get('/api/stream', (req, res) => {
  const types = parseTypes(req.query.types);
  const pools = req.query.pool ? new Set(String(req.query.pool).split(',')) : null;
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 3000\n\n');
  const match = (e) => (!types || types.has(e.type) || (e.flags && e.flags.some((f) => types.has(f)))) && (!pools || pools.has(e.pool));
  const send = (e) => res.write(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  const lastId = Number(req.headers['last-event-id'] || req.query.since || 0);
  if (lastId) recentEvents({ since: lastId, limit: 2000 }).filter(match).forEach(send);
  const onEvent = (e) => match(e) && send(e);
  const onStats = (s) => req.query.stats !== 'false' && res.write(`event: stats\ndata: ${JSON.stringify(s)}\n\n`);
  bus.on('event', onEvent);
  bus.on('stats', onStats);
  const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
  // Serverless : on ferme proprement avant le maxDuration de la fonction ; EventSource se
  // reconnecte tout seul et Last-Event-ID rejoue ce qui a été manqué.
  const cap = config.serverless ? setTimeout(() => res.end(), 270_000) : null;
  req.on('close', () => { clearInterval(ping); clearTimeout(cap); bus.off('event', onEvent); bus.off('stats', onStats); });
});

app.get('/api/schema', (_req, res) => res.json({ eventTypes: EVENT_TYPES, sorts: Object.keys(SORTS) }));
app.get('/health', (_req, res) => res.json({ ok: true, ...getStats() }));
app.use(express.static(join(__dirname, '..', 'public'), { extensions: ['html'] }));

// ---------- WebSocket ----------
// Client → {"op":"subscribe","types":["graduated","whale"],"pools":["..."]}
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (sock) => {
  let types = null, pools = null;
  const onEvent = (e) => {
    if (sock.readyState !== 1) return;
    if (types && !types.has(e.type) && !(e.flags && e.flags.some((f) => types.has(f)))) return;
    if (pools && !pools.has(e.pool)) return;
    sock.send(JSON.stringify(e));
  };
  sock.on('message', (m) => {
    try {
      const msg = JSON.parse(m);
      if (msg.op === 'subscribe') {
        types = msg.types?.length ? new Set(msg.types) : null;
        pools = msg.pools?.length ? new Set(msg.pools) : null;
        sock.send(JSON.stringify({ type: 'subscribed', types: types ? [...types] : 'all', pools: pools ? [...pools] : 'all' }));
      }
    } catch { /* ignore */ }
  });
  bus.on('event', onEvent);
  sock.on('close', () => bus.off('event', onEvent));
  sock.send(JSON.stringify({ type: 'hello', eventTypes: EVENT_TYPES }));
});

export default app;

// En local / sur un hôte classique : serveur HTTP + WebSocket + ingestion continue.
// Sur Vercel : seul `app` est exporté (api/index.js), le WebSocket n'est pas disponible.
if (!config.serverless) {
  server.listen(config.port, () => {
    console.log(`\n☄️  DBC Flow → http://localhost:${config.port}`);
    console.log(`   Helius: ${config.heliusApiKey ? 'OK' : 'ABSENTE (HELIUS_API_KEY)'} · budget ${config.rps} req/s`);
    startEngine().catch((e) => { console.error('[engine] démarrage KO', e); process.exit(1); });
  });
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { console.log('\n[shutdown] snapshot…'); snapshot(); process.exit(0); });
  }
}
