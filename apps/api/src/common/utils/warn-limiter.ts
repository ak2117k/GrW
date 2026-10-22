/**
 * Warn-once-per-key-per-window, for warnings that repeat identically every cycle.
 *
 * WHY: on the 1-vCPU VPS a handful of services re-logged the SAME warning every
 * poll (AnandPriceMonitorService ~100 WARN / 2 h, PaperTradeService ~37,
 * OptionsChainService ~14) — the condition was already known after the first
 * line, and the repeats buried the logs that mattered.
 *
 * NOT A SILENCER. The first occurrence of a key always logs; after the window
 * the next occurrence logs again and says how many identical lines were held
 * back meanwhile, so a condition that persists stays visible once an hour and a
 * condition that clears simply stops. Errors are never routed through this.
 */
export const WARN_ONCE_WINDOW_MS = 60 * 60_000;

/** Upper bound on remembered keys, so per-entity keys cannot grow without limit. */
const MAX_KEYS = 5_000;

export class WarnLimiter {
  private readonly seen = new Map<string, { at: number; suppressed: number }>();

  constructor(
    readonly windowMs = WARN_ONCE_WINDOW_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * The line to log for `key` (with a "N repeats suppressed" suffix when some
   * were held back), or `null` when an identical warning already logged inside
   * the window.
   */
  message(key: string, text: string): string | null {
    const t = this.now();
    const prev = this.seen.get(key);
    if (prev && t - prev.at < this.windowMs) {
      prev.suppressed++;
      return null;
    }
    if (!prev && this.seen.size >= MAX_KEYS) this.seen.clear();
    this.seen.set(key, { at: t, suppressed: 0 });
    const held = prev?.suppressed ?? 0;
    return held > 0 ? `${text} (${held} identical warnings suppressed in the last ${Math.round(this.windowMs / 60_000)} min)` : text;
  }

  /** Log through `warn` unless rate-limited. Returns whether it logged. */
  warn(log: { warn(message: string): unknown }, key: string, text: string): boolean {
    const line = this.message(key, text);
    if (line === null) return false;
    log.warn(line);
    return true;
  }
}
