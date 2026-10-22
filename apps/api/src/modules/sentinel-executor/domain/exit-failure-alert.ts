/**
 * Owner alert for AI exits that end FAILED.
 *
 * WHY: prod 2026-10-14..19 wrote 471 ai_exit_executions rows FAILED: BROKER_READ
 * across 5 trackers and nobody noticed — the only trace was a WARN line per
 * attempt in a log nobody reads during market hours. A FAILED exit means the AI
 * decided to get out and the position is still open, so it must reach a human.
 *
 * POLICY (pure, so it is testable without a clock or a network):
 *  - every FAILED outcome (any reason) is eligible for an alert;
 *  - at most ONE alert per tracker per `cooldownMs` (default 30 min), so a
 *    retry loop that fails every cycle produces one message, not hundreds;
 *  - the consecutive-failure streak per tracker is counted and carried in the
 *    text; reaching `streakAlertAfter` (default 3, AI_EXIT_FAIL_ALERT_STREAK)
 *    marks the message REPEATED. Any non-FAILED terminal outcome resets it.
 *
 * NEVER CARRIES CREDENTIALS. The broker message is truncated and anything
 * token-shaped (JWTs, long opaque strings, `key=value` secrets) is redacted
 * before it leaves the process.
 */
export const EXIT_FAIL_ALERT_COOLDOWN_MS = 30 * 60_000;
export const DEFAULT_EXIT_FAIL_STREAK = 3;

export interface ExitFailureEvent {
  trackerId: string;
  symbol: string;
  reason: string | null;
  brokerMessage?: string | null;
}

export interface ExitFailureAlert {
  key: string;
  text: string;
  streak: number;
}

/** `AI_EXIT_FAIL_ALERT_STREAK`: a positive integer; anything else ⇒ the default 3. */
export function exitFailStreakFrom(raw: string | undefined): number {
  const n = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_EXIT_FAIL_STREAK;
}

/** Strip anything secret-shaped from a broker message and bound its length. */
export function scrubBrokerMessage(msg: string | null | undefined, max = 200): string {
  if (!msg) return 'none';
  return String(msg)
    .replace(/eyJ[\w-]+\.[\w-]+(\.[\w-]+)?/g, '<redacted>') // JWT
    .replace(/\b(bearer|token|jwt|apikey|api_key|secret|password|pin|totp|authorization)\b\s*[:=]?\s*\S+/gi, '$1 <redacted>')
    .replace(/[A-Za-z0-9+/_-]{32,}={0,2}/g, '<redacted>') // long opaque strings
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export class ExitFailureAlerts {
  private readonly streak = new Map<string, number>();
  private readonly lastSent = new Map<string, number>();

  constructor(
    readonly streakAlertAfter = DEFAULT_EXIT_FAIL_STREAK,
    readonly cooldownMs = EXIT_FAIL_ALERT_COOLDOWN_MS,
  ) {}

  /** A non-FAILED terminal outcome for this tracker: the streak is over. */
  succeeded(trackerId: string): void {
    this.streak.delete(trackerId);
  }

  /** A FAILED outcome. Returns the alert to send, or `null` while the tracker is cooling down. */
  failed(e: ExitFailureEvent, now: number): ExitFailureAlert | null {
    const n = (this.streak.get(e.trackerId) ?? 0) + 1;
    this.streak.set(e.trackerId, n);
    const prev = this.lastSent.get(e.trackerId);
    if (prev !== undefined && now - prev < this.cooldownMs) return null;
    this.lastSent.set(e.trackerId, now);
    const repeated = n >= this.streakAlertAfter;
    const text =
      `GrW ALERT: AI exit FAILED${repeated ? ` (REPEATED — ${n} in a row)` : n > 1 ? ` (${n} in a row)` : ''} — ` +
      `${e.symbol} (tracker ${e.trackerId}). Reason: ${e.reason ?? 'unknown'}. ` +
      `Broker: ${scrubBrokerMessage(e.brokerMessage)}. The position may still be OPEN — check it.`;
    return { key: `ai-exit-failed:${e.trackerId}`, text, streak: n };
  }
}
