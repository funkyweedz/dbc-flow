// Quickstart: print the 5 pools closest to graduation, then tail live graduations.
import { DbcFlow } from '../packages/client/index.js';

const flow = new DbcFlow({ baseUrl: process.env.DBC_FLOW_URL || 'http://localhost:4100' });

const near = await flow.nearGraduation(50, 5);
console.table(near.map((p) => ({ token: p.symbol, progress: p.progress?.toFixed(1) + '%', eta: p.etaSec, mcap: Math.round(p.mcapUsd ?? 0), vol5m: Math.round(p.m5.volumeUsd) })));

const lps = await flow.launchpads({ limit: 3 });
console.table(lps.map((l) => ({ config: l.config, pools: l.pools, volume: Math.round(l.volumeUsd), grads: l.graduated })));

let n = 0;
for await (const ev of flow.stream({ types: ['swap'] })) {
  console.log(ev.side.padEnd(4), (ev.symbol ?? '').padEnd(10), ev.usd.toFixed(2).padStart(10), '$', ev.progress?.toFixed(1) + '%');
  if (++n >= 10) break;
}
process.exit(0);
