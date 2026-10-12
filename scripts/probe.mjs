import 'dotenv/config';
import WebSocket from 'ws';
import bs58 from 'bs58';
import anchor from '@coral-xyz/anchor';
import { DynamicBondingCurveIdl } from '@meteora-ag/dynamic-bonding-curve-sdk';
const { BorshCoder } = anchor;
const KEY = process.env.HELIUS_API_KEY;
const PID = 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN';
const coder = new BorshCoder(DynamicBondingCurveIdl);
const TAG = Buffer.from('e445a52e51cb9a1d', 'hex');
const ws = new WebSocket(`wss://mainnet.helius-rpc.com/?api-key=${KEY}`);
let n = 0, t0 = Date.now(); const sigs = [];
ws.on('open', () => ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'logsSubscribe', params: [{ mentions: [PID] }, { commitment: 'confirmed' }] })));
ws.on('message', async (m) => {
  const j = JSON.parse(m); const v = j.params?.result?.value; if (!v) return;
  if (v.err) return; n++;
  const ixs = v.logs.filter(l => l.startsWith('Program log: Instruction:')).map(l=>l.slice(26));
  if (sigs.length < 6) { sigs.push(v.signature); console.log(v.signature.slice(0,10), ixs.join(',')); }
});
setTimeout(async () => {
  console.log(`\n${n} tx ok en ${(Date.now()-t0)/1000}s`);
  for (const s of sigs) {
    const r = await (await fetch(`https://mainnet.helius-rpc.com/?api-key=${KEY}`, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({jsonrpc:'2.0',id:1,method:'getTransaction',params:[s,{encoding:'json',maxSupportedTransactionVersion:0,commitment:'confirmed'}]})})).json();
    const tx = r.result; if (!tx) { console.log('no tx'); continue; }
    const keys = [...tx.transaction.message.accountKeys, ...(tx.meta.loadedAddresses?.writable||[]), ...(tx.meta.loadedAddresses?.readonly||[])];
    for (const inner of tx.meta.innerInstructions || []) for (const ix of inner.instructions) {
      if (keys[ix.programIdIndex] !== PID) continue;
      const d = Buffer.from(bs58.decode(ix.data)); if (!d.subarray(0,8).equals(TAG)) continue;
      const ev = coder.events.decode(d.subarray(8).toString('base64'));
      console.log(ev?.name, JSON.stringify(ev?.data, (k,v)=> v?.constructor?.name==='BN'||v?._bn ? v.toString(): v).slice(0,600));
    }
  }
  process.exit(0);
}, 15000);
