export type EventType = 'swap' | 'pool_created' | 'near_graduation' | 'graduated' | 'migrated';
export type Flag = 'whale' | 'sniper' | 'dev';

interface BaseEvent {
  id: number; type: EventType; sig: string; slot: number; ts: number;
  pool: string; config: string; mint?: string; symbol?: string; name?: string; image?: string; quoteSymbol?: string;
}
export interface SwapEvent extends BaseEvent {
  type: 'swap'; side: 'buy' | 'sell'; trader: string; baseAmount: number; quoteAmount: number; usd: number;
  priceQuote: number; priceUsd: number; mcapUsd: number | null; progress: number | null; flags: Flag[];
}
export interface PoolCreatedEvent extends BaseEvent { type: 'pool_created'; creator: string; migrationTarget?: string }
export interface NearGraduationEvent extends BaseEvent { type: 'near_graduation'; progress: number; etaSec: number | null; mcapUsd: number | null }
export interface GraduatedEvent extends BaseEvent { type: 'graduated'; quoteReserve: number; mcapUsd: number | null; timeToGraduateSec: number | null }
export interface MigratedEvent extends BaseEvent { type: 'migrated'; dammPool: string; target: 'DAMM v2' | 'DAMM v1' }
export type DbcEvent = SwapEvent | PoolCreatedEvent | NearGraduationEvent | GraduatedEvent | MigratedEvent;

export interface Window { volumeUsd: number; buys: number; sells: number; netFlowUsd: number; traders: number }
export interface Pool {
  pool: string; mint: string; symbol?: string; name?: string; image?: string; config: string; creator?: string;
  quoteSymbol?: string; status: 'bonding' | 'graduated' | 'migrated'; migrationTarget?: string; dammPool: string | null;
  progress: number | null; etaSec: number | null; priceUsd: number | null; priceQuote: number | null; mcapUsd: number | null;
  reserve: number | null; threshold: number | null; change5m: number | null; change1h: number | null;
  m5: Window; h1: Window; volumeUsdTotal: number; feesUsd: number; buys: number; sells: number; traders: number;
  snipers: number; whaleBuys: number; devBuys: number; devSells: number;
  createdAt: number | null; firstSeen: number; lastTradeAt: number; graduatedAt: number | null; migratedAt: number | null;
}
export interface Launchpad {
  config: string; feeClaimer: string | null; quoteMint: string | null; pools: number; created: number; graduated: number;
  migrated: number; volumeUsd: number; trades: number; feesUsd: number; migrationTarget: string | null; threshold: number | null; creatorFeePct: number | null;
}
export interface Curve {
  config: string; quoteMint: string; quoteSymbol: string; threshold: number; migrationTarget: string;
  startPrice: number; migrationPrice: number; segments: number;
  points: { quote: number; base: number; price: number; progress: number | null }[];
}

export class DbcFlow {
  constructor(opts?: { baseUrl?: string; fetch?: typeof fetch });
  pools(q?: { sort?: string; status?: string; minProgress?: number; quote?: string; config?: string; limit?: number }): Promise<Pool[]>;
  nearGraduation(minProgress?: number, limit?: number): Promise<Pool[]>;
  pool(address: string): Promise<Pool & { history: { t: number; progress: number; price: number }[]; events: DbcEvent[] }>;
  launchpads(q?: { sort?: string; limit?: number }): Promise<Launchpad[]>;
  traders(q?: { sort?: 'volumeUsd' | 'snipes' | 'buys'; limit?: number }): Promise<any[]>;
  curve(config: string): Promise<Curve>;
  events(q?: { types?: string[]; pool?: string; since?: number; limit?: number }): Promise<DbcEvent[]>;
  stats(): Promise<any>;
  stream(opts?: { types?: (EventType | Flag)[]; pools?: string[]; signal?: AbortSignal }): AsyncGenerator<DbcEvent>;
  on(type: EventType | Flag | '*', cb: (ev: DbcEvent) => void, opts?: { pools?: string[] }): () => void;
}
export default DbcFlow;
