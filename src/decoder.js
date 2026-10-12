// Décodage d'une transaction DBC → events normalisés.
// Le program DBC émet ses events via emit_cpi! : ils vivent dans les inner
// instructions (self-CPI) préfixées par EVENT_IX_TAG, et non dans les logs.
import anchor from '@coral-xyz/anchor';
import bs58 from 'bs58';
import { DynamicBondingCurveIdl } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { DBC_PROGRAM_ID } from './config.js';

const { BorshCoder } = anchor;
export const coder = new BorshCoder(DynamicBondingCurveIdl);
const EVENT_IX_TAG = Buffer.from('e445a52e51cb9a1d', 'hex');

const MIGRATION_IX = new Set(['migration_damm_v2', 'migrate_meteora_damm']);
const toBig = (bn) => BigInt(bn.toString());

function allKeys(tx) {
  const la = tx.meta?.loadedAddresses ?? {};
  return [...tx.transaction.message.accountKeys, ...(la.writable ?? []), ...(la.readonly ?? [])];
}

function decodeEvent(data58) {
  const d = Buffer.from(bs58.decode(data58));
  if (d.length < 16 || !d.subarray(0, 8).equals(EVENT_IX_TAG)) return null;
  try { return coder.events.decode(d.subarray(8).toString('base64')); } catch { return null; }
}

function decodeIx(data58) {
  try { return coder.instruction.decode(data58, 'base58'); } catch { return null; }
}

/**
 * @returns {Array<object>} events bruts normalisés (montants en BigInt, non enrichis)
 */
export function decodeTransaction(tx, signature) {
  const keys = allKeys(tx);
  const base = {
    sig: signature,
    slot: tx.slot,
    ts: tx.blockTime ? tx.blockTime * 1000 : Date.now(),
    signer: keys[0],
  };
  const out = [];
  const swaps2 = [];
  const swaps1 = [];

  // 1) Instructions top-level + inner : on y cherche les migrations (DAMM v2 / v1).
  const topIxs = tx.transaction.message.instructions.map((ix) => ({ ix, inner: false }));
  const innerIxs = (tx.meta?.innerInstructions ?? []).flatMap((g) => g.instructions.map((ix) => ({ ix, inner: true })));
  for (const { ix } of [...topIxs, ...innerIxs]) {
    if (keys[ix.programIdIndex] !== DBC_PROGRAM_ID) continue;
    const ev = decodeEvent(ix.data);
    if (ev) {
      const d = ev.data;
      switch (ev.name) {
        case 'EvtSwap2':
        case 'EvtSwap2WithTransferHook': swaps2.push(d); break;
        case 'EvtSwap': swaps1.push(d); break;
        case 'EvtInitializePool':
        case 'EvtInitializePoolWithTransferHook':
          out.push({ ...base, type: 'pool_created', pool: d.pool.toBase58(), config: d.config.toBase58(),
            creator: d.creator.toBase58(), mint: d.base_mint.toBase58(), activationPoint: d.activation_point.toString() });
          break;
        case 'EvtCurveComplete':
        case 'EvtCurveCompleteWithTransferHook':
          out.push({ ...base, type: 'graduated', pool: d.pool.toBase58(), config: d.config.toBase58(),
            baseReserve: toBig(d.base_reserve), quoteReserve: toBig(d.quote_reserve) });
          break;
        case 'EvtCreateConfig':
          out.push({ ...base, type: 'config_created', config: d.config.toBase58(), quoteMint: d.quote_mint?.toBase58?.(), feeClaimer: d.fee_claimer?.toBase58?.() });
          break;
        default: break;
      }
      continue;
    }
    const dec = decodeIx(ix.data);
    if (dec && MIGRATION_IX.has(dec.name)) {
      const acc = ix.accounts.map((i) => keys[i]);
      // migration_damm_v2 : [virtual_pool, migration_metadata, config, pool_authority, pool(DAMM v2), …, base_mint(13), quote_mint(14)]
      out.push({ ...base, type: 'migrated', pool: acc[0], config: acc[2], dammPool: acc[4],
        target: dec.name === 'migration_damm_v2' ? 'DAMM v2' : 'DAMM v1' });
    }
  }

  // 2) Swaps : un swap émet EvtSwap ET EvtSwap2 ; on préfère Swap2 (contient la progression).
  const useV2 = swaps2.length > 0;
  for (const d of useV2 ? swaps2 : swaps1) {
    const isBuy = Number(d.trade_direction) === 1; // 1 = QuoteToBase
    const r = d.swap_result;
    const input = toBig(useV2 ? r.included_fee_input_amount : r.actual_input_amount);
    const output = toBig(r.output_amount);
    out.push({
      ...base,
      type: 'swap',
      pool: d.pool.toBase58(),
      config: d.config.toBase58(),
      side: isBuy ? 'buy' : 'sell',
      baseRaw: isBuy ? output : input,
      quoteRaw: isBuy ? input : output,
      sqrtPrice: toBig(r.next_sqrt_price),
      fees: toBig(r.trading_fee) + toBig(r.protocol_fee) + toBig(r.referral_fee),
      quoteReserveRaw: useV2 ? toBig(d.quote_reserve_amount) : null,
      thresholdRaw: useV2 ? toBig(d.migration_threshold) : null,
    });
  }
  return out;
}

// Nom des instructions DBC dans les logs (sert à prioriser la file avant le fetch).
export function ixNamesFromLogs(logs) {
  const names = [];
  for (const l of logs) if (l.startsWith('Program log: Instruction: ')) names.push(l.slice(26));
  return names;
}
