#!/usr/bin/env node
// dbc-flow-mcp — lets AI agents (Claude, Cursor, …) query live Meteora DBC launch data.
//   claude mcp add dbc-flow -e DBC_FLOW_URL=https://your-dbc-flow.app -- node /path/to/packages/mcp/index.js
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { DbcFlow } from '../client/index.js';

const flow = new DbcFlow({ baseUrl: process.env.DBC_FLOW_URL || 'http://localhost:4100' });
const server = new McpServer({ name: 'dbc-flow', version: '0.1.0' });

const slimPool = (p) => ({
  pool: p.pool, mint: p.mint, symbol: p.symbol, quote: p.quoteSymbol, status: p.status,
  progressPct: p.progress, graduationEtaSec: p.etaSec, mcapUsd: p.mcapUsd, volume5mUsd: p.m5?.volumeUsd,
  netFlow5mUsd: p.m5?.netFlowUsd, traders: p.traders, snipers: p.snipers, whaleBuys: p.whaleBuys,
  devSells: p.devSells, spoofedTicker: p.spoofedTicker, launchpadConfig: p.config, dammPool: p.dammPool,
});
const json = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });

server.registerTool('dbc_near_graduation', {
  title: 'Pools close to graduation',
  description: 'Meteora DBC pools still on their bonding curve, sorted by progress toward the migration threshold, with a graduation ETA estimated from recent velocity.',
  inputSchema: { minProgress: z.number().min(0).max(100).default(70), limit: z.number().int().min(1).max(50).default(10) },
}, async ({ minProgress, limit }) => json((await flow.nearGraduation(minProgress, limit)).map(slimPool)));

server.registerTool('dbc_hot_pools', {
  title: 'Hottest DBC pools',
  description: 'DBC pools ranked by a metric over the last minutes: volume5m, netflow5m, new, mcap, recent.',
  inputSchema: { sort: z.enum(['volume5m', 'volume1h', 'netflow5m', 'new', 'mcap', 'recent']).default('volume5m'), limit: z.number().int().min(1).max(50).default(10) },
}, async ({ sort, limit }) => json((await flow.pools({ sort, limit })).map(slimPool)));

server.registerTool('dbc_pool', {
  title: 'DBC pool details',
  description: 'Full live stats for a DBC pool address: progress, ETA, mcap, flows, snipers, dev activity and its 30 latest events.',
  inputSchema: { pool: z.string().describe('DBC virtual pool address') },
}, async ({ pool }) => {
  const p = await flow.pool(pool);
  return json({ ...slimPool(p), change5m: p.change5m, buys: p.buys, sells: p.sells, events: p.events.slice(-30) });
});

server.registerTool('dbc_launchpads', {
  title: 'Launchpad leaderboard',
  description: 'DBC configs (≈ launchpads) ranked by volume, launches or graduations observed since the indexer started.',
  inputSchema: { sort: z.enum(['volumeUsd', 'created', 'graduated', 'trades', 'feesUsd']).default('volumeUsd'), limit: z.number().int().min(1).max(50).default(10) },
}, async ({ sort, limit }) => json(await flow.launchpads({ sort, limit })));

server.registerTool('dbc_curve', {
  title: 'Explain a DBC curve config',
  description: 'Sampled bonding curve of a DBC config: start/migration price, price multiple, threshold, fee scheduler and points (quote raised → price).',
  inputSchema: { config: z.string(), points: z.number().int().min(5).max(200).default(25) },
}, async ({ config, points }) => {
  const c = await flow.curve(config);
  const step = Math.max(1, Math.floor(c.points.length / points));
  return json({ ...c, priceMultiple: c.migrationPrice / c.startPrice, points: c.points.filter((_, i) => i % step === 0) });
});

server.registerTool('dbc_recent_events', {
  title: 'Recent DBC lifecycle events',
  description: 'Latest events: pool_created, near_graduation, graduated, migrated, or swaps flagged whale / sniper.',
  inputSchema: { types: z.array(z.enum(['swap', 'pool_created', 'near_graduation', 'graduated', 'migrated', 'whale', 'sniper'])).default(['pool_created', 'graduated', 'migrated']), limit: z.number().int().min(1).max(200).default(30) },
}, async ({ types, limit }) => json(await flow.events({ types, limit })));

await server.connect(new StdioServerTransport());
