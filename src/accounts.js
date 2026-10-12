// Cache des comptes on-chain (VirtualPool, PoolConfig) et des métadonnées de tokens (DAS).
// Tout est récupéré en batch pour économiser le budget RPC.
import { coder } from './decoder.js';
import { rpc } from './rpc.js';
import { KNOWN_QUOTES, WSOL } from './config.js';

export const pools = new Map();   // pool -> { config, creator, mint, ... }
export const configs = new Map(); // config -> { quoteMint, baseDecimals, threshold, ... }
export const tokens = new Map();  // mint -> { symbol, name, image, decimals, supply }
export const prices = { [WSOL]: 0 };

const pending = { pools: new Set(), configs: new Set(), tokens: new Set() };
const waiters = new Map(); // clé -> [resolve]

function wait(key) {
  return new Promise((resolve) => {
    if (!waiters.has(key)) waiters.set(key, []);
    waiters.get(key).push(resolve);
  });
}
function wake(key, v) {
  const w = waiters.get(key);
  if (w) { waiters.delete(key); w.forEach((r) => r(v)); }
}

const n = (bn) => (bn == null ? 0 : Number(bn.toString()));

function decodeAccount(name, b64) {
  try { return coder.accounts.decode(name, Buffer.from(b64, 'base64')); } catch { return null; }
}

export function ensurePool(addr) {
  if (pools.has(addr)) return Promise.resolve(pools.get(addr));
  pending.pools.add(addr);
  return wait('p:' + addr);
}
export function ensureConfig(addr) {
  if (configs.has(addr)) return Promise.resolve(configs.get(addr));
  pending.configs.add(addr);
  return wait('c:' + addr);
}
export function ensureToken(mint) {
  if (tokens.has(mint)) return Promise.resolve(tokens.get(mint));
  if (KNOWN_QUOTES[mint]) {
    const t = { ...KNOWN_QUOTES[mint], name: KNOWN_QUOTES[mint].symbol };
    tokens.set(mint, t);
    return Promise.resolve(t);
  }
  pending.tokens.add(mint);
  return wait('t:' + mint);
}

async function flushAccounts(set, prefix, accountName, map, parse) {
  if (!set.size) return;
  const batch = [...set].slice(0, 100);
  batch.forEach((a) => set.delete(a));
  let res;
  try {
    res = await rpc('getMultipleAccounts', [batch, { encoding: 'base64' }]);
  } catch (e) {
    batch.forEach((a) => wake(prefix + a, null));
    return;
  }
  res.value.forEach((acc, i) => {
    const addr = batch[i];
    let v = null;
    try {
      const dec = acc ? decodeAccount(accountName, acc.data[0]) : null;
      v = dec ? parse(dec) : null;
    } catch (e) {
      console.warn(`[accounts] ${accountName} ${addr}: ${e.message}`);
    }
    if (v) map.set(addr, v);
    if (v?.quoteMint) trackQuote(v.quoteMint);
    wake(prefix + addr, v);
  });
}

const BIDI = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/;
const clean = (s) => String(s).replace(new RegExp(BIDI.source, 'g'), '').trim();

// ipfs:// et ar:// → passerelles HTTP (les navigateurs ne les chargent pas).
function imageUrl(u) {
  if (!u || typeof u !== 'string') return null;
  if (u.startsWith('ipfs://')) return 'https://ipfs.io/ipfs/' + u.slice(7).replace(/^ipfs\//, '');
  if (u.startsWith('ar://')) return 'https://arweave.net/' + u.slice(5);
  return /^https?:\/\//.test(u) ? u : null;
}

async function flushTokens() {
  if (!pending.tokens.size) return;
  const batch = [...pending.tokens].slice(0, 100);
  batch.forEach((a) => pending.tokens.delete(a));
  let assets = [];
  try {
    assets = await rpc('getAssetBatch', { ids: batch });
  } catch { /* ignoré : fallback sur l'adresse */ }
  batch.forEach((mint, i) => {
    const a = assets?.[i];
    const ti = a?.token_info ?? {};
    const md = a?.content?.metadata ?? {};
    const rawSym = md.symbol || ti.symbol || '';
    const rawName = md.name || '';
    const t = {
      symbol: clean(rawSym).slice(0, 16) || mint.slice(0, 4),
      name: clean(rawName).slice(0, 48),
      // Caractères bidi / invisibles : technique d'usurpation de ticker (ex. U+202E "RTL override").
      spoof: BIDI.test(rawSym + rawName),
      image: imageUrl(a?.content?.files?.[0]?.cdn_uri || a?.content?.links?.image || a?.content?.files?.[0]?.uri),
      decimals: ti.decimals ?? null,
      supply: ti.supply != null ? Number(ti.supply) : null,
    };
    tokens.set(mint, t);
    wake('t:' + mint, t);
  });
}

// migration_progress : 0 = bonding, 1 = courbe terminée, 2 = vesting verrouillé, 3 = pool DAMM créé
const parsePool = ({ pool_state: p }) => ({
  config: p.config.toBase58(),
  creator: p.creator.toBase58(),
  mint: p.base_mint.toBase58(),
  isMigrated: Number(p.is_migrated) === 1,
  migrationProgress: Number(p.migration_progress),
  quoteReserveRaw: BigInt(p.quote_reserve.toString()),
  sqrtPrice: BigInt(p.sqrt_price.toString()),
  activationPoint: n(p.activation_point),
});

const parseConfig = (c) => ({
  quoteMint: c.quote_mint.toBase58(),
  feeClaimer: c.fee_claimer.toBase58(),
  baseDecimals: Number(c.token_decimal),
  thresholdRaw: BigInt(c.migration_quote_threshold.toString()),
  collectFeeMode: Number(c.collect_fee_mode),
  migrationOption: Number(c.migration_option), // 0 = DAMM v1, 1 = DAMM v2
  activationType: Number(c.activation_type),  // 0 = slot, 1 = timestamp
  creatorFeePct: Number(c.creator_trading_fee_percentage),
  migrationFeePct: Number(c.migration_fee_percentage),
  supplyPreMigration: c.pre_migration_token_supply ? BigInt(c.pre_migration_token_supply.toString()) : 0n,
  sqrtStartPrice: BigInt(c.sqrt_start_price.toString()),
  migrationSqrtPrice: BigInt(c.migration_sqrt_price.toString()),
  curve: (c.curve ?? [])
    .map((pt) => ({ sqrtPrice: pt.sqrt_price.toString(), liquidity: pt.liquidity.toString() }))
    .filter((pt) => pt.sqrtPrice !== '0'),
  baseFee: {
    cliffFeeNumerator: c.pool_fees?.base_fee?.cliff_fee_numerator?.toString?.() ?? '0',
    mode: Number(c.pool_fees?.base_fee?.base_fee_mode ?? 0),
  },
  dynamicFee: Number(c.pool_fees?.dynamic_fee?.initialized ?? 0) === 1,
});

// Boucle de flush : regroupe les demandes toutes les 400 ms.
export function startAccountLoop() {
  const tick = async () => {
    try {
      await flushAccounts(pending.configs, 'c:', 'PoolConfig', configs, parseConfig);
      await flushAccounts(pending.pools, 'p:', 'VirtualPool', pools, parsePool);
      await flushTokens();
    } catch (e) {
      console.warn('[accounts]', e.message);
    }
    setTimeout(tick, pending.pools.size || pending.configs.size || pending.tokens.size ? 30 : 150);
  };
  tick();
}

// Prix USD des quote tokens (Jupiter Price v3) : SOL + tout quote "exotique" rencontré.
const quoteMints = new Set([WSOL]);
export function trackQuote(mint) {
  if (!mint || KNOWN_QUOTES[mint]?.usd || quoteMints.has(mint)) return;
  quoteMints.add(mint);
  refreshPrices([mint]);
}
async function refreshPrices(ids) {
  for (let i = 0; i < ids.length; i += 50) {
    try {
      const r = await fetch(`https://lite-api.jup.ag/price/v3?ids=${ids.slice(i, i + 50).join(',')}`);
      const j = await r.json();
      for (const [mint, v] of Object.entries(j ?? {})) if (Number(v?.usdPrice) > 0) prices[mint] = Number(v.usdPrice);
    } catch { /* on garde les dernières valeurs */ }
  }
}
export async function startPriceLoop() {
  await refreshPrices([...quoteMints]);
  setInterval(() => refreshPrices([...quoteMints]), 60_000);
}

export function quoteUsd(mint) {
  if (KNOWN_QUOTES[mint]?.usd) return KNOWN_QUOTES[mint].usd;
  return prices[mint] ?? 0;
}
