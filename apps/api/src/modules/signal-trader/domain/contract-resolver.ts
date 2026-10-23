import { parseMasterExpiry, parseMasterStrike } from '../../market-data/services/master-contract';
import { tickRupees } from '../../sentinel-executor/domain/exit-order';
import type { SignalView } from './signal.types';

/** A live, tradable contract from the instrument master. */
export interface ResolvedContract {
  exchange: string;
  token: string;
  tradingsymbol: string;
  lotSize: number;
  /** ₹ */
  tickSize: number;
  /** YYYY-MM-DD or null (cash). */
  expiry: string | null;
}

export type ResolveResult = { ok: true; contract: ResolvedContract } | { ok: false; reason: string };

const MCX_UNDERLYINGS = new Set(['CRUDEOIL', 'CRUDEOILM', 'NATURALGAS', 'NATGASMINI', 'GOLD', 'GOLDM', 'SILVER', 'SILVERM', 'COPPER', 'ZINC', 'ALUMINIUM', 'LEAD', 'NICKEL']);
const BFO_UNDERLYINGS = new Set(['SENSEX', 'BANKEX']);

type Row = Record<string, unknown>;
const up = (v: unknown) => String(v ?? '').trim().toUpperCase();

function ymdLocal(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Which master segment the signal's contract lives on. */
export function segmentFor(s: Pick<SignalView, 'underlying' | 'instrumentKind'>): string {
  const u = up(s.underlying);
  if (s.instrumentKind === 'EQ') return 'NSE';
  if (MCX_UNDERLYINGS.has(u)) return 'MCX';
  if (BFO_UNDERLYINGS.has(u)) return 'BFO';
  return 'NFO';
}

/**
 * Signal → the ONE live contract it names, from raw Angel scrip-master rows. Pure.
 * Options need strike + CE/PE; the expiry is the signal's own when stated, else the nearest live one.
 * Ambiguity (two contracts left) refuses rather than guesses.
 */
export function resolveContract(master: readonly unknown[], s: SignalView, today: Date): ResolveResult {
  const seg = segmentFor(s);
  const name = up(s.underlying);
  const rows = (master as Row[]).filter((r) => r && up(r.exch_seg) === seg);
  if (rows.length === 0) return { ok: false, reason: `instrument master has no ${seg} rows` };

  if (s.instrumentKind === 'EQ') {
    const want = `${name}-EQ`;
    const hit = rows.find((r) => up(r.symbol) === want) ?? rows.find((r) => up(r.symbol) === name && up(r.name) === name);
    if (!hit) return { ok: false, reason: `no NSE cash contract for ${name}` };
    return { ok: true, contract: toContract(hit, seg, null) };
  }

  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const live = rows
    .filter((r) => up(r.name) === name)
    .map((r) => ({ r, expiry: parseMasterExpiry(r.expiry) }))
    .filter((x): x is { r: Row; expiry: Date } => x.expiry !== null && x.expiry >= startOfToday);

  let candidates: Array<{ r: Row; expiry: Date }>;
  if (s.instrumentKind === 'FUT') {
    candidates = live.filter((x) => /^FUT/.test(up(x.r.instrumenttype)));
  } else {
    if (s.strike === null || !(s.strike > 0)) return { ok: false, reason: 'option signal without a strike' };
    candidates = live.filter(
      (x) =>
        /^OPT/.test(up(x.r.instrumenttype)) &&
        up(x.r.symbol).endsWith(s.instrumentKind) &&
        Math.abs((parseMasterStrike(x.r.strike) ?? -1) - (s.strike as number)) < 1e-6,
    );
  }
  if (candidates.length === 0) return { ok: false, reason: `no live ${s.instrumentKind} contract for ${name}${s.strike ? ` ${s.strike}` : ''}` };

  if (s.expiry) {
    const wanted = candidates.filter((x) => ymdLocal(x.expiry) === s.expiry);
    if (wanted.length === 0) return { ok: false, reason: `no live contract for ${name} on expiry ${s.expiry}` };
    candidates = wanted;
  } else {
    const nearest = Math.min(...candidates.map((x) => x.expiry.getTime()));
    candidates = candidates.filter((x) => x.expiry.getTime() === nearest);
  }
  if (candidates.length !== 1) return { ok: false, reason: `ambiguous: ${candidates.length} contracts match` };
  const c = candidates[0];
  return { ok: true, contract: toContract(c.r, seg, ymdLocal(c.expiry)) };
}

function toContract(r: Row, seg: string, expiry: string | null): ResolvedContract {
  const lot = Number.parseInt(String(r.lotsize ?? ''), 10);
  const tickRaw = Number.parseFloat(String(r.tick_size ?? ''));
  return {
    exchange: seg,
    token: String(r.token ?? ''),
    tradingsymbol: String(r.symbol ?? ''),
    lotSize: Number.isInteger(lot) && lot >= 1 ? lot : 0,
    tickSize: tickRupees(Number.isFinite(tickRaw) ? tickRaw : null, seg),
    expiry,
  };
}
