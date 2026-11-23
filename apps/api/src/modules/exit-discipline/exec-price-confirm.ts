import { hardFloorReading, type HardFloorInput, type HardFloorReading } from './hard-floor';
import type { PositionSide } from './types';

/**
 * EXECUTABLE-PRICE CONFIRM (owner-approved 2026-11-23). Pure.
 *
 * Prod 2026-11-23 10:51 IST, the owner's real GOLDM27NOV26126500CE long: floor armed 1144.29, FLOOR_HARD_EXIT
 * GREEN_TO_RED fired on a last-traded price of 1121.5 — a stale print (that minute traded 14 lots; both
 * confirming reads ~20 s apart saw the same last trade). The MARKET SELL filled at 1146.5: the floor had not
 * broken at any price the position could be sold at. Of the 95 live code exits replayed it was the only fill
 * above its floor, and a fresh REST LTP would not have caught it (the broker's LTP was 1121.5 too) — only the bid.
 *
 * So on the read that CONFIRMS a FLOOR_HARD trip (GREEN_TO_RED, FLOOR_BREAK_GREEN, HWM_UNDERLYING_MOVE) or the
 * TARGET_LADDER trail stop, the trip is re-priced at the price the exit would actually get: the best BID for a
 * long, the best ASK for a short — the hub's SNAP_QUOTE book when ≤ EXEC_BOOK_MAX_AGE_MS old, else one REST
 * FULL quote. It only ever ADDS a condition to an exit today's code makes; it never creates one. MAX_LOSS /
 * the hard loss exits are not touched, and the stale-HIGH case (LTP above the floor, bid below) is not added.
 *
 *   - book known:       fire only if the rule still trips at the executable price; else STALE_PRINT (hold).
 *   - no book:          fire only if the contract's day volume ROSE between the confirming reads; flat ⇒ hold.
 *   - nothing known:    fire (today's LTP behaviour — fail toward exiting).
 *
 * FLOOR_EXEC_PRICE_CONFIRM=off|observe|act (default observe: computed and recorded, never holds).
 */
export type ExecConfirmMode = 'off' | 'observe' | 'act';

/** The hub's book is used only when received this recently; otherwise one REST read. */
export const EXEC_BOOK_MAX_AGE_MS = 3_000;
/** The REST book read is cached this long per contract (the frontend depth route's TTL). */
export const EXEC_REST_CACHE_MS = 1_500;
/** The REST book read is given this long before it counts as "no book". */
export const EXEC_REST_TIMEOUT_MS = 2_000;

export function parseExecConfirmMode(raw: string | undefined): { mode: ExecConfirmMode; problem: string | null } {
  const v = String(raw ?? '').trim().toLowerCase();
  if (v === '' || v === 'observe') return { mode: 'observe', problem: null };
  if (v === 'off' || v === 'act') return { mode: v, problem: null };
  return { mode: 'observe', problem: `FLOOR_EXEC_PRICE_CONFIRM=${raw} is not off|observe|act — using observe` };
}

/**
 * The contract's best bid / ask and day volume at one moment. `at` = receipt time (ms epoch). Prices in
 * rupees; null / 0 = not reported. `volume` null / ≤ 0 = not reported.
 */
export interface ContractBook {
  bid: number | null;
  ask: number | null;
  volume: number | null;
  at: number;
  source: 'hub' | 'rest';
}

const pos = (x: number | null | undefined): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0;

/**
 * A ContractBook from a broker / hub best-five book (best first) and the day volume. Null when neither a
 * best price nor a volume was reported — nothing to confirm with.
 */
export function contractBookOf(
  depth: { bids: ReadonlyArray<{ price: number }>; asks: ReadonlyArray<{ price: number }> } | null | undefined,
  volume: number | null | undefined,
  at: number,
  source: ContractBook['source'],
): ContractBook | null {
  const bid = pos(depth?.bids?.[0]?.price) ? depth!.bids[0].price : null;
  const ask = pos(depth?.asks?.[0]?.price) ? depth!.asks[0].price : null;
  const vol = pos(volume) ? volume : null;
  return bid === null && ask === null && vol === null ? null : { bid, ask, volume: vol, at, source };
}

/** The executable price: the best bid for a long (it sells), the best ask for a short (it buys back). */
export function execPriceOf(side: PositionSide, book: ContractBook | null | undefined): number | null {
  if (!book) return null;
  const px = side === 'LONG' ? book.bid : book.ask;
  return pos(px) ? px : null;
}

/** The hub's book when it is ≤ maxAgeMs old and carries the side's price; else null (go to REST). */
export function freshHubBook(side: PositionSide, book: ContractBook | null | undefined, nowMs: number, maxAgeMs = EXEC_BOOK_MAX_AGE_MS): ContractBook | null {
  if (!book || !Number.isFinite(book.at) || nowMs - book.at > maxAgeMs) return null;
  return execPriceOf(side, book) !== null ? book : null;
}

/**
 * The hard floor re-read at the executable price, with the net P&L at that price. GREEN_TO_RED needs the
 * position red at the bid; green at the bid but under the floor is the green lock (FLOOR_BREAK_GREEN) — the
 * same rules, the same input, only the price moved to one the exit can get.
 */
export function floorReadingAtExec(input: HardFloorInput, execPrice: number, netPnlAtExec: number | null): HardFloorReading {
  return hardFloorReading({ ...input, ltp: execPrice, netPnl: netPnlAtExec });
}

/** The ladder's trail-stop crossing at the executable price — the ladder's own comparison (target-ladder.ts). */
export function ladderTrailTripsAt(side: PositionSide, stop: number, execPrice: number): boolean {
  return side === 'LONG' ? execPrice <= stop + 1e-9 : execPrice >= stop - 1e-9;
}

export type ExecBasis =
  /** The book's executable price still trips the rule. */
  | 'BOOK_CONFIRMS'
  /** The book's executable price does not trip it: the LTP is a stale print. */
  | 'STALE_PRINT'
  /** No book; the day volume rose between the confirming reads (trades really happened). */
  | 'VOLUME_ROSE'
  /** No book; the day volume did not move: the same print read twice. */
  | 'VOLUME_FLAT'
  /** No book and no volume: today's LTP rule. */
  | 'UNKNOWN';

export interface ExecCheck {
  fire: boolean;
  basis: ExecBasis;
  execPrice: number | null;
  source: 'hub' | 'rest' | null;
  volumeBefore: number | null;
  volumeNow: number | null;
}

export interface ExecConfirmInput {
  /** execPriceOf(side, book); null = no book from either source. */
  execPrice: number | null;
  source: 'hub' | 'rest' | null;
  /** The rule re-read at execPrice; ignored when execPrice is null. */
  tripsAtExec: boolean | null;
  /** The contract's day volume at the first read of the confirming run, and now. */
  volumeBefore: number | null;
  volumeNow: number | null;
}

export function execConfirm(i: ExecConfirmInput): ExecCheck {
  const base = { execPrice: i.execPrice, source: i.execPrice !== null ? i.source : null, volumeBefore: i.volumeBefore, volumeNow: i.volumeNow };
  if (i.execPrice !== null) {
    return i.tripsAtExec === true ? { fire: true, basis: 'BOOK_CONFIRMS', ...base } : { fire: false, basis: 'STALE_PRINT', ...base };
  }
  if (pos(i.volumeBefore) && pos(i.volumeNow)) {
    return i.volumeNow > i.volumeBefore ? { fire: true, basis: 'VOLUME_ROSE', ...base } : { fire: false, basis: 'VOLUME_FLAT', ...base };
  }
  return { fire: true, basis: 'UNKNOWN', ...base };
}

/** True only when the switch is `act` and the check says hold. observe / off never change an exit. */
export function execHolds(mode: ExecConfirmMode, check: ExecCheck | null | undefined): boolean {
  return mode === 'act' && !!check && !check.fire;
}

/** One line for the log / the reason: what the executable price said. */
export function describeExecCheck(c: ExecCheck, ltp: number, level: number, levelName: string): string {
  const vol = `volume ${c.volumeBefore ?? '?'} → ${c.volumeNow ?? '?'}`;
  switch (c.basis) {
    case 'BOOK_CONFIRMS':
      return `exec ${c.execPrice} (${c.source} book) confirms the ${levelName} ${level} (ltp ${ltp})`;
    case 'STALE_PRINT':
      return `ltp ${ltp} but exec ${c.execPrice} (${c.source} book) is not through the ${levelName} ${level} — stale print`;
    case 'VOLUME_ROSE':
      return `no book; ${vol} rose — ltp ${ltp} through the ${levelName} ${level} stands`;
    case 'VOLUME_FLAT':
      return `no book; ${vol} flat — ltp ${ltp} is the same print read twice`;
    default:
      return `no book and no volume — ltp ${ltp} through the ${levelName} ${level} stands (today's rule)`;
  }
}
