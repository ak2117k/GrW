// The sanitized signal contract that crosses from the engine into the fan-out
// queues (TDA-010 §3.1). Derived ONLY from the TDA-006 `toPublicEntry` allowlist
// output + `side` + `token`, so a new provenance column on
// IntradayEntry/SwingEntry can NEVER leak into a queued job. Never spread a raw
// row onto a PublicSignal — always build via `toPublicSignal`.

import {
  AnandEntryLike,
  toPublicEntry,
} from '../../anand-dual-track/dto/public-entry.dto';
import { sha256 } from '../../../common/audit/canonicalize';

export type Segment = 'INTRADAY' | 'SWING';

/**
 * The provenance-free, execution-relevant projection of an anand entry. This is
 * the only signal shape allowed onto a Bull job payload (§3.1).
 */
export interface PublicSignal {
  /** IntradayEntry|SwingEntry id — the idempotency input (NOT provenance). */
  entryId: string;
  symbol: string;
  segment: Segment;
  /** anand intraday/swing are long-only setups (§9). */
  side: 'BUY';
  entryPrice: number;
  /** product param (5 intraday / 10 swing). */
  targetPct: number;
  stopPct: number;
  token: string | null;
}

/** One fan-out job = one central signal for one segment. */
export interface FanoutJob {
  signal: PublicSignal;
}

/**
 * The minimal source-row shape `toPublicSignal` reads. A clean named type (no
 * index signature) so a precise repo return type (`CreatedEntryRow`) is
 * assignable. Provenance columns, if present at runtime, are simply never read.
 */
export interface SignalSourceRow {
  id: string;
  symbol: string;
  entryPrice: number;
  enteredAt: string | Date;
  targetPct: number;
  stopPct: number;
  status: string;
  token?: string | null;
  exitPrice?: number | null;
  exitedAt?: string | Date | null;
  currentPrice?: number | null;
  pnlPct?: number | null;
  targetLeftPct?: number | null;
  priceStale?: boolean;
}

/** One execute-user job = one (signal × eligible user). The contract with TDA-011. */
export interface ExecuteUserJob {
  userId: string;
  signal: PublicSignal;
  /**
   * sha256(entryId:userId) — the idempotency key. Computed HERE (in fan-out) so
   * it is identical across a retried job and stable for TDA-011's guard + the
   * broker order tag.
   */
  idempotencyKey: string;
}

/**
 * Build a {@link PublicSignal} from a freshly-created entry row. Passes the row
 * through the TDA-006 `toPublicEntry` allowlist first, then projects the
 * execution subset + `side` + `token`. `token` is carried from the raw row (it
 * is an instrument token needed for execution, not provenance).
 */
export function toPublicSignal(
  entryRow: SignalSourceRow,
  segment: Segment,
  side: 'BUY' = 'BUY',
): PublicSignal {
  // toPublicEntry takes the loose AnandEntryLike (which carries an index
  // signature for ignored provenance columns); SignalSourceRow overlaps it on
  // every read field, so the cast is sound and the allowlist still governs output.
  const pub = toPublicEntry(entryRow as AnandEntryLike, segment);
  return {
    entryId: pub.id,
    symbol: pub.symbol,
    segment: pub.segment,
    side,
    entryPrice: pub.entryPrice,
    targetPct: pub.targetPct,
    stopPct: pub.stopPct,
    token: entryRow.token ?? null,
  };
}

/** sha256(`${entryId}:${userId}`) — stable across retries, distinct per user. */
export function idempotencyKeyFor(entryId: string, userId: string): string {
  return sha256(`${entryId}:${userId}`);
}
