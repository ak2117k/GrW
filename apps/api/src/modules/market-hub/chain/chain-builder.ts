import { istDay, istMidnight } from '../candles/trading-calendar';
import type { GovResult } from '../governor';
import type { InstrumentRef, Lane } from '../hub.types';
import { refKey } from '../hub.types';
import type { QuoteOutcome } from '../quote-batcher';
import type { ChainRepo } from './chain-repository';
import type { ChainContract, ChainUnavailable, HubChain, OptionGreekRow, OptionSide } from './chain.types';
import { assembleEntries, pickStrikes, type GreeksMath } from './chain-math';

const GREEKS_TTL_MS = 60_000;
const MAX_KEYS = 200;

export interface ChainBuilderDeps {
  repo: ChainRepo;
  quoteNow(refs: readonly InstrumentRef[], lane: Lane): Promise<Map<string, QuoteOutcome>>;
  greeks(name: string, expiry: string, lane: Lane): Promise<GovResult<OptionGreekRow[]>>;
  bookSpot(ref: InstrumentRef): number | null;
  math: GreeksMath;
  now?: () => number;
}

export type BuildOutcome = { kind: 'ok'; chain: HubChain } | { kind: 'unavailable'; reason: ChainUnavailable };

interface DayCached<T> {
  day: string;
  value: T;
}

/** Bounded map: drop everything when it grows past MAX_KEYS (keys are per underlying+expiry; a day has few). */
function boundedSet<K, V>(m: Map<K, V>, k: K, v: V): void {
  if (m.size >= MAX_KEYS && !m.has(k)) m.clear();
  m.set(k, v);
}

/**
 * Builds ONE chain: DB contracts → spot (PriceBook, else in the same quote call) → ±N strikes →
 * one batched FULL quote for every leg + one optionGreek (60 s cache) + the previous-session OI
 * baseline (per day) → HubChain. Never throws.
 */
export class ChainBuilder {
  private readonly contractCache = new Map<string, DayCached<ChainContract[]>>();
  private readonly expiryCache = new Map<string, DayCached<string[]>>();
  private readonly underlyingCache = new Map<string, DayCached<InstrumentRef | null>>();
  private readonly baselineCache = new Map<string, DayCached<Map<string, number>>>();
  private readonly greekCache = new Map<string, { at: number; rows: OptionGreekRow[] }>();
  private baselineFailuresCount = 0;

  constructor(private readonly d: ChainBuilderDeps) {}

  get baselineFailures(): number {
    return this.baselineFailuresCount;
  }

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  private today(): string {
    return istDay(this.now());
  }

  async contracts(underlying: string, expiry: string): Promise<ChainContract[]> {
    const key = `${underlying.toUpperCase()}:${expiry}`;
    const day = this.today();
    const hit = this.contractCache.get(key);
    if (hit && hit.day === day) return hit.value;
    const value = await this.d.repo.contracts(underlying.toUpperCase(), expiry);
    boundedSet(this.contractCache, key, { day, value });
    return value;
  }

  async expiries(underlying: string): Promise<string[]> {
    const u = underlying.toUpperCase();
    const day = this.today();
    const hit = this.expiryCache.get(u);
    if (hit && hit.day === day) return hit.value;
    const value = await this.d.repo.expiries(u, day);
    boundedSet(this.expiryCache, u, { day, value });
    return value;
  }

  async contractFor(underlying: string, expiry: string, strike: number, type: OptionSide): Promise<ChainContract | null> {
    const all = await this.contracts(underlying, expiry);
    return all.find((c) => c.optionType === type && Math.abs(c.strike - strike) < 0.01) ?? null;
  }

  async build(
    underlying: string,
    expiry: string,
    opts: { lane: Lane; strikesAround: number; hintSpot?: number | null },
  ): Promise<BuildOutcome> {
    const u = underlying.toUpperCase();
    try {
      const all = await this.contracts(u, expiry);
      if (all.length === 0) return { kind: 'unavailable', reason: 'no-contracts' };
      const exchange = all[0].ref.exchange;
      const uref = await this.underlyingRef(u, exchange, expiry);
      let spot = uref ? this.d.bookSpot(uref) : null;
      const picked = pickStrikes(all, spot ?? opts.hintSpot ?? null, opts.strikesAround);
      const refs = picked.map((c) => c.ref);
      if (spot === null && uref) refs.push(uref);

      const [quotes, greeks, baseline] = await Promise.all([
        this.d.quoteNow(refs, opts.lane),
        this.greeksFor(u, expiry, opts.lane),
        this.baselineFor(`${u}:${expiry}`, all),
      ]);

      const legOutcomes = picked.map((c) => quotes.get(refKey(c.ref)));
      if (!legOutcomes.some((o) => o?.kind === 'ok')) {
        const reason: ChainUnavailable = legOutcomes.some((o) => o?.kind === 'throttled')
          ? 'throttled'
          : legOutcomes.some((o) => o?.kind === 'busy')
            ? 'busy'
            : 'error';
        return { kind: 'unavailable', reason };
      }
      if (spot === null && uref) {
        const s = quotes.get(refKey(uref));
        spot = s?.kind === 'ok' && s.tick.ltp > 0 ? s.tick.ltp : null;
      }
      const at = this.now();
      const assembled = assembleEntries({
        contracts: picked,
        quotes,
        greeks,
        baseline,
        spot,
        expiry,
        exchange,
        now: at,
        math: this.d.math,
      });
      return {
        kind: 'ok',
        chain: { underlying: u, expiry, exchange, spot, at, greeks: assembled.greeks, entries: assembled.entries },
      };
    } catch {
      return { kind: 'unavailable', reason: 'error' };
    }
  }

  private async underlyingRef(u: string, exchange: InstrumentRef['exchange'], expiry: string): Promise<InstrumentRef | null> {
    const key = `${u}:${expiry}`;
    const day = this.today();
    const hit = this.underlyingCache.get(key);
    if (hit && hit.day === day) return hit.value;
    const value = await this.d.repo.underlyingRef(u, exchange, expiry);
    boundedSet(this.underlyingCache, key, { day, value });
    return value;
  }

  /**
   * Broker rows within 60 s, else one governed call. A failure is not cached (next build retries);
   * an empty answer IS cached (a real "none" — do not re-ask every build). No rows → null (local Greeks).
   */
  private async greeksFor(u: string, expiry: string, lane: Lane): Promise<OptionGreekRow[] | null> {
    const key = `${u}:${expiry}`;
    const hit = this.greekCache.get(key);
    if (hit && this.now() - hit.at < GREEKS_TTL_MS) return hit.rows.length ? hit.rows : null;
    const res = await this.d.greeks(u, expiry, lane);
    if (res.kind !== 'ok') return null;
    boundedSet(this.greekCache, key, { at: this.now(), rows: res.value });
    return res.value.length ? res.value : null;
  }

  /** Every contract of the expiry, once per IST day; a failure is not cached and gives "no baseline". */
  private async baselineFor(key: string, all: readonly ChainContract[]): Promise<Map<string, number>> {
    const day = this.today();
    const hit = this.baselineCache.get(key);
    if (hit && hit.day === day) return hit.value;
    try {
      const value = await this.d.repo.baseline(all.map((c) => c.instrumentId), new Date(istMidnight(day)));
      boundedSet(this.baselineCache, key, { day, value });
      return value;
    } catch {
      this.baselineFailuresCount++;
      return new Map();
    }
  }
}
