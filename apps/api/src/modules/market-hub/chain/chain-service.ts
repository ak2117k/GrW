import { istDay } from '../candles/trading-calendar';
import type { SessionClock } from '../session-clock';
import { LANE, refKey, type HubExchange, type InstrumentRef, type Lane, type PriceResult } from '../hub.types';
import type { QuoteOutcome } from '../quote-batcher';
import type { BuildOutcome, ChainBuilder } from './chain-builder';
import type { ChainRepo } from './chain-repository';
import type { ChainRequest, ChainResult, ChainStatus, ChainUnavailable, HubChain, HubChains, OptionSide } from './chain.types';
import { OiSnapshotJob, type SnapshotTarget } from './oi-snapshot-job';

export const CHAIN_FRESH_MS = 15_000;
export const CHAIN_REFRESH_MS = 10_000;
export const SCREEN_WATCH_MS = 120_000;
/**
 * An awaiting caller's deadline. The Governor only gives the Interactive lane a deadline, and a caller
 * that joins an in-flight Routine refresh build would otherwise wait as long as that build takes.
 */
export const CHAIN_AWAIT_DEADLINE_MS = 5_000;
/** A failing closed-market one-off build is not retried for this long, per chain. */
export const CLOSED_FAILURE_MEMO_MS = 5 * 60_000;
const MAX_CACHE = 100;
const BUILD_SAMPLES = 200;
/** The OI snapshot job's tick; the job itself runs each target every 3 minutes (OI_SNAPSHOT_EVERY_MS). */
const SNAPSHOT_TICK_MS = 30_000;
const REASONS: ChainUnavailable[] = ['no-contracts', 'throttled', 'busy', 'no-session', 'error'];

export interface ChainServiceDeps {
  builder: Pick<ChainBuilder, 'contracts' | 'expiries' | 'contractFor' | 'build' | 'baselineFailures'>;
  repo: ChainRepo;
  clock: Pick<SessionClock, 'isOpen'>;
  strikesAround: number;
  watchContract(ref: InstrumentRef): void;
  priceOf(ref: InstrumentRef): PriceResult;
  quoteNow(refs: readonly InstrumentRef[], lane: Lane): Promise<Map<string, QuoteOutcome>>;
  /** Whether held chains get the 10 s refresh (only while a consumer reads them: HUB_SERVES_CHAIN). Default true. */
  refreshHeld?: () => boolean;
  /**
   * OI snapshots for these always-on underlyings (+ held + viewed today). Absent ⇒ the job is off.
   * Held chains are targets whatever refreshHeld() says: snapshots run with HUB_SERVES_CHAIN off.
   */
  snapshots?: { core: readonly string[] };
  /** Cache capacity (LRU); default 100. */
  maxCache?: number;
  log?: (message: string) => void;
  now?: () => number;
}

const keyOf = (u: string, e: string) => `${u.toUpperCase()}:${e}`;
const splitKey = (k: string): [string, string] => {
  const i = k.lastIndexOf(':');
  return [k.slice(0, i), k.slice(i + 1)];
};

/**
 * The hub's option chains (spec §3): a 15 s cache, merged builds, a 10 s Routine refresh for chains a
 * screen or a held position watches, the closed-market rule (latest snapshot, labelled), and the
 * stale/unavailable fallbacks. Never throws to a caller.
 */
export class ChainService implements HubChains {
  private readonly cache = new Map<string, HubChain>();
  private readonly inflight = new Map<string, Promise<BuildOutcome>>();
  private readonly screenWatch = new Map<string, number>();
  private held = new Set<string>();
  private heldGeneration = 0;
  private readonly closedFailures = new Map<string, { until: number; reason: ChainUnavailable }>();
  private viewed = { day: '', keys: new Set<string>() };
  private readonly warned = new Set<string>();
  private readonly buildMs: number[] = [];
  private builds = 0;
  private cacheHits = 0;
  private greeksLocal = 0;
  private readonly unavailable = Object.fromEntries(REASONS.map((r) => [r, 0])) as Record<ChainUnavailable, number>;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly job: OiSnapshotJob | null;
  private jobTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly d: ChainServiceDeps) {
    this.job = d.snapshots
      ? new OiSnapshotJob({
          targets: (now) => this.snapshotTargets(now),
          contracts: (u, e) => this.d.builder.contracts(u, e),
          freshChain: (u, e) => this.freshChain(u, e),
          repo: d.repo,
          clock: d.clock,
          log: d.log,
        })
      : null;
  }

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  start(): void {
    if (!this.timer) {
      this.timer = setInterval(() => void this.refreshTick(this.now()), CHAIN_REFRESH_MS);
      this.timer.unref?.();
    }
    if (this.job && !this.jobTimer) {
      this.jobTimer = setInterval(() => void this.job?.tick(this.now()), SNAPSHOT_TICK_MS);
      this.jobTimer.unref?.();
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.jobTimer) clearInterval(this.jobTimer);
    this.jobTimer = null;
  }

  async chain(underlying: string, expiry: string, opts: ChainRequest = {}): Promise<ChainResult> {
    const u = underlying.toUpperCase();
    const key = keyOf(u, expiry);
    const now = this.now();
    if (opts.screen) {
      this.screenWatch.set(key, now + SCREEN_WATCH_MS);
      this.markViewed(key, now);
    }
    const exchange = await this.venue(u, expiry);
    if (exchange === 'error') return this.fail(key, 'error');
    if (!exchange) return this.fail(key, 'no-contracts');
    const cached = this.cache.get(key);

    if (!this.d.clock.isOpen(exchange, new Date(now))) return this.closed(key, u, expiry, exchange, cached);

    if (cached && now - cached.at <= CHAIN_FRESH_MS) {
      this.cacheHits++;
      this.touch(key, cached);
      return { kind: 'fresh', chain: cached };
    }
    const { out } = await this.awaitBuild(key, u, expiry);
    if (out.kind === 'ok') return { kind: 'fresh', chain: out.chain };
    // Only today's chain is served as stale (a cached chain from yesterday is not "stale", it is old).
    const cachedToday = cached && istDay(cached.at) === istDay(now) ? cached : null;
    const prior = cachedToday ?? (await this.snapshotToday(u, expiry, exchange, now));
    if (prior) return { kind: 'stale', chain: prior, ageMs: now - prior.at };
    return { kind: 'unavailable', reason: out.reason }; // counted and logged by build()
  }

  async expiries(underlying: string): Promise<string[]> {
    try {
      return await this.d.builder.expiries(underlying);
    } catch (err) {
      this.warnOnce(`expiries:${underlying}`, `expiries for ${underlying} failed: ${(err as Error)?.message ?? err}`);
      return [];
    }
  }

  async optionLtp(underlying: string, expiry: string, strike: number, type: OptionSide): Promise<number | null> {
    try {
      const c = await this.d.builder.contractFor(underlying, expiry, strike, type);
      if (!c) return null;
      this.d.watchContract(c.ref);
      const r = this.d.priceOf(c.ref);
      if ((r.kind === 'fresh' || r.kind === 'market-closed') && r.price.ltp > 0) return r.price.ltp;
      const q = (await this.d.quoteNow([c.ref], LANE.INTERACTIVE)).get(refKey(c.ref));
      return q?.kind === 'ok' && q.tick.ltp > 0 ? q.tick.ltp : null;
    } catch {
      return null;
    }
  }

  /** Held option contracts → their chains (held expiry + the underlying's nearest), refreshed while held. */
  async setHeld(refs: readonly InstrumentRef[]): Promise<void> {
    const generation = ++this.heldGeneration;
    try {
      const info = await this.d.repo.describe(refs);
      const next = new Set<string>();
      for (const { name, expiry } of info) {
        next.add(keyOf(name, expiry));
        const nearest = (await this.expiries(name))[0];
        if (nearest) next.add(keyOf(name, nearest));
      }
      // Overlapping calls can finish out of order: only the latest may assign.
      if (generation === this.heldGeneration) this.held = next;
    } catch (err) {
      this.warnOnce('held', `held-chain lookup failed: ${(err as Error)?.message ?? err}`);
    }
  }

  heldKeys(): string[] {
    return [...this.held];
  }

  viewedKeys(now: number = this.now()): string[] {
    return this.viewed.day === istDay(now) ? [...this.viewed.keys] : [];
  }

  /** Rebuild (Routine lane) every watched chain whose venue is open and whose cache is ≥ 10 s old. */
  async refreshTick(now: number): Promise<void> {
    for (const [k, until] of this.screenWatch) if (until <= now) this.screenWatch.delete(k);
    const refreshHeld = this.d.refreshHeld?.() ?? true;
    const keys = new Set([...this.screenWatch.keys(), ...(refreshHeld ? this.held : [])]);
    await Promise.all(
      [...keys].map(async (key) => {
        const [u, e] = splitKey(key);
        const exchange = await this.venue(u, e);
        if (!exchange || exchange === 'error' || !this.d.clock.isOpen(exchange, new Date(now))) return;
        const c = this.cache.get(key);
        if (c && now - c.at < CHAIN_REFRESH_MS) return;
        await this.build(key, u, e, LANE.ROUTINE);
      }),
    );
  }

  /** A chain built within the last 10 s, else one Routine build; null when it cannot be built. */
  async freshChain(underlying: string, expiry: string): Promise<HubChain | null> {
    const key = keyOf(underlying, expiry);
    const c = this.cache.get(key);
    if (c && this.now() - c.at < CHAIN_REFRESH_MS) {
      this.touch(key, c);
      return c;
    }
    const out = await this.build(key, underlying.toUpperCase(), expiry, LANE.ROUTINE);
    return out.kind === 'ok' ? out.chain : null;
  }

  /** Core list (nearest expiry) ∪ held chains ∪ chains a screen opened today. */
  async snapshotTargets(now: number): Promise<SnapshotTarget[]> {
    const keys = new Set<string>([...this.held, ...this.viewedKeys(now)]);
    for (const name of this.d.snapshots?.core ?? []) {
      const nearest = (await this.expiries(name))[0];
      if (nearest) keys.add(keyOf(name, nearest));
    }
    return [...keys].map((k) => {
      const [underlying, expiry] = splitKey(k);
      return { underlying, expiry };
    });
  }

  pruneOi(before: Date): Promise<number> {
    return this.d.repo.pruneOi(before);
  }

  status(): ChainStatus {
    const sorted = [...this.buildMs].sort((a, b) => a - b);
    return {
      builds: this.builds,
      buildP95Ms: sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)] : 0,
      cacheHits: this.cacheHits,
      greeksLocal: this.greeksLocal,
      unavailable: { ...this.unavailable },
      baselineFailures: this.d.builder.baselineFailures,
      watched: this.screenWatch.size,
      held: this.held.size,
      viewedToday: this.viewedKeys().length,
      snapshot: this.job
        ? { enabled: true, ...this.job.status(this.now()) }
        : { enabled: false, rowsToday: 0, failures: 0, lastAt: {} },
    };
  }

  /** The chain's venue from its contracts; null = no contracts; 'error' = the lookup failed. */
  private async venue(u: string, e: string): Promise<HubExchange | null | 'error'> {
    try {
      const cs = await this.d.builder.contracts(u, e);
      return cs.length ? cs[0].ref.exchange : null;
    } catch {
      return 'error';
    }
  }

  private async closed(key: string, u: string, e: string, exchange: HubExchange, cached: HubChain | undefined): Promise<ChainResult> {
    if (cached) {
      this.touch(key, cached);
      return { kind: 'market-closed', chain: cached };
    }
    const snap = await this.d.repo.latestChainSnapshot(u, e, exchange).catch(() => null);
    if (snap) {
      this.remember(key, snap);
      return { kind: 'market-closed', chain: snap };
    }
    // A failing one-off build is memoised: no broker build per request while closed and failing.
    const now = this.now();
    const memo = this.closedFailures.get(key);
    if (memo && now < memo.until) return { kind: 'unavailable', reason: memo.reason };
    if (memo) this.closedFailures.delete(key);
    // Ruling 4: no snapshot yet (first evening after deploy) → build once and store it.
    const { out, timedOut } = await this.awaitBuild(key, u, e);
    if (out.kind !== 'ok') {
      // A deadline miss is not a failure: the shared build keeps running and caches its result.
      if (!timedOut) {
        if (this.closedFailures.size >= MAX_CACHE) this.closedFailures.clear();
        this.closedFailures.set(key, { until: now + CLOSED_FAILURE_MEMO_MS, reason: out.reason });
      }
      return { kind: 'unavailable', reason: out.reason };
    }
    void this.d.repo.writeChainSnapshot(out.chain).catch((err) => this.warnOnce(`snap:${key}`, `closed-market snapshot write failed for ${key}: ${(err as Error)?.message ?? err}`));
    return { kind: 'market-closed', chain: out.chain };
  }

  private async snapshotToday(u: string, e: string, exchange: HubExchange, now: number): Promise<HubChain | null> {
    const snap = await this.d.repo.latestChainSnapshot(u, e, exchange).catch(() => null);
    return snap && istDay(snap.at) === istDay(now) ? snap : null;
  }

  private build(key: string, u: string, e: string, lane: Lane): Promise<BuildOutcome> {
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const started = this.now();
    const hintSpot = this.cache.get(key)?.spot ?? null;
    const p = this.d.builder
      .build(u, e, { lane, strikesAround: this.d.strikesAround, hintSpot })
      .then((out) => {
        if (out.kind === 'ok') {
          this.builds++;
          this.buildMs.push(this.now() - started);
          if (this.buildMs.length > BUILD_SAMPLES) this.buildMs.shift();
          if (out.chain.greeks === 'local') {
            this.greeksLocal++;
            this.warnOnce(`greeks:${key}`, `optionGreek unavailable for ${key}; Greeks computed locally from LTP`);
          }
          this.remember(key, out.chain);
        } else {
          // Every failed build counts once, whether the caller then gets stale, a snapshot or nothing.
          this.unavailable[out.reason]++;
          this.warnOnce(`${key}:${out.reason}`, `option chain ${key} build failed: ${out.reason}`);
        }
        return out;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  /**
   * An awaiting caller's build (Interactive lane) raced against CHAIN_AWAIT_DEADLINE_MS. It may join
   * an in-flight Routine build, which has no Governor deadline. On timeout this caller gets `busy`
   * (counted once); the shared build keeps running and caches its result.
   */
  private async awaitBuild(key: string, u: string, e: string): Promise<{ out: BuildOutcome; timedOut: boolean }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<null>((res) => {
      timer = setTimeout(() => res(null), CHAIN_AWAIT_DEADLINE_MS);
      timer.unref?.();
    });
    try {
      const out = await Promise.race([this.build(key, u, e, LANE.INTERACTIVE), deadline]);
      if (out) return { out, timedOut: false };
      this.unavailable.busy++;
      this.warnOnce(`${key}:deadline`, `option chain ${key}: no build within ${CHAIN_AWAIT_DEADLINE_MS} ms; caller served busy`);
      return { out: { kind: 'unavailable', reason: 'busy' }, timedOut: true };
    } finally {
      clearTimeout(timer);
    }
  }

  /** LRU: a read moves the key to the most-recent end. */
  private touch(key: string, chain: HubChain): void {
    this.cache.delete(key);
    this.cache.set(key, chain);
  }

  private remember(key: string, chain: HubChain): void {
    this.cache.delete(key);
    if (this.cache.size >= (this.d.maxCache ?? MAX_CACHE)) {
      const leastRecent = this.cache.keys().next().value as string;
      this.cache.delete(leastRecent);
    }
    this.cache.set(key, chain);
  }

  /** Venue-level failures (no contracts, contract lookup error), where no build was attempted. */
  private fail(key: string, reason: ChainUnavailable): ChainResult {
    this.unavailable[reason]++;
    if (reason !== 'no-contracts') this.warnOnce(`${key}:${reason}`, `option chain ${key} unavailable: ${reason}`);
    return { kind: 'unavailable', reason };
  }

  private markViewed(key: string, now: number): void {
    const day = istDay(now);
    if (this.viewed.day !== day) this.viewed = { day, keys: new Set() };
    this.viewed.keys.add(key);
  }

  /** Once per message key per IST day (spec §5: never silent, never a log storm). */
  private warnOnce(key: string, message: string): void {
    const k = `${istDay(this.now())}|${key}`;
    if (this.warned.has(k)) return;
    if (this.warned.size > 1000) this.warned.clear();
    this.warned.add(k);
    this.d.log?.(message);
  }
}
