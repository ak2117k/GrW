import { Injectable, Logger } from '@nestjs/common';
import type { TickData } from '../../../common/interfaces/broker-adapter.interface';
import type {
  FeedState,
  TokenRef,
  UserFeedSessionFactory,
  UserFeedSessionLike,
} from './user-feed.types';

/** Global, userId-tagged handlers the gateway registers once (Task 6). */
export type ManagerTickHandler = (userId: string, tick: TickData) => void;
export type ManagerStateHandler = (userId: string, state: FeedState) => void;

/** Tunables — passed as a plain object so the specs can construct directly. */
export interface UserFeedManagerOptions {
  /** How long a user's session lingers with zero live interest before teardown. */
  idleMs: number;
  /** Max concurrent per-user sessions before we evict the least-recently-active idle one. */
  maxSessions: number;
}

/** One registry row: the user's session + per-token ref counts + idle bookkeeping. */
interface UserFeedEntry {
  session: UserFeedSessionLike;
  /** tokenKey -> live ref count (number of viewers wanting that token). */
  refs: Map<string, number>;
  /** The TokenRef behind each key, for (un)subscribe calls to the session. */
  tokenRefs: Map<string, TokenRef>;
  /** Tokens held by a long-lived in-process consumer (the market hub). */
  pins: Map<string, TokenRef>;
  idleTimer: ReturnType<typeof setTimeout> | null;
  lastActive: number;
}

function tokenKey(t: TokenRef): string {
  return `${t.exchange}:${t.token}`;
}

/**
 * Owns per-user broker feed sessions. Ref-counts token interest so a single
 * Angel One socket per user serves every viewer, tears the socket down after an
 * idle grace period, and caps the number of concurrent sessions.
 *
 * Constructed with a plain factory + options object for testability; Task 6
 * wires it as a Nest `useFactory` provider passing config-derived values.
 */
@Injectable()
export class UserFeedManager {
  private readonly logger = new Logger(UserFeedManager.name);

  private readonly registry = new Map<string, UserFeedEntry>();

  private onTickHandler: ManagerTickHandler | null = null;
  private onStateHandler: ManagerStateHandler | null = null;
  private readonly tickListeners = new Set<ManagerTickHandler>();
  private readonly stateListeners = new Set<ManagerStateHandler>();

  constructor(
    private readonly factory: UserFeedSessionFactory,
    private readonly opts: UserFeedManagerOptions,
  ) {}

  /** Register the single global tick/state handlers the gateway routes by userId. */
  setHandlers(onTick: ManagerTickHandler, onState: ManagerStateHandler): void {
    this.onTickHandler = onTick;
    this.onStateHandler = onState;
  }

  /** Extra tick consumers (the market hub) alongside the gateway's setHandlers. */
  addTickListener(fn: ManagerTickHandler): () => void {
    this.tickListeners.add(fn);
    return () => this.tickListeners.delete(fn);
  }

  addStateListener(fn: ManagerStateHandler): () => void {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  }

  /**
   * Add the caller's interest in `tokens`. Creates the user's session on first
   * use and only subscribes tokens whose ref count transitions 0 -> 1.
   */
  async subscribe(userId: string, tokens: TokenRef[]): Promise<void> {
    const entry = this.getOrCreateEntry(userId);

    // Any interest cancels a pending teardown.
    this.clearIdleTimer(entry);
    entry.lastActive = Date.now();

    await entry.session.ensureConnected();

    const fresh: TokenRef[] = [];
    for (const t of tokens) {
      const key = tokenKey(t);
      const prev = entry.refs.get(key) ?? 0;
      entry.refs.set(key, prev + 1);
      if (prev === 0 && !entry.pins.has(key)) {
        entry.tokenRefs.set(key, t);
        fresh.push(t);
      }
    }

    if (fresh.length > 0) {
      await entry.session.subscribe(fresh);
    }
  }

  /**
   * Drop the caller's interest in `tokens`. Only unsubscribes tokens whose ref
   * count hits 0; if the user has no live interest left, starts the idle timer.
   */
  async unsubscribe(userId: string, tokens: TokenRef[]): Promise<void> {
    const entry = this.registry.get(userId);
    if (!entry) return;

    entry.lastActive = Date.now();

    const dead: TokenRef[] = [];
    for (const t of tokens) {
      const key = tokenKey(t);
      const prev = entry.refs.get(key) ?? 0;
      if (prev <= 0) continue;
      const next = prev - 1;
      if (next === 0) {
        entry.refs.delete(key);
        const ref = entry.tokenRefs.get(key) ?? t;
        entry.tokenRefs.delete(key);
        if (!entry.pins.has(key)) dead.push(ref); // still pinned: the hub keeps it
      } else {
        entry.refs.set(key, next);
      }
    }

    if (dead.length > 0) {
      await entry.session.unsubscribe(dead);
    }

    if (this.totalRefs(entry) === 0) {
      this.startIdleTimer(userId, entry);
    }
  }

  /**
   * The user's socket disconnected: drop all of their live interest and start
   * (or keep) the idle timer. One socket per user is the target, so this zeroes
   * the user out.
   */
  releaseUser(userId: string): void {
    const entry = this.registry.get(userId);
    if (!entry) return;
    // Pins keep the session alive (no teardown), so browser-only tokens must
    // be unsubscribed here or they would stay subscribed forever.
    const browserOnly: TokenRef[] = [];
    if (entry.pins.size > 0) {
      for (const [key, ref] of entry.tokenRefs) {
        if (!entry.pins.has(key)) browserOnly.push(ref);
      }
    }
    entry.refs.clear();
    entry.tokenRefs.clear();
    entry.lastActive = Date.now();
    if (browserOnly.length > 0) {
      void Promise.resolve(entry.session.unsubscribe(browserOnly)).catch((err) =>
        this.logger.warn(
          `Failed to unsubscribe released tokens for ${userId}: ${
            err instanceof Error ? err.message : err
          }`,
        ),
      );
    }
    if (this.totalRefs(entry) === 0) this.startIdleTimer(userId, entry);
  }

  /**
   * Hold tokens for a long-lived in-process consumer (the market hub). Pins
   * share the user's ONE session — a second Angel login on the same client
   * code would kill this session's stream — and they survive releaseUser()
   * (a closed browser tab) and block idle teardown.
   */
  async pin(userId: string, tokens: TokenRef[]): Promise<void> {
    const entry = this.getOrCreateEntry(userId);
    this.clearIdleTimer(entry);
    entry.lastActive = Date.now();
    await entry.session.ensureConnected();
    const fresh: TokenRef[] = [];
    for (const t of tokens) {
      const key = tokenKey(t);
      if (entry.pins.has(key)) continue;
      entry.pins.set(key, t);
      if ((entry.refs.get(key) ?? 0) === 0) fresh.push(t);
    }
    if (fresh.length > 0) await entry.session.subscribe(fresh);
  }

  async unpin(userId: string, tokens: TokenRef[]): Promise<void> {
    const entry = this.registry.get(userId);
    if (!entry) return;
    const dead: TokenRef[] = [];
    for (const t of tokens) {
      const key = tokenKey(t);
      const pinned = entry.pins.get(key);
      if (!pinned) continue;
      entry.pins.delete(key);
      if ((entry.refs.get(key) ?? 0) === 0) dead.push(pinned);
    }
    if (dead.length > 0) await entry.session.unsubscribe(dead);
    if (this.totalRefs(entry) === 0) this.startIdleTimer(userId, entry);
  }

  /**
   * One-shot historical candle fetch over the user's OWN Angel session. Reuses
   * (or lazily creates) the user's session — the session's own ensureConnected
   * handles login. A fetch adds NO token ref, so an otherwise-idle session may
   * still idle-teardown later; the chart's separate subscribe() keeps it alive.
   */
  async fetchCandles(
    userId: string,
    token: string,
    exchange: string,
    timeframe: string,
    from: Date,
    to: Date,
  ) {
    const entry = this.getOrCreateEntry(userId);
    return entry.session.getCandles(token, exchange, timeframe, from, to);
  }

  /** One-shot FULL-mode quote over the user's OWN Angel session (null if unquotable). */
  async fetchQuote(userId: string, token: string, exchange: string) {
    const entry = this.getOrCreateEntry(userId);
    return entry.session.getQuote(token, exchange);
  }

  /**
   * Batched FULL-mode quotes over the user's OWN Angel session — ONE broker
   * call for all tokens. Used by the indices snapshot, which is polled every 5s
   * and must not spend the whole Angel rate-limit budget per refresh.
   */
  async fetchQuotes(userId: string, refs: TokenRef[], opts?: { throwOnThrottle?: boolean }) {
    const entry = this.getOrCreateEntry(userId);
    return entry.session.getQuotes(refs, opts);
  }

  // ──────────────────────────────────────────────
  // Private
  // ──────────────────────────────────────────────

  private getOrCreateEntry(userId: string): UserFeedEntry {
    const existing = this.registry.get(userId);
    if (existing) return existing;

    this.enforceCapacity();

    const session = this.factory(userId);
    // Wire the session's listeners to the global handlers, tagging userId. The
    // arrow reads `this.onTickHandler` lazily so handler-registration order
    // relative to subscribe() does not matter.
    session.onTick((tick) => {
      this.onTickHandler?.(userId, tick);
      for (const l of this.tickListeners) l(userId, tick);
    });
    session.onState((state) => {
      this.onStateHandler?.(userId, state);
      for (const l of this.stateListeners) l(userId, state);
    });

    const entry: UserFeedEntry = {
      session,
      refs: new Map(),
      tokenRefs: new Map(),
      pins: new Map(),
      idleTimer: null,
      lastActive: Date.now(),
    };
    this.registry.set(userId, entry);
    return entry;
  }

  /** Before creating a new session, evict the LRU idle one if we are at cap. */
  private enforceCapacity(): void {
    if (this.registry.size < this.opts.maxSessions) return;

    let lruUserId: string | null = null;
    let lruEntry: UserFeedEntry | null = null;
    for (const [userId, entry] of this.registry) {
      if (this.totalRefs(entry) > 0) continue; // has live interest — not evictable
      if (!lruEntry || entry.lastActive < lruEntry.lastActive) {
        lruUserId = userId;
        lruEntry = entry;
      }
    }

    if (lruUserId && lruEntry) {
      this.teardown(lruUserId, lruEntry);
      return;
    }

    // No idle session to evict — do NOT silently drop the request; warn and
    // proceed over cap so the user still gets a feed.
    this.logger.warn(
      `Session cap (${this.opts.maxSessions}) reached and all sessions are active; ` +
        `creating an additional session over cap.`,
    );
  }

  private totalRefs(entry: UserFeedEntry): number {
    let sum = entry.pins.size;
    for (const n of entry.refs.values()) sum += n;
    return sum;
  }

  private startIdleTimer(userId: string, entry: UserFeedEntry): void {
    this.clearIdleTimer(entry);
    entry.idleTimer = setTimeout(() => {
      const current = this.registry.get(userId);
      // Guard against a race where interest returned before the timer fired.
      if (!current || this.totalRefs(current) > 0) return;
      void this.teardown(userId, current);
    }, this.opts.idleMs);
  }

  private clearIdleTimer(entry: UserFeedEntry): void {
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
  }

  private teardown(userId: string, entry: UserFeedEntry): Promise<void> {
    this.clearIdleTimer(entry);
    this.registry.delete(userId);
    return Promise.resolve(entry.session.dispose()).catch((err) => {
      this.logger.warn(
        `Failed to dispose feed session for user ${userId}: ${
          err instanceof Error ? err.message : err
        }`,
      );
    });
  }
}
