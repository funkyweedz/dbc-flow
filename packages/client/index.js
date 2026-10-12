// dbc-flow-client — zero-dependency client for DBC Flow (browser + Node ≥ 18).
// SSE is parsed over fetch() streams so it works where EventSource is missing (Node).

const DEFAULT_URL = 'http://localhost:4100';

export class DbcFlow {
  /** @param {{ baseUrl?: string, fetch?: typeof fetch }} [opts] */
  constructor(opts = {}) {
    this.baseUrl = (opts.baseUrl || DEFAULT_URL).replace(/\/$/, '');
    this._fetch = opts.fetch || globalThis.fetch.bind(globalThis);
  }

  // ---------- REST ----------
  async _get(path, query) {
    const qs = query ? '?' + new URLSearchParams(Object.entries(query).filter(([, v]) => v != null && v !== '').map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : String(v)])) : '';
    const r = await this._fetch(this.baseUrl + path + qs);
    if (!r.ok) throw new Error(`DBC Flow ${path} → HTTP ${r.status}`);
    return r.json();
  }
  /** Pools leaderboard. sort: progress | volume5m | volume1h | new | mcap | eta | netflow5m | recent */
  pools(q = {}) { return this._get('/api/pools', q).then((r) => r.pools); }
  /** Pools close to graduation (bonding, progress ≥ minProgress). */
  nearGraduation(minProgress = 80, limit = 20) { return this.pools({ status: 'bonding', sort: 'progress', minProgress, limit }); }
  /** One pool with progress history + recent events. */
  pool(address) { return this._get(`/api/pools/${address}`); }
  /** Launchpads (DBC configs) leaderboard. sort: volumeUsd | created | graduated | trades | pools | feesUsd */
  launchpads(q = {}) { return this._get('/api/launchpads', q).then((r) => r.launchpads); }
  traders(q = {}) { return this._get('/api/traders', q).then((r) => r.traders); }
  /** Sampled liquidity curve of a DBC config (price vs. quote raised). */
  curve(config) { return this._get(`/api/curve/${config}`); }
  events(q = {}) { return this._get('/api/events', q).then((r) => r.events); }
  stats() { return this._get('/api/stats'); }

  // ---------- Streaming ----------
  /**
   * Async iterator over live events. Auto-reconnects and resumes with Last-Event-ID.
   * @param {{ types?: string[], pools?: string[], signal?: AbortSignal }} [opts]
   */
  async *stream(opts = {}) {
    let lastId = 0;
    let backoff = 500;
    while (!opts.signal?.aborted) {
      try {
        const qs = new URLSearchParams({ stats: 'false' });
        if (opts.types?.length) qs.set('types', opts.types.join(','));
        if (opts.pools?.length) qs.set('pool', opts.pools.join(','));
        const res = await this._fetch(`${this.baseUrl}/api/stream?${qs}`, {
          headers: { accept: 'text/event-stream', ...(lastId ? { 'last-event-id': String(lastId) } : {}) },
          signal: opts.signal,
        });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        backoff = 500;
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i); buf = buf.slice(i + 2);
            let data = '', id = null;
            for (const line of block.split('\n')) {
              if (line.startsWith('data:')) data += line.slice(5).trim();
              else if (line.startsWith('id:')) id = Number(line.slice(3).trim());
            }
            if (!data) continue;
            if (id) lastId = id;
            yield JSON.parse(data);
          }
        }
      } catch (e) {
        if (opts.signal?.aborted) return;
      }
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 10_000);
    }
  }

  /**
   * Callback-style subscription. Returns an unsubscribe function.
   * type: 'swap' | 'pool_created' | 'near_graduation' | 'graduated' | 'migrated' | 'whale' | 'sniper' | '*'
   */
  on(type, cb, { pools } = {}) {
    const ctrl = new AbortController();
    (async () => {
      for await (const ev of this.stream({ types: type === '*' ? undefined : [type], pools, signal: ctrl.signal })) cb(ev);
    })();
    return () => ctrl.abort();
  }
}

export default DbcFlow;
