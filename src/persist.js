// Snapshot périodique de l'état agrégé (pools, launchpads, traders, events) sur disque,
// pour qu'un redémarrage / redeploy ne remette pas les stats à zéro.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const FILE = process.env.SNAPSHOT_FILE || new URL('../data/snapshot.json', import.meta.url).pathname;

const replacer = (_k, v) => {
  if (v instanceof Set) return { $set: [...v] };
  if (typeof v === 'bigint') return { $big: v.toString() };
  return v;
};
const reviver = (_k, v) => {
  if (v && typeof v === 'object' && Array.isArray(v.$set)) return new Set(v.$set);
  if (v && typeof v === 'object' && typeof v.$big === 'string') return BigInt(v.$big);
  return v;
};

export function save(state) {
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    const tmp = FILE + '.tmp';
    writeFileSync(tmp, JSON.stringify({ savedAt: Date.now(), ...state }, replacer));
    renameSync(tmp, FILE);
  } catch (e) { console.warn('[persist] save KO:', e.message); }
}

export function load() {
  try { return JSON.parse(readFileSync(FILE, 'utf8'), reviver); } catch { return null; }
}
