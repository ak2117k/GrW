import { parseMasterExpiry, parseMasterStrike } from '../../market-data/services/master-contract';
import type { InstrumentKind } from './types';
import type { UnderlyingClass } from './vocabulary';

/**
 * The instrument master (raw Angel scrip-master rows) read for two things: the listed expiries of an
 * underlying (expiry inference) and the one contract a parsed signal names (token for the outcome
 * replay; X resolves its own for the order). Pure.
 */

type Row = Record<string, unknown>;
const up = (v: unknown) => String(v ?? '').trim().toUpperCase();
const ymdLocal = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function segmentOf(underlying: string, kind: InstrumentKind, cls: UnderlyingClass | undefined): string {
  if (kind === 'EQ') return 'NSE';
  if (cls === 'COMMODITY') return 'MCX';
  if (underlying === 'SENSEX' || underlying === 'BANKEX') return 'BFO';
  return 'NFO';
}

const typeMatches = (r: Row, kind: InstrumentKind) =>
  kind === 'FUT' ? /^FUT/.test(up(r.instrumenttype)) : /^OPT/.test(up(r.instrumenttype)) && up(r.symbol).endsWith(kind);

/** Listed expiries (YYYY-MM-DD, ascending, unique) of the underlying's futures or options on `seg`. */
export function listedExpiries(master: readonly unknown[], underlying: string, kind: InstrumentKind, seg: string): string[] {
  if (kind === 'EQ') return [];
  const out = new Set<string>();
  for (const r of master as Row[]) {
    if (!r || up(r.exch_seg) !== seg || up(r.name) !== underlying || !typeMatches(r, kind)) continue;
    const e = parseMasterExpiry(r.expiry);
    if (e) out.add(ymdLocal(e));
  }
  return [...out].sort();
}

export interface SignalContract {
  exchange: string;
  token: string;
  tradingsymbol: string;
}

/** The one contract the signal names; null when absent or ambiguous. */
export function findContract(
  master: readonly unknown[],
  s: { underlying: string; instrumentKind: InstrumentKind; strike: number | null; expiry: string | null },
  seg: string,
): SignalContract | null {
  const rows = (master as Row[]).filter((r) => r && up(r.exch_seg) === seg);
  if (s.instrumentKind === 'EQ') {
    const hit = rows.find((r) => up(r.symbol) === `${s.underlying}-EQ`) ?? rows.find((r) => up(r.symbol) === s.underlying);
    return hit ? { exchange: seg, token: String(hit.token ?? ''), tradingsymbol: String(hit.symbol ?? '') } : null;
  }
  if (!s.expiry) return null;
  const hits = rows.filter((r) => {
    if (up(r.name) !== s.underlying || !typeMatches(r, s.instrumentKind)) return false;
    const e = parseMasterExpiry(r.expiry);
    if (!e || ymdLocal(e) !== s.expiry) return false;
    if (s.instrumentKind === 'FUT') return true;
    return s.strike !== null && Math.abs((parseMasterStrike(r.strike) ?? -1) - s.strike) < 1e-6;
  });
  if (hits.length !== 1) return null;
  return { exchange: seg, token: String(hits[0].token ?? ''), tradingsymbol: String(hits[0].symbol ?? '') };
}
