// The judge packet's MCX option chain, from the hub's own 3-minute OI capture (oi_snapshots). Pure: no I/O.
//
// MCX options are options on FUTURES: a CRUDEOIL option settles to a CRUDEOIL future, not to a spot index.
// The month's options expire a few days BEFORE the same month's future, so the underlying is the earliest
// future expiring on or after the option's expiry (between the two expiries the "nearest future" is the
// wrong month). ATM and the strike window are centred on that future's price.
import { buildChainSnapshot, strikesAround, type CaptureContract, type CaptureQuote, type ChainSnapshotRow } from '../../mbm/domain/chain-snapshot';

/** Strikes kept each side of ATM: the same ±15 the NSE chain capture keeps (CHAIN_STRIKES_AROUND). */
export const MCX_CHAIN_STRIKES_AROUND = 15;
/** Option expiries tried, in order (the traded one, then the nearest live one). */
export const MCX_CHAIN_MAX_EXPIRIES = 2;
/** The newest capture may be this old (the NSE reader's 10-day window). */
export const MCX_CHAIN_LOOKBACK_DAYS = 10;
/** A 1-min close of the future this close to the capture (before it) centres the strikes; else put-call parity. */
export const MCX_FUT_BAR_MAX_LAG_MS = 10 * 60_000;

/**
 * The option expiries to read, in order: the traded contract's own (when it is listed and live), then the
 * nearest live one — except on that expiry's own day, when the next one is used (an expiring chain's OI is
 * being closed out, and the hub also captures the next expiry that day). At most {@link MCX_CHAIN_MAX_EXPIRIES}.
 */
export function mcxExpiryOrder(expiries: readonly string[], today: string, traded?: string | null): string[] {
  const live = [...new Set(expiries)].filter((e) => e >= today).sort();
  const out: string[] = [];
  if (traded && live.includes(traded)) out.push(traded);
  const nearest = live[0] === today && live.length > 1 ? live[1] : live[0];
  if (nearest && !out.includes(nearest)) out.push(nearest);
  return out.slice(0, MCX_CHAIN_MAX_EXPIRIES);
}

/** The future an MCX option of `optionExpiry` is written on: the earliest one expiring on or after it. */
export function underlyingFutureFor<F extends { expiry: string }>(optionExpiry: string, futures: readonly F[]): F | null {
  let best: F | null = null;
  for (const f of futures) if (f.expiry >= optionExpiry && (best === null || f.expiry < best.expiry)) best = f;
  return best;
}

/**
 * The future's price implied by put-call parity at the strike where |CE − PE| is smallest (the ATM pair):
 * F ≈ K + CE − PE (options on futures; the discount over a few weeks is far inside a strike step).
 * null when no strike has both legs priced.
 */
export function parityFuture(legs: ReadonlyArray<{ strike: number; ce: number | null; pe: number | null }>): number | null {
  let best: { strike: number; diff: number } | null = null;
  for (const l of legs) {
    if (l.ce === null || l.pe === null || !(l.ce > 0) || !(l.pe > 0)) continue;
    const diff = l.ce - l.pe;
    if (best === null || Math.abs(diff) < Math.abs(best.diff)) best = { strike: l.strike, diff };
  }
  if (best === null) return null;
  const f = best.strike + best.diff;
  return f > 0 ? Math.round(f * 100) / 100 : null;
}

/** One oi_snapshots row of one option contract (the newest capture). */
export interface McxOiRow {
  instrumentId: string;
  oi: number;
  /** OI minus the contract's last OI of the previous session (the hub's baseline); null = no baseline. */
  oiChange: number | null;
  volume: number;
  ltp: number | null;
}

export interface McxChainInput {
  underlying: string;
  expiry: string;
  capturedAt: Date;
  contracts: ReadonlyArray<{ instrumentId: string; strike: number; optionType: 'CE' | 'PE' }>;
  rows: readonly McxOiRow[];
  /** The underlying future's price at the capture (its 1-min close); null ⇒ put-call parity from the capture. */
  futBar: number | null;
  strikesAround?: number;
}

export type McxChainResult =
  | { ok: true; row: ChainSnapshotRow; fut: number; futSource: 'candles_1m' | 'parity'; strikes: number }
  | { ok: false; reason: string };

/**
 * The captured legs → the NSE chain's snapshot row (mbm/domain/chain-snapshot buildChainSnapshot): ATM from
 * the future's price, ±N listed strikes around it, PCR / max pain / walls over that window, oi_chg from the
 * hub's own previous-session baseline. No row when nothing was captured or no future price can be found.
 */
export function mcxChainSnapshot(i: McxChainInput): McxChainResult {
  const byId = new Map(i.rows.map((r) => [r.instrumentId, r]));
  const captured = i.contracts.filter((c) => byId.has(c.instrumentId));
  if (captured.length === 0) return { ok: false, reason: `no captured legs for ${i.underlying} ${i.expiry}` };

  const legs = new Map<number, { strike: number; ce: number | null; pe: number | null }>();
  for (const c of captured) {
    const l = legs.get(c.strike) ?? { strike: c.strike, ce: null, pe: null };
    const ltp = byId.get(c.instrumentId)?.ltp ?? null;
    if (c.optionType === 'CE') l.ce = ltp;
    else l.pe = ltp;
    legs.set(c.strike, l);
  }
  const bar = i.futBar !== null && Number.isFinite(i.futBar) && i.futBar > 0 ? i.futBar : null;
  const fut = bar ?? parityFuture([...legs.values()]);
  if (fut === null) return { ok: false, reason: `no price for ${i.underlying}'s underlying future (no 1-min bar near the capture, no CE/PE pair to imply it)` };

  const keep = new Set(strikesAround([...legs.keys()], fut, i.strikesAround ?? MCX_CHAIN_STRIKES_AROUND));
  const contracts: CaptureContract[] = [];
  const quotes = new Map<string, CaptureQuote>();
  const baseline = new Map<string, number>();
  for (const c of captured) {
    if (!keep.has(c.strike)) continue;
    const r = byId.get(c.instrumentId) as McxOiRow;
    contracts.push({ token: c.instrumentId, strike: c.strike, optionType: c.optionType });
    quotes.set(c.instrumentId, { ltp: r.ltp ?? Number.NaN, oi: r.oi, volume: r.volume });
    if (r.oiChange !== null && Number.isFinite(r.oiChange)) baseline.set(`${c.strike}:${c.optionType}`, r.oi - r.oiChange);
  }
  const row = buildChainSnapshot({ instrument: i.underlying, expiry: i.expiry, capturedAt: i.capturedAt, spot: fut, contracts, quotes, greeks: null, baseline });
  return { ok: true, row, fut, futSource: bar !== null ? 'candles_1m' : 'parity', strikes: keep.size };
}

/**
 * The judge packet's chain value — ONE shape for the NSE snapshot and the MCX capture, so the prompt reads
 * both the same way. `spot` is what the options settle to; `fut` the separate near-month future (null when
 * the settlement price IS a future, as on MCX).
 */
export function chainBlockValue(row: Pick<ChainSnapshotRow, 'expiry' | 'capturedAt' | 'spot' | 'pcr' | 'maxPain' | 'callWall' | 'putWall' | 'fut'>, now: Date) {
  const ageMin = Math.round((now.getTime() - row.capturedAt.getTime()) / 60_000);
  return {
    expiry: row.expiry,
    capturedAt: row.capturedAt.toISOString(),
    ageMin,
    spot: row.spot,
    fut: row.fut ?? null,
    pcr: row.pcr,
    maxPain: row.maxPain,
    callWall: row.callWall,
    putWall: row.putWall,
  };
}
