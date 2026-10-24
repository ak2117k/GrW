/**
 * Token guard rails for the Strategy Builder's Claude calls, in one place:
 *
 *  - cache:      same normalised request (hash) → the earlier answer, no call
 *                (cache hits never count against the cap or cooldown);
 *  - in-flight:  one call per user at a time, and an identical request while
 *                its twin is running is refused;
 *  - repeat:     an identical request that just FAILED (bad answer, error) is
 *                refused for a while — retrying the same thing burns tokens;
 *  - cooldown:   per (user, strategy, job), e.g. 60 s between real calls;
 *  - daily cap:  STRATEGY_AI_DAILY_CAP real calls per user per IST day.
 *
 * In-memory on purpose: the API is a single process and these are owner-only
 * calls; a restart resetting the counters is acceptable (the cap is a ceiling
 * against runaway clicking, not billing). Every real call is also an ai_calls row.
 */
export type AiJob = 'strategy.review' | 'strategy.suggest';

export type Admission =
  | { ok: true; ticket: Ticket }
  | { ok: false; reason: 'in-flight' | 'duplicate' | 'repeat' | 'cooldown' | 'cap'; message: string; retryAfterMs?: number };

export interface Ticket {
  userId: string;
  strategyKey: string;
  job: AiJob;
  hash: string;
  day: string;
}

export interface GovernorOptions {
  dailyCap: number;
  cooldownMs: number;
  cacheTtlMs: number;
  cacheMax: number;
  repeatBlockMs: number;
  now?: () => number;
}

const IST_OFFSET_MS = 5.5 * 3_600_000;

export class StrategyAiGovernor<T = unknown> {
  private readonly now: () => number;
  private readonly cache = new Map<string, { at: number; value: T }>();
  private readonly inFlightByUser = new Map<string, string>();
  private readonly inFlightHashes = new Set<string>();
  private readonly failedAt = new Map<string, number>();
  private readonly lastCallAt = new Map<string, number>();
  private readonly used = new Map<string, number>();

  constructor(private readonly opts: GovernorOptions) {
    this.now = opts.now ?? Date.now;
  }

  get dailyCap(): number {
    return this.opts.dailyCap;
  }

  private day(): string {
    return new Date(this.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
  }

  private usedKey(userId: string, day = this.day()): string {
    return `${day}|${userId}`;
  }

  remaining(userId: string): number {
    return Math.max(0, this.opts.dailyCap - (this.used.get(this.usedKey(userId)) ?? 0));
  }

  cached(hash: string): T | undefined {
    const hit = this.cache.get(hash);
    if (!hit) return undefined;
    if (this.now() - hit.at > this.opts.cacheTtlMs) {
      this.cache.delete(hash);
      return undefined;
    }
    return hit.value;
  }

  /** Check every rule; on success the call is reserved (counted, cooled down, marked in flight). */
  admit(userId: string, strategyKey: string, job: AiJob, hash: string): Admission {
    const now = this.now();
    if (this.inFlightHashes.has(hash)) {
      return { ok: false, reason: 'duplicate', message: 'That exact request is already running — the answer will appear when it finishes.' };
    }
    if (this.inFlightByUser.has(userId)) {
      return { ok: false, reason: 'in-flight', message: 'Another AI request is still running. Wait for it to finish.' };
    }
    const failed = this.failedAt.get(hash);
    if (failed !== undefined && now - failed < this.opts.repeatBlockMs) {
      return {
        ok: false,
        reason: 'repeat',
        message: 'Claude could not answer this exact strategy a moment ago. Change something, or try again later.',
        retryAfterMs: this.opts.repeatBlockMs - (now - failed),
      };
    }
    const coolKey = `${userId}|${strategyKey}|${job}`;
    const last = this.lastCallAt.get(coolKey);
    if (last !== undefined && now - last < this.opts.cooldownMs) {
      const wait = this.opts.cooldownMs - (now - last);
      return { ok: false, reason: 'cooldown', message: `Please wait ${Math.ceil(wait / 1000)} s before asking again for this strategy.`, retryAfterMs: wait };
    }
    if (this.remaining(userId) <= 0) {
      return { ok: false, reason: 'cap', message: `Daily limit of ${this.opts.dailyCap} AI requests reached. It resets at midnight IST.` };
    }
    const day = this.day();
    this.used.set(this.usedKey(userId, day), (this.used.get(this.usedKey(userId, day)) ?? 0) + 1);
    this.lastCallAt.set(coolKey, now);
    this.inFlightByUser.set(userId, hash);
    this.inFlightHashes.add(hash);
    return { ok: true, ticket: { userId, strategyKey, job, hash, day } };
  }

  /** The call answered: cache it. */
  succeed(t: Ticket, value: T): void {
    this.release(t);
    this.failedAt.delete(t.hash);
    this.cache.set(t.hash, { at: this.now(), value });
    while (this.cache.size > this.opts.cacheMax) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  /** The call ran and failed (bad answer, error): the identical request is blocked for a while. */
  fail(t: Ticket): void {
    this.release(t);
    this.failedAt.set(t.hash, this.now());
  }

  /** The call never started (no free model slot): refund the cap and the cooldown. */
  refund(t: Ticket): void {
    this.release(t);
    const k = this.usedKey(t.userId, t.day);
    this.used.set(k, Math.max(0, (this.used.get(k) ?? 1) - 1));
    this.lastCallAt.delete(`${t.userId}|${t.strategyKey}|${t.job}`);
  }

  private release(t: Ticket): void {
    if (this.inFlightByUser.get(t.userId) === t.hash) this.inFlightByUser.delete(t.userId);
    this.inFlightHashes.delete(t.hash);
  }
}
