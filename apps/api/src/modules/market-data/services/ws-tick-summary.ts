/**
 * Per-minute summary of the Angel One websocket's tick traffic.
 *
 * Replaces the old per-tick `WS tick: {...}` debug line, which on the 1-vCPU VPS
 * was ~5,300 log lines per 2 h of pure noise (and a JSON.stringify per tick).
 * Ticks are counted in memory; at most one summary line per window is produced,
 * on the first tick AFTER the window closes — no timer, so an idle feed logs
 * nothing (silence there means no ticks, which the connection logs already say).
 *
 * `WS_TICK_DEBUG=1` (or `true`) restores the per-tick line for a debugging
 * session; it defaults OFF.
 */
export class WsTickSummary {
  private windowStart: number;
  private ticks = 0;
  private unparsed = 0;
  private readonly tokens = new Set<string>();

  constructor(
    private readonly now: () => number = Date.now,
    readonly windowMs = 60_000,
  ) {
    this.windowStart = now();
  }

  /**
   * Count one raw tick (`token` when it parsed, `null` when it did not). Returns
   * the summary line for the window this tick closes, else `null`.
   */
  record(token: string | null): string | null {
    const t = this.now();
    const line = t - this.windowStart >= this.windowMs ? this.flush(t) : null;
    this.ticks++;
    if (token === null) this.unparsed++;
    else this.tokens.add(token);
    return line;
  }

  private flush(t: number): string | null {
    const secs = Math.max(1, Math.round((t - this.windowStart) / 1000));
    const line =
      this.ticks === 0
        ? null
        : `WS ticks: ${this.ticks} in ${secs}s across ${this.tokens.size} tokens` +
          (this.unparsed > 0 ? ` (${this.unparsed} unparsed)` : '');
    this.windowStart = t;
    this.ticks = 0;
    this.unparsed = 0;
    this.tokens.clear();
    return line;
  }
}

/** `WS_TICK_DEBUG`: per-tick logging only when exactly `1` or `true` (default off). */
export function wsTickDebugOn(raw: string | undefined): boolean {
  const v = raw?.trim().toLowerCase();
  return v === '1' || v === 'true';
}
