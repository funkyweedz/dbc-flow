// Échantillonnage de la courbe de liquidité d'une config DBC (pour le Curve Explorer).
// Chaque point de la courbe = (sqrtPrice cible, liquidité) ; on intègre segment par segment
// avec les helpers mathématiques officiels du SDK.
import BN from 'bn.js';
import { getDeltaAmountBaseUnsigned, getDeltaAmountQuoteUnsigned, Rounding } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { ensureConfig, ensureToken } from './accounts.js';
import { KNOWN_QUOTES } from './config.js';

const Q64 = 2 ** 64;
const toNum = (bn, dec) => Number(bn.toString()) / 10 ** dec;
const sqrtToPrice = (s, bd, qd) => { const x = Number(s.toString()) / Q64; return x * x * 10 ** (bd - qd); };

export async function sampleCurve(configAddr, stepsPerSegment = 12) {
  const cfg = await ensureConfig(configAddr);
  if (!cfg) return null;
  const quote = await ensureToken(cfg.quoteMint);
  const bd = cfg.baseDecimals;
  const qd = quote?.decimals ?? KNOWN_QUOTES[cfg.quoteMint]?.decimals ?? 9;

  const points = [];
  let lower = new BN(cfg.sqrtStartPrice.toString());
  const migration = new BN(cfg.migrationSqrtPrice.toString());
  let baseCum = new BN(0);
  let quoteCum = new BN(0);
  points.push({ quote: 0, base: 0, price: sqrtToPrice(lower, bd, qd) });

  for (const seg of cfg.curve) {
    if (lower.gte(migration)) break;
    let upper = new BN(seg.sqrtPrice);
    if (upper.gt(migration)) upper = migration;
    const liq = new BN(seg.liquidity);
    if (liq.isZero() || upper.lte(lower)) { lower = upper; continue; }
    const span = upper.sub(lower);
    let prev = lower;
    for (let i = 1; i <= stepsPerSegment; i++) {
      const s = lower.add(span.muln(i).divn(stepsPerSegment));
      baseCum = baseCum.add(getDeltaAmountBaseUnsigned(prev, s, liq, Rounding.Down));
      quoteCum = quoteCum.add(getDeltaAmountQuoteUnsigned(prev, s, liq, Rounding.Down));
      points.push({ quote: toNum(quoteCum, qd), base: toNum(baseCum, bd), price: sqrtToPrice(s, bd, qd) });
      prev = s;
    }
    lower = upper;
  }
  const threshold = Number(cfg.thresholdRaw) / 10 ** qd;
  return {
    config: configAddr,
    quoteMint: cfg.quoteMint,
    quoteSymbol: quote?.symbol ?? '?',
    baseDecimals: bd,
    threshold,
    migrationTarget: cfg.migrationOption === 1 ? 'DAMM v2' : 'DAMM v1',
    startPrice: sqrtToPrice(new BN(cfg.sqrtStartPrice.toString()), bd, qd),
    migrationPrice: sqrtToPrice(migration, bd, qd),
    segments: cfg.curve.length,
    creatorFeePct: cfg.creatorFeePct,
    migrationFeePct: cfg.migrationFeePct,
    dynamicFee: cfg.dynamicFee,
    baseFee: cfg.baseFee,
    points: points.map((p) => ({ ...p, progress: threshold ? Math.min(100, (p.quote / threshold) * 100) : null })),
  };
}
