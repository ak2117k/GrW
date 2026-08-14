/**
 * One symbol spelling, so two engines can be compared.
 *
 * WHY THIS EXISTS, AND WHAT BREAKS WITHOUT IT. The roster asks
 * `EngineOwnershipProbe` which symbols another engine already manages, and marks
 * a match `OBSERVE_ONLY`. The two sides do not agree on spelling:
 *
 *   - `TradeTracker.symbol` is the broker's `tradingsymbol`, taken verbatim off
 *     Angel One's position/holding book — `SUZLON-EQ`, `RELIANCE-EQ`.
 *   - the watch tables (`watch_entries`, `ungated_watch_entries`,
 *     `adaptive_stop_watch_entries`, `sell_futures_watch_entries`) are populated
 *     from Chartink alerts and NSE lists, which carry the BASE symbol —
 *     `SUZLON`, `RELIANCE`.
 *
 * A raw string compare therefore never matches, the probe silently returns
 * nothing useful, and the sentinel labels `SENTINEL` a position `watch-monitor`
 * is already managing. In Stage 0 that is a mislabelled row; in Stage 1 it is
 * two engines racing to exit one position, which is exactly the hazard the
 * ownership check exists to prevent. A silent no-match is the worst possible
 * failure mode here, because it fails OPEN.
 *
 * Both sides are normalised through this one function so the rule cannot drift
 * apart. It is deliberately narrow:
 *
 *   - trim + uppercase;
 *   - strip ONE trailing NSE/BSE series suffix (`-EQ`, `-BE`, `-BZ`, `-SM`, ...).
 *
 * It does NOT touch derivative tradingsymbols (`NIFTY28AUG2524000CE`,
 * `RELIANCE28AUG25FUT`) because they carry no `-` suffix, and it must not: two
 * different strikes on one underlying are two different instruments, and
 * collapsing them would make the probe fail CLOSED on the wrong contract.
 *
 * Normalising to the base symbol is intentionally SLIGHTLY over-broad in the
 * safe direction: `SUZLON-EQ` and `SUZLON-BE` collapse together. If an engine
 * holds one series and the sentinel sees the other, the sentinel observes rather
 * than claims. Over-claiming is the dangerous error; over-observing is not.
 */
/**
 * `(.+)` and not `(.*)`: a bare `-EQ` must normalise to `-EQ`, not to the empty
 * string. An empty key would collide with every other unreadable symbol and put
 * unrelated instruments in the same ownership bucket.
 */
const SERIES_SUFFIX = /^(.+)-[A-Z0-9]{1,3}$/;

export function normaliseSymbol(symbol: string): string {
  const upper = String(symbol ?? '').trim().toUpperCase();
  return upper.replace(SERIES_SUFFIX, '$1');
}
