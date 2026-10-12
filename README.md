# ☄️ DBC Flow

**Real-time data streams & developer tooling for Meteora's Dynamic Bonding Curve (DBC).**

DBC Flow indexes every DBC transaction on Solana mainnet, decodes the program's `emit_cpi` events, enriches them and serves them as plug-and-play streams for launchpads, trading terminals, bots and AI agents.

**🔴 Live: https://dbc-flow.vercel.app** · API docs: https://dbc-flow.vercel.app/docs · 🎬 Demo: https://dbc-flow.vercel.app/demo

> Built for the Superteam Earn bounty *“Best use of Meteora's Dynamic Bonding Curve”*, track **Data Streams or Developer Tooling for trading terminals and builders**.

- **Live dashboard**: graduation radar, live tape, lifecycle feed, launchpad leaderboard, most active wallets, per-pool drawer with a **Curve Explorer**.
- **SSE + WebSocket + REST API**: filter by event type or pool, with gap-free reconnects (`Last-Event-ID`).
- **`dbc-flow-client`**: a zero-dependency TypeScript client for browsers and Node.
- **`dbc-flow-mcp`**: an MCP server that lets Claude, Cursor or any agent query live DBC launches.
- **Examples**: Discord/Telegram graduation and whale alerts in about 40 lines.

## What you get that isn't directly on-chain

| Signal | How |
|---|---|
| Bonding progress on every trade | `EvtSwap2.quote_reserve_amount / migration_threshold` |
| **Graduation ETA** | linear regression of progress over the last 10 minutes |
| Lifecycle stream | `pool_created → near_graduation → graduated (EvtCurveComplete) → migrated (migration_damm_v2 → DAMM v2 pool address)` |
| Flow | 5m / 1h volume, net buy flow, unique traders, price change |
| **Sniper / whale / dev** flags | buys within `SNIPER_WINDOW_SEC` of launch · buys ≥ `WHALE_USD` · signer == pool creator |
| **Launchpad analytics** | every DBC config aggregated: launches, graduations, volume, fees |
| **Curve Explorer** | a config's liquidity curve sampled with the official SDK math (`getDeltaAmountBase/QuoteUnsigned`) |
| **Ticker spoof detection** | symbols using bidi or zero-width characters (e.g. U+202E RTL override) are cleaned and flagged |
| USD pricing | SOL, USDC/USDT and any exotic quote token, via the Jupiter Price API |

## Architecture

```
                         ┌───────────────────────────── DBC Flow ───────────────────────────────┐
 Solana mainnet          │                                                                      │
 DBC program  ──Helius──▶│ ingest ──▶ decoder ──▶ enrich ──▶ aggregate ──▶ bus ──▶ SSE / WS / REST │──▶ dashboard
 dbcij3LW…aqN            │ (batch | single)  (Anchor   (pools,      (pools, launchpads,           │──▶ dbc-flow-client
                         │                    CPI      configs,     traders, ETA, flags)          │──▶ dbc-flow-mcp (agents)
                         │                    events)  DAS, prices)                               │──▶ your bot
                         └──────────────────────────────────────────────────────────────────────┘
```

- **Ingestion**
  - `INGEST_MODE=batch` (default) uses Helius `getTransactionsForAddress`: up to 100 full transactions per call (about 10 credits), ordered by slot, with pagination when traffic bursts. Coverage is about **100 %** at ~1 req/2 s.
  - `INGEST_MODE=single` works with any RPC: `logsSubscribe` + `getTransaction` with a token-bucket limiter, adaptive 429 backoff and a **priority queue**. Launches and migrations are never dropped; swaps are shed under load, and the shed rate is reported as `coveragePct`.
- **Decoding**: DBC emits events through `emit_cpi!`, i.e. self-CPI inner instructions prefixed by `EVENT_IX_TAG` (`e445a52e51cb9a1d`). We decode them with the IDL shipped in `@meteora-ag/dynamic-bonding-curve-sdk`. Migrations are detected from the `migration_damm_v2` / `migrate_meteora_damm` instructions, which also gives us the DAMM v2 pool address.
- **Enrichment**: `VirtualPool` and `PoolConfig` accounts are batched with `getMultipleAccounts`, token metadata with DAS `getAssetBatch`, and USD prices come from Jupiter. Everything is cached.
- **State**: in-memory with TTL GC, snapshotted to disk every 30 s and on shutdown. On restart it resumes ingestion from the last slot.

## Quick start

```bash
npm install
echo "HELIUS_API_KEY=your-key" > .env
npm start                      # → http://localhost:4100
node examples/quickstart.js    # near-graduation table + live swaps
```

### Stream from anywhere

```js
// Browser
const es = new EventSource('https://<host>/api/stream?types=graduated,migrated,whale');
es.addEventListener('migrated', (m) => console.log(JSON.parse(m.data).dammPool));

// Node / TS
import { DbcFlow } from 'dbc-flow-client';
const flow = new DbcFlow({ baseUrl: 'https://<host>' });
for await (const ev of flow.stream({ types: ['near_graduation'] })) console.log(ev.symbol, ev.progress, ev.etaSec);
```

### MCP (AI agents)

```bash
cd packages/mcp && npm install
claude mcp add dbc-flow -e DBC_FLOW_URL=https://<host> -- node /abs/path/packages/mcp/index.js
```

The server exposes these tools: `dbc_near_graduation`, `dbc_hot_pools`, `dbc_pool`, `dbc_launchpads`, `dbc_curve`, `dbc_recent_events`.

## API

| Endpoint | |
|---|---|
| `GET /api/stream?types=&pool=` | SSE. Types: `swap`, `pool_created`, `near_graduation`, `graduated`, `migrated` (+ the `whale` and `sniper` filters) |
| `WS /ws` | send `{"op":"subscribe","types":[…],"pools":[…]}` |
| `GET /api/pools` | `sort=progress\|volume5m\|volume1h\|new\|mcap\|eta\|netflow5m\|recent`, `status`, `minProgress`, `quote`, `config`, `limit` |
| `GET /api/pools/:pool` | stats, progress history, latest events |
| `GET /api/launchpads` | DBC config leaderboard |
| `GET /api/curve/:config` | sampled curve + fee/migration parameters |
| `GET /api/traders` | most active wallets |
| `GET /api/events` | replay buffer (`types`, `pool`, `since`, `limit`) |
| `GET /api/stats`, `/health` | indexer health: tx/min, coverage, RPC usage |

Full docs: `/docs` on any running instance.

## Configuration (`.env`)

| Var | Default | |
|---|---|---|
| `HELIUS_API_KEY` | — | required for the default RPC/WS URLs |
| `RPC_URL`, `WS_URL` | Helius mainnet | override with any RPC (use `INGEST_MODE=single` outside Helius) |
| `INGEST_MODE` | `batch` | `batch` or `single` |
| `POLL_MS` | `2000` | batch polling interval |
| `RPC_RPS` | `8` | RPC budget (req/s) |
| `WHALE_USD` | `1000` | whale buy threshold |
| `SNIPER_WINDOW_SEC` | `15` | sniper window after `EvtInitializePool` |
| `NEAR_GRAD_PCT` | `80` | `near_graduation` trigger |
| `POOL_TTL_MIN` | `240` | forget pools inactive for this long |
| `PORT` | `4100` | |

## Deploy

- **Vercel**, which hosts the live demo: `vercel deploy --prod` with `HELIUS_API_KEY` set.
  - The app runs in *serverless mode*: ingestion runs while the function instance is alive (open dashboards and SSE streams keep it warm).
  - Every API call first catches up from the last indexed slot. A cold start replays the last ~800 transactions in about 3 s.
  - SSE streams are recycled every 270 s and resume losslessly via `Last-Event-ID`. WebSocket `/ws` is not available on Vercel.
- **Long-running hosts** (Render, Railway, Fly, a VPS): `Dockerfile` and `render.yaml` are included. This mode gives continuous ingestion and adds the WebSocket endpoint.

## License

MIT
