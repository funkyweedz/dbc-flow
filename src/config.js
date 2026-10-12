import 'dotenv/config';

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

export const config = {
  heliusApiKey: process.env.HELIUS_API_KEY || '',
  rpcUrl: process.env.RPC_URL || `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`,
  wsUrl: process.env.WS_URL || `wss://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`,
  port: num(process.env.PORT, 4100),
  // Budget RPC (req/s) consacré au fetch des transactions. Plan gratuit Helius ≈ 10.
  rps: num(process.env.RPC_RPS, 8),
  // Au-delà, on jette les swaps les plus anciens (les events prioritaires sont gardés).
  maxQueue: num(process.env.MAX_QUEUE, 400),
  // Un achat ≥ ce montant (USD) est un "whale buy".
  whaleUsd: num(process.env.WHALE_USD, 1000),
  // Achat dans les X secondes après la création du pool = "sniper".
  sniperWindowSec: num(process.env.SNIPER_WINDOW_SEC, 15),
  // Seuil de progression pour l'alerte "near graduation".
  nearGradPct: num(process.env.NEAR_GRAD_PCT, 80),
  // Taille du buffer d'events gardés en mémoire (replay pour les nouveaux clients).
  eventBuffer: num(process.env.EVENT_BUFFER, 2000),
  // Pools inactifs depuis X minutes oubliés (sauf gradués récents).
  poolTtlMin: num(process.env.POOL_TTL_MIN, 240),
  backfill: num(process.env.BACKFILL, 60),
  // 'batch' (Helius getTransactionsForAddress, 100 tx/appel, couverture ~100%)
  // ou 'single' (logsSubscribe + getTransaction, RPC standard, couverture limitée par le budget).
  ingestMode: process.env.INGEST_MODE || 'batch',
  pollMs: num(process.env.POLL_MS, 2000),
  // Serverless (Vercel) : pas de process permanent → ingestion à la demande + rattrapage.
  serverless: !!process.env.VERCEL || process.env.SERVERLESS === 'true',
  // Pages de 100 tx chargées au démarrage à froid (historique initial).
  warmPages: num(process.env.WARM_PAGES, 8),
};

export const DBC_PROGRAM_ID = 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN';
export const DAMM_V2_PROGRAM_ID = 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG';
export const WSOL = 'So11111111111111111111111111111111111111112';
export const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDT = 'Es9vMFrzaCERmJfrF5H2HxWJmmcf7DMqXH5jvJcbGZeF';

// Quote tokens connus (évite un appel DAS).
export const KNOWN_QUOTES = {
  [WSOL]: { symbol: 'SOL', decimals: 9 },
  [USDC]: { symbol: 'USDC', decimals: 6, usd: 1 },
  [USDT]: { symbol: 'USDT', decimals: 6, usd: 1 },
};
