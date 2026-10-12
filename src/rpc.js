// Client JSON-RPC avec limiteur de débit (token bucket) + backoff adaptatif sur 429.
import { config } from './config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let tokens = config.rps;
let rate = config.rps; // ajusté dynamiquement
let last = Date.now();
export const rpcStats = { calls: 0, rateLimited: 0, errors: 0 };

function refill() {
  const now = Date.now();
  tokens = Math.min(rate, tokens + ((now - last) / 1000) * rate);
  last = now;
}

async function acquire() {
  for (;;) {
    refill();
    if (tokens >= 1) { tokens -= 1; return; }
    await sleep(Math.ceil(((1 - tokens) / rate) * 1000));
  }
}

export async function rpc(method, params, { attempts = 4 } = {}) {
  for (let i = 0; i < attempts; i++) {
    await acquire();
    rpcStats.calls++;
    let res;
    try {
      res = await fetch(config.rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
    } catch (e) {
      rpcStats.errors++;
      await sleep(500 * (i + 1));
      continue;
    }
    if (res.status === 429) {
      rpcStats.rateLimited++;
      rate = Math.max(1, rate * 0.8); // on ralentit…
      await sleep(400 * (i + 1));
      continue;
    }
    if (!res.ok) { rpcStats.errors++; await sleep(300 * (i + 1)); continue; }
    const json = await res.json();
    if (json.error) throw new Error(`${method}: ${json.error.message}`);
    rate = Math.min(config.rps, rate + 0.05); // …puis on ré-accélère doucement
    return json.result;
  }
  throw new Error(`${method}: échec après ${attempts} tentatives`);
}

export const currentRate = () => rate;
