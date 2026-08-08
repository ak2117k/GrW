/**
 * Index volume proxy — see
 * docs/superpowers/specs/2026-08-07-trade-plan-design.md §1.3 / §3.4.
 *
 * Angel reports `volume: 0` on index tokens (NIFTY 99926000 et al). The old
 * code turned that into `volumeRatio = 0`, which is a *measurement* saying
 * "volume disconfirmed this trade" — so no index could ever pass the
 * breakout volume gate, and every index reversal was graded and labelled
 * `vol 0.00×`.
 *
 * An index's real participation lives in its option chain. This module
 * turns the chain's total traded volume into a ratio against its own
 * recent average, and — crucially — returns `null` (NO READING) rather
 * than 0 whenever it cannot produce one.
 *
 * Everything here is pure / container-free so it can be unit-tested
 * without a Nest module.
 */
import { INDICES, SECTOR_INDICES } from '@td/shared';

/** Rolling window (number of periods) the proxy averages over. */
export const INDEX_VOLUME_WINDOW = 20;

/**
 * Minimum number of prior period-deltas before a ratio is meaningful.
 * Below this the tracker reports `null` — "no reading yet" — instead of
 * inventing a ratio off one or two samples.
 */
export const INDEX_VOLUME_MIN_SAMPLES = 5;

/**
 * Index tokens whose candles carry no volume. Sourced from the shared
 * constants (single source of truth) plus the two F&O indices that aren't
 * in that map.
 */
const INDEX_TOKENS: ReadonlySet<string> = new Set<string>([
  ...Object.values(INDICES).map((i) => i.token),
  ...Object.values(SECTOR_INDICES).map((i) => i.token),
  '99926074', // MIDCPNIFTY
  '99919012', // BANKEX (BSE)
]);

/** Index symbols, for callers that only have a symbol (no token). */
const INDEX_SYMBOLS: ReadonlySet<string> = new Set<string>([
  ...Object.values(INDICES).map((i) => i.symbol.toUpperCase()),
  ...Object.values(SECTOR_INDICES).map((i) => i.symbol.toUpperCase()),
  'MIDCPNIFTY',
  'BANKEX',
  'NIFTY BANK',
]);

/**
 * Underlyings that actually have an option chain we can read. A sector
 * index (NIFTY METAL, …) is an index but has no options — for those the
 * honest answer stays `null`.
 */
const CHAIN_UNDERLYINGS: ReadonlySet<string> = new Set<string>([
  'NIFTY',
  'BANKNIFTY',
  'FINNIFTY',
  'MIDCPNIFTY',
  'SENSEX',
  'BANKEX',
]);

/** True when this instrument's own candles cannot carry volume. */
export function isIndexInstrument(args: {
  token?: string | null;
  symbol?: string | null;
}): boolean {
  const token = args.token?.trim();
  if (token && INDEX_TOKENS.has(token)) return true;
  const symbol = args.symbol?.trim().toUpperCase();
  if (symbol && INDEX_SYMBOLS.has(symbol)) return true;
  return false;
}

/**
 * The option-chain underlying to read participation from, or null when
 * this instrument has no chain (stocks are handled by their own candle
 * volume; sector indices have no options at all).
 */
export function chainUnderlyingFor(args: {
  token?: string | null;
  symbol?: string | null;
}): string | null {
  if (!isIndexInstrument(args)) return null;
  const symbol = args.symbol?.trim().toUpperCase();
  if (!symbol) return null;
  const normalised = symbol === 'NIFTY BANK' ? 'BANKNIFTY' : symbol;
  return CHAIN_UNDERLYINGS.has(normalised) ? normalised : null;
}

/** Minimal shape of an option-chain row we care about here. */
export interface ChainVolumeRow {
  ceData?: { volume?: number | null } | null;
  peData?: { volume?: number | null } | null;
}

/**
 * Total traded volume across the whole chain (CE + PE, every strike).
 * Non-finite / missing entries contribute 0 — an absent strike is not a
 * reading, and the caller treats a total of 0 as "no reading" anyway.
 */
export function totalChainVolume(chain: readonly ChainVolumeRow[]): number {
  let total = 0;
  for (const row of chain) {
    const ce = Number(row?.ceData?.volume);
    const pe = Number(row?.peData?.volume);
    if (Number.isFinite(ce) && ce > 0) total += ce;
    if (Number.isFinite(pe) && pe > 0) total += pe;
  }
  return total;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * Converts successive *cumulative* option-chain volume readings into a
 * per-period volume ratio.
 *
 * Chain volume is cumulative for the session, so consecutive samples grow
 * monotonically; comparing raw cumulative totals would report ~1.0× all
 * day. We therefore difference them: the reading for this period is
 * (total now − total at the previous sample), compared against the median
 * of the previous deltas — median, not mean, for the same outlier reason
 * `LevelsContextStrategy.vma` uses one.
 *
 * Returns `null` — no reading — when:
 *   • this is the first sample for the key (nothing to difference against)
 *   • the cumulative total went DOWN (new session; series is reset)
 *   • the total is unchanged (a cached/stale chain snapshot is not
 *     evidence that zero contracts traded)
 *   • fewer than INDEX_VOLUME_MIN_SAMPLES prior deltas exist
 *
 * It never returns 0: a 0 here would be indistinguishable from a real
 * "no participation" reading, which is exactly the bug this replaces.
 */
export class IndexVolumeTracker {
  private readonly lastCumulative = new Map<string, number>();
  private readonly deltas = new Map<string, number[]>();

  /**
   * @param key   caller-scoped identity — use `${token}:${interval}`
   * @param total latest CUMULATIVE total chain volume
   */
  record(key: string, total: number): number | null {
    if (!Number.isFinite(total) || total <= 0) return null;

    const prev = this.lastCumulative.get(key);
    this.lastCumulative.set(key, total);
    if (prev === undefined) return null;

    const delta = total - prev;
    if (delta < 0) {
      // Cumulative went backwards → new session. Old deltas describe a
      // different day; drop them rather than blend the two.
      this.deltas.set(key, []);
      return null;
    }
    if (delta === 0) return null;

    const history = this.deltas.get(key) ?? [];
    const baseline = median(history);
    const ratio =
      history.length >= INDEX_VOLUME_MIN_SAMPLES && baseline > 0
        ? delta / baseline
        : null;

    history.push(delta);
    while (history.length > INDEX_VOLUME_WINDOW) history.shift();
    this.deltas.set(key, history);

    return ratio !== null && Number.isFinite(ratio) && ratio > 0 ? ratio : null;
  }

  /** Number of usable prior deltas held for a key (diagnostics / tests). */
  sampleCount(key: string): number {
    return this.deltas.get(key)?.length ?? 0;
  }

  /** Drop all state for a key (or everything when omitted). */
  reset(key?: string): void {
    if (key === undefined) {
      this.lastCumulative.clear();
      this.deltas.clear();
      return;
    }
    this.lastCumulative.delete(key);
    this.deltas.delete(key);
  }
}
