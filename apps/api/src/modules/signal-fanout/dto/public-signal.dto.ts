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
  entryRow: AnandEntryLike & { token?: string | null },
  segment: Segment,
  side: 'BUY' = 'BUY',
): PublicSignal {
  const pub = toPublicEntry(entryRow, segment);
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
