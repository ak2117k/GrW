import { sendOpsAlert } from '../../common/utils/ops-alert';
import type { ProviderName } from './providers/provider.types';

/** Calls that must fail in a row before it counts as an outage. A normal day has none (2026-11-05: 0 of 310). */
export const OUTAGE_AFTER_FAILURES = 5;
/** How often a continuing outage is announced again. */
export const OUTAGE_REALERT_MS = 3 * 3_600_000;

type Send = (key: string, text: string) => Promise<unknown>;

interface Streak {
  failures: number;
  since: number;
  alertedAt: number | null;
}

const ist = (ms: number): string =>
  new Date(ms).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });

const reasonOf = (err: unknown): string => String(err instanceof Error ? err.message : err).slice(0, 500);

/**
 * Tells the owner when an AI provider stops answering, and when it comes back. The gateway sees every
 * call, so this catches an outage whichever job hits it first (prod 2026-11-06: every call failed for
 * about 42 hours and nothing said so). Synchronous and never throws: it cannot delay or fail a call.
 */
export class ProviderOutageAlert {
  private readonly streaks = new Map<ProviderName, Streak>();

  constructor(
    private readonly send: Send = sendOpsAlert,
    private readonly now: () => number = Date.now,
  ) {}

  failure(provider: ProviderName, err: unknown): void {
    const at = this.now();
    const streak = this.streaks.get(provider) ?? { failures: 0, since: at, alertedAt: null };
    streak.failures += 1;
    this.streaks.set(provider, streak);
    if (streak.failures < OUTAGE_AFTER_FAILURES) return;
    if (streak.alertedAt !== null && at - streak.alertedAt < OUTAGE_REALERT_MS) return;
    streak.alertedAt = at;
    this.fire(
      `AI_PROVIDER_DOWN:${provider}`,
      `AI is down on ${provider}: ${streak.failures} calls in a row have failed since ${ist(streak.since)} IST. ` +
        `The trade judge, overnight review and self-review cannot use AI until this clears. Latest error: ${reasonOf(err)}`,
    );
  }

  success(provider: ProviderName): void {
    const streak = this.streaks.get(provider);
    if (!streak) return;
    this.streaks.delete(provider);
    if (streak.alertedAt === null) return;
    this.fire(`AI_PROVIDER_RECOVERED:${provider}`, `AI is back on ${provider} after ${streak.failures} failed calls since ${ist(streak.since)} IST.`);
  }

  private fire(key: string, text: string): void {
    try {
      void Promise.resolve(this.send(key, text)).catch(() => undefined);
    } catch {
      // An alert must never cost the call that triggered it.
    }
  }
}
