import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { MarketContextService } from '../../market-data/services/market-context.service';
import { MbmChainReader } from '../../mbm/services/mbm-chain-reader.service';
import { MbmClient } from '../../mbm/services/mbm-client.service';
import { MBM_CONFIG, type MbmConfig } from '../../mbm/mbm.config';
import { mbmInstrumentFor } from '../../mbm/domain/mbm-applies';
import { TUNING_READER, type TuningReader } from '../../self-review/tuning/tunables';
import { SentinelChartContextAdapter, levelCandidates } from '../../trade-sentinel/adapters/chart-context.adapter';
import type { LevelsSnapshot } from '../../signal-generator/services/signal-generator.service';
import { NEWS_SHIM, type NewsShim } from '../../trade-sentinel/services/context-packet.service';
import { MBM_PACKET_TUNABLE } from '../../trade-sentinel/services/context-packet.service';
import { UserFeedManager } from '../../market-data/services/user-feed-manager.service';
import { MarketDataRepository } from '../../market-data/repositories/market-data.repository';
import { atr14 } from '../domain/atr';
import { deriveEngineSl, type EngineSl } from '../domain/engine-sl';
import { deriveEngineTargets, type EngineTargets } from '../domain/engine-target';
import type { ResolvedContract } from '../domain/contract-resolver';
import type { SignalView } from '../domain/signal.types';
import { SignalTraderRepository } from '../repositories/signal-trader.repository';
import { noiseBlock, underlyingNoise } from '../domain/judge-noise';
import { deltaReading, type DeltaReading } from '../domain/option-delta';
import { noiseFromBars } from '../../exit-discipline/noise';
import { NOISE_LOOKBACK_MIN } from '../../exit-discipline/config';
import type { MinuteBar } from '../../exit-discipline/types';
import { INDEX_UNDERLYINGS } from '../../market-hub/underlying';
import { istYmd } from '../../mbm/domain/chain-snapshot';
import { MCX_CHAIN_LOOKBACK_DAYS, MCX_FUT_BAR_MAX_LAG_MS, chainBlockValue, mcxChainSnapshot, mcxExpiryOrder, mcxProxyParent, proxyExpiry, underlyingFutureFor, useProxy } from '../domain/mcx-chain';
import { classifyTrend, mergeTrendBars, TREND_MAX_BARS, type TrendBar } from '../domain/trend-tag';

/** Fewer hub bars than this today ⇒ the noise block asks the broker's 1-min history instead. */
const MIN_HUB_BARS = 15;
const istMidnight = (now: Date) => {
  const ist = now.getTime() + 5.5 * 3_600_000;
  return ist - (ist % 86_400_000) - 5.5 * 3_600_000;
};

/**
 * A block that is present with its source, stated unavailable WITH the reason (we failed to look / no data),
 * or not_applicable WITH the reason (absent BY DESIGN: the source does not cover this underlying, or the
 * owner withholds it). Never silent. The night review's INPUT_MISSING counts `unavailable`, not `not_applicable`.
 */
export type CtxBlock =
  | { status: 'present'; source: string; value: unknown }
  | { status: 'unavailable'; reason: string }
  | { status: 'not_applicable'; reason: string };

/** Thrown inside a block when its absence is by design (→ `not_applicable`), not a failure. */
class NotApplicable extends Error {}

const BLOCK_TIMEOUT_MS = 8_000;
/** The MCX chain block's source: the market hub's 3-minute OI capture (database reads only). */
const MCX_CHAIN_SOURCE = 'oi_snapshots (market hub 3-min OI capture, MCX)';
/** The trend tag is record only: it must never hold a signal up, so it gets a short box of its own. */
export const TREND_TIMEOUT_MS = 5_000;
/** candles_1m read for the trend: ~5 NSE sessions of 15m bars past weekends / a holiday (MCX needs ~2). */
const TREND_HUB_LOOKBACK_MS = 10 * 86_400_000;
/**
 * A cold level book is several historical windows (daily statics, 15m bars, the higher-TF trend)
 * through the owner's 350 ms-gated session, behind whatever else is fetching; 8 s timed out on
 * NIFTY / BANKNIFTY / MANKIND (prod 2026-10-27). The build keeps running and fills the cache.
 */
const STRUCTURE_TIMEOUT_MS = 25_000;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Index / MCX underlyings → the symbol the level book and news resolve. */
export function levelSymbolFor(underlying: string, kind: string): string {
  if (kind === 'EQ') return `${underlying}-EQ`;
  return underlying;
}

/**
 * The sentinel-style market context for a SIGNAL (no position yet), from the sentinel's own building
 * blocks: chain snapshot OI/PCR/walls (mbm_chain_snapshots), the 15m level book + context factors
 * (SentinelChartContextAdapter — trend lives in its factors), news (the sentinel's news shim), VIX +
 * breadth (MarketContextService) and the MBM expected move incl. the relative reading. MBM obeys the
 * owner's rule: it reaches a judge only when MBM_PACKET=on or the self-review tunable says so.
 * Every source is optional, time-boxed and fails to an `unavailable` block — never throws.
 */
@Injectable()
export class SignalContextService {
  private readonly logger = new Logger(SignalContextService.name);

  constructor(
    @Optional() private readonly chain?: MbmChainReader,
    @Optional() private readonly marketCtx?: MarketContextService,
    @Optional() private readonly levels?: SentinelChartContextAdapter,
    @Optional() @Inject(NEWS_SHIM) private readonly news?: NewsShim,
    @Optional() private readonly mbm?: MbmClient,
    @Optional() @Inject(MBM_CONFIG) private readonly mbmCfg?: MbmConfig,
    @Optional() @Inject(TUNING_READER) private readonly tuning?: TuningReader,
    @Optional() private readonly feeds?: UserFeedManager,
    @Optional() private readonly instruments?: MarketDataRepository,
    @Optional() private readonly repo?: SignalTraderRepository,
  ) {}

  /**
   * market.noise for the judge (domain/judge-noise): the underlying's 1-min / 5-min noise units from the
   * hub's candles_1m (the broker's 1-min history when the hub has under {@link MIN_HUB_BARS} bars today),
   * the contract's premium N1 from its own 1-min bars when they exist, the option's |delta| (chain / broker
   * greek, else the moneyness heuristic — named so on the block) and both stops' distances in those units.
   * Never throws: an `unavailable` block with the reason.
   */
  async noise(i: {
    signal: Pick<SignalView, 'underlying' | 'instrumentKind' | 'side' | 'strike'>;
    contract: ResolvedContract | null;
    price: number;
    planSl: number | null;
    cap: number | null;
    lotQty: number;
    spot: number | null;
    vix: number | null;
    ownerUserId: string | null;
    now: Date;
  }): Promise<CtxBlock> {
    return this.block('noise units (candles_1m / broker 1-min history; delta: chain / broker greeks / moneyness heuristic)', async () => {
      const s = i.signal;
      const kind = s.instrumentKind;
      const c = i.contract;
      if (!c) throw new Error('no resolved contract');
      const own = kind === 'EQ' || (kind === 'FUT' && c.exchange === 'MCX');
      const ref = own ? { exchange: c.exchange, token: c.token, symbol: c.tradingsymbol } : this.repo ? await this.repo.underlyingRef(s.underlying, c.exchange, i.now) : null;
      if (!ref) throw new Error(`no price line for the underlying ${s.underlying}`);
      const from = new Date(Math.max(i.now.getTime() - NOISE_LOOKBACK_MIN * 60_000, istMidnight(i.now)));
      const u = await this.minuteBars(ref, from, i.now, i.ownerUserId);
      const und = underlyingNoise(u.bars);
      const option = kind === 'CE' || kind === 'PE';
      const prem = option || (kind === 'FUT' && !own) ? await this.minuteBars({ exchange: c.exchange, token: c.token, symbol: c.tradingsymbol }, from, i.now, i.ownerUserId) : null;
      const pn = prem ? noiseFromBars(prem.bars) : null;
      let delta: DeltaReading | null = { abs: 1, source: 'linear (non-option: the contract moves 1:1 with its underlying)' };
      if (option) {
        const read = await this.optionDelta({ signal: s, contract: c, ownerUserId: i.ownerUserId, now: i.now }).catch(() => null);
        delta = deltaReading({ kind, read, readSource: 'chain / broker greek', spot: i.spot, strike: s.strike, expiry: c.expiry, now: i.now, vix: i.vix, index: s.underlying.toUpperCase() in INDEX_UNDERLYINGS });
      }
      return noiseBlock({
        side: s.side,
        price: i.price,
        planSl: i.planSl,
        cap: i.cap,
        lotQty: i.lotQty,
        tick: c.tickSize,
        delta,
        underlying: { ...und, symbol: ref.symbol, source: u.source },
        premium: pn ? { n1: Math.round(pn.n * 100) / 100, method: `${pn.method} (${prem?.source})`, bars: pn.bars } : null,
      });
    });
  }

  /**
   * market.trend (domain/trend-tag), RECORD ONLY — the underlying's 15m EMA20/EMA80 + MACD histogram
   * against the signal's direction. Database reads only (the hub's candles_1m rolled to 15m, older
   * history from the persisted `candles` 15m rows), never the broker; boxed at {@link TREND_TIMEOUT_MS}.
   * Too few bars ⇒ present with tag UNKNOWN; a failed read / timeout ⇒ `unavailable` with the reason.
   * The bar read is shared for the quarter-hour (the decision record and the judge packet both ask).
   */
  async trend(i: { signal: Pick<SignalView, 'underlying' | 'instrumentKind' | 'side'>; exchange: string; now: Date }): Promise<CtxBlock> {
    return this.block(
      'trend tag (15m EMA20/EMA80 + MACD histogram; candles_1m → 15m, candles 15m history)',
      async () => {
        if (!this.repo) return null;
        const s = i.signal;
        const ref = await this.repo.underlyingRef(s.underlying, i.exchange, i.now);
        if (!ref) throw new Error(`no price line for the underlying ${s.underlying}`);
        const { bars, source } = await this.trendBars(this.repo, ref, i.now);
        return classifyTrend({ kind: s.instrumentKind, side: s.side, bars, now: i.now, source });
      },
      TREND_TIMEOUT_MS,
    );
  }

  private readonly trendBarCache = new Map<string, Promise<{ bars: TrendBar[]; source: string }>>();

  private trendBars(repo: SignalTraderRepository, ref: { exchange: string; token: string; symbol: string }, now: Date): Promise<{ bars: TrendBar[]; source: string }> {
    const key = `${ref.exchange}:${ref.token}:${Math.floor(now.getTime() / (15 * 60_000))}`;
    const hit = this.trendBarCache.get(key);
    if (hit) return hit;
    const p = Promise.all([
      repo.hub15mBars(ref.exchange, ref.token, new Date(now.getTime() - TREND_HUB_LOOKBACK_MS), now),
      repo.stored15mBars(ref.exchange, ref.token, TREND_MAX_BARS, now).catch(() => [] as TrendBar[]),
    ]).then(([hub, older]) => ({
      bars: mergeTrendBars(older, hub, now),
      source: `candles_1m ${ref.symbol} → 15m (${hub.length} bars)${older.length ? ` + candles 15m (${older.length})` : ''}`,
    }));
    if (this.trendBarCache.size > 200) this.trendBarCache.clear();
    this.trendBarCache.set(key, p);
    p.catch(() => this.trendBarCache.delete(key));
    return p;
  }

  /** 1-min bars: the hub's candles_1m, else (too few today) the broker's 1-min history over the owner's session. */
  private async minuteBars(ref: { exchange: string; token: string; symbol: string }, from: Date, to: Date, ownerUserId: string | null): Promise<{ bars: MinuteBar[]; source: string }> {
    let hub: MinuteBar[] = [];
    if (this.repo) {
      try {
        hub = await withTimeout(this.repo.hubMinuteBars(ref.exchange, ref.token, from, to), BLOCK_TIMEOUT_MS);
      } catch (err) {
        this.logger.warn(`[signal-context] candles_1m ${ref.symbol}: ${errText(err)}`);
      }
    }
    if (hub.length >= MIN_HUB_BARS || !this.feeds || !ownerUserId) return { bars: hub, source: `candles_1m ${ref.symbol}` };
    try {
      const c = await withTimeout(this.feeds.fetchCandles(ownerUserId, ref.token, ref.exchange, '1m', from, to), BLOCK_TIMEOUT_MS);
      const bars = (c ?? []).map((b) => ({ ts: b.timestamp.getTime(), open: b.open, high: b.high, low: b.low, close: b.close }));
      return bars.length > hub.length ? { bars, source: `broker 1-min history ${ref.symbol}` } : { bars: hub, source: `candles_1m ${ref.symbol}` };
    } catch (err) {
      this.logger.warn(`[signal-context] broker 1-min ${ref.symbol}: ${errText(err)}`);
      return { bars: hub, source: `candles_1m ${ref.symbol}` };
    }
  }

  /** `expiry`: the traded contract's (YYYY-MM-DD), so an MCX chain reads that expiry's capture first. */
  async build(i: { underlying: string; kind: string; exchange: string; ownerUserId: string | null; now: Date; ltp?: number | null; expiry?: string | null }): Promise<Record<string, CtxBlock>> {
    const sym = levelSymbolFor(i.underlying, i.kind);
    const [chain, market, structure, news, mbm] = await Promise.all([
      // The chain capture (mbm-chain-capture) snapshots NFO index / stock chains only; an MCX chain is read
      // from the market hub's own 3-minute OI capture instead (mcxChain), in the same block shape.
      i.exchange === 'MCX'
        ? this.block(MCX_CHAIN_SOURCE, () => this.mcxChain(i))
        : this.block('mbm_chain_snapshots', async () => {
            if (!this.chain) return null;
            const c = await this.chain.latestChain(i.underlying);
            if (!c) throw new Error(`no snapshot for ${i.underlying} in the last 10 days`);
            // The newest snapshot can be days old (prod 2026-11-06: MCX's was 2 days, NYKAA's 9): ageMin says so.
            return chainBlockValue(c, i.now);
          }),
      this.block('market-context (VIX, breadth, chain aggregate)', async () => {
        if (!this.marketCtx) return null;
        const s = await this.marketCtx.snapshot(i.underlying);
        return { spot: s.spot, vix: s.vix, vixRegime: s.vixRegime, pcr: s.pcr, maxPain: s.maxPain, adRatio: s.adRatio, at: s.capturedAt.toISOString() };
      }),
      this.block(
        'signal-generator 15m level book + context factors (trend)',
        async () => {
          if (!this.levels) return null;
          // The nearest support / resistance need the UNDERLYING's price; this used to pass null,
          // so every packet said "price unavailable" even when the book was built.
          const own = i.kind === 'EQ' || (i.kind === 'FUT' && i.exchange === 'MCX');
          const { spot, source } = await this.underlyingSpot({ underlying: i.underlying, exchange: i.exchange, own, price: i.ltp ?? null, ownerUserId: i.ownerUserId, now: i.now });
          const owner = i.ownerUserId ?? undefined;
          const st = await this.levels.structureFor(sym, spot, owner);
          const book = await this.levels.levelsFor(sym, owner).catch(() => null);
          return { ...st, spot, spotSource: source || null, levels: book?.value ?? null };
        },
        STRUCTURE_TIMEOUT_MS,
      ),
      this.block('news (sentinel news shim)', async () => {
        if (!this.news) return null;
        const n = await this.news.recentFor(sym);
        return n?.value ?? null;
      }),
      this.block('mbm expected move (incl. relative reading)', async () => {
        if (!this.mbm || !this.mbmCfg) return null;
        const inst = mbmInstrumentFor({ symbol: i.underlying, exchange: i.exchange === 'MCX' ? 'MCX' : 'NSE' }, this.mbmCfg.instruments);
        if (!inst) throw new NotApplicable(`${i.underlying} is not an MBM instrument (MBM covers ${this.mbmCfg.instruments.join(', ')})`);
        if (!this.mbmVisible()) throw new NotApplicable('MBM is withheld from judges by the owner rule until the self-review clears it (MBM_PACKET=on / mbm.packet)');
        const b = await this.mbm.behaviour(inst, i.now.getTime());
        return b.status === 'absent' ? null : b;
      }),
    ]);
    return { chain, market, structure, news, mbm };
  }

  /**
   * An MCX commodity's option chain for the judge, from the DATABASE only, never the broker: the market
   * hub's OI snapshot job already quotes the core MCX chains (CRUDEOIL, NATURALGAS, GOLD, SILVER) and any
   * held / screen-viewed one every 3 minutes into oi_snapshots (OI, OI change vs the previous session, LTP).
   * Expiry: the traded one, else the nearest live one (the next on its expiry day). ATM centres on the
   * option's UNDERLYING FUTURE (the earliest future expiring on or after the option), priced from its
   * candles_1m close at the capture, else put-call parity from the capture itself. Same value shape as the
   * NSE block; `spot` is that future (MCX options settle to it), `fut` null. Throws the reason when it
   * cannot be built (the block turns that into `unavailable`). A mini / variant (CRUDEOILM, GOLDM, …;
   * domain/mcx-chain MCX_PROXY_PARENT) whose own capture is missing or older reads the parent's chain at
   * the nearest parent expiry on or after its own, labelled `proxyOf`.
   */
  private async mcxChain(i: { underlying: string; now: Date; expiry?: string | null }): Promise<unknown> {
    if (!this.repo) throw new Error('not wired: no signal-trader repository to read the hub OI capture');
    const name = i.underlying.toUpperCase();
    const today = istYmd(i.now);
    const todayStart = new Date(`${today}T00:00:00+05:30`);
    const since = new Date(i.now.getTime() - MCX_CHAIN_LOOKBACK_DAYS * 86_400_000);
    const [expiries, futures] = await Promise.all([this.repo.optionExpiries(name, todayStart), this.repo.mcxFutures(name, todayStart)]);
    const order = mcxExpiryOrder(expiries, today, i.expiry ?? null);
    const own = order.length > 0 ? await this.mcxCaptured(name, order, futures, since, i.now) : { ok: false as const, misses: ['no live MCX option expiry in the instrument master'] };

    // A mini / variant (CRUDEOILM, GOLDM, …): the hub captures its own chain only while held / viewed, so
    // when that capture is missing or older than the parent's, the parent's chain at the matching expiry is
    // read instead (database only, like the own read) and labelled proxyOf.
    const parent = mcxProxyParent(name);
    const miniExpiry = own.ok ? own.expiry : order[0] ?? null;
    let proxyMiss: string | null = null;
    if (parent && miniExpiry) {
      const [pExpiries, pFutures] = await Promise.all([this.repo.optionExpiries(parent, todayStart), this.repo.mcxFutures(parent, todayStart)]);
      const pExpiry = proxyExpiry(pExpiries, miniExpiry);
      if (!pExpiry) proxyMiss = `${parent} proxy: no ${parent} option expiry on or after ${miniExpiry}`;
      else {
        const p = await this.mcxCaptured(parent, [pExpiry], pFutures, since, i.now);
        if (!p.ok) proxyMiss = `${parent} proxy: ${p.misses.join('; ')}`;
        else if (useProxy(own.ok ? own.at : null, p.at)) return { ...p.value, proxyOf: parent };
      }
    } else if (parent) proxyMiss = `${parent} proxy: no ${name} option expiry to match`;
    if (own.ok) return own.value;
    throw new Error(
      `no usable hub OI capture of ${name}'s options (${own.misses.join('; ')}${proxyMiss ? `; ${proxyMiss}` : ''}); the hub captures its OI core list (HUB_OI_CORE_UNDERLYINGS + GOLD/SILVER) and held / screen-viewed chains only`,
    );
  }

  /** The first of `order`'s expiries with a usable hub capture of `name`'s options, as the block value. DB only. */
  private async mcxCaptured(
    name: string,
    order: readonly string[],
    futures: Array<{ exchange: string; token: string; symbol: string; expiry: string }>,
    since: Date,
    now: Date,
  ): Promise<{ ok: true; expiry: string; at: Date; value: Record<string, unknown> } | { ok: false; misses: string[] }> {
    const repo = this.repo as SignalTraderRepository;
    const misses: string[] = [];
    for (const expiry of order) {
      const contracts = await repo.optionContracts(name, expiry);
      if (contracts.length === 0) {
        misses.push(`${expiry}: no option contracts in the master`);
        continue;
      }
      const cap = await repo.latestOiCapture(contracts.map((c) => c.instrumentId), since);
      if (!cap) {
        misses.push(`${expiry}: no oi_snapshots capture in the last ${MCX_CHAIN_LOOKBACK_DAYS} days`);
        continue;
      }
      const fut = underlyingFutureFor(expiry, futures);
      let futBar: number | null = null;
      if (fut) {
        const bars = await repo.minuteCloses(fut.exchange, fut.token, new Date(cap.at.getTime() - MCX_FUT_BAR_MAX_LAG_MS), cap.at).catch(() => []);
        futBar = bars.length > 0 ? bars[bars.length - 1].close : null;
      }
      const r = mcxChainSnapshot({ underlying: name, expiry, capturedAt: cap.at, contracts, rows: cap.rows, futBar });
      if (!r.ok) {
        misses.push(`${expiry}: ${r.reason}`);
        continue;
      }
      return {
        ok: true,
        expiry,
        at: cap.at,
        value: {
          ...chainBlockValue({ ...r.row, fut: null }, now),
          exchange: 'MCX',
          underlyingFuture: fut?.symbol ?? null,
          spotSource: r.futSource === 'candles_1m' ? `candles_1m ${fut?.symbol ?? 'future'} at the capture` : 'put-call parity at the ATM strike of the capture',
          strikes: r.strikes,
        },
      };
    }
    return { ok: false, misses };
  }

  /** The level book's nearest support/resistance at `price` (engine SL source for FUT/EQ). */
  async nearestLevels(underlying: string, kind: string, price: number, ownerUserId: string | null): Promise<{ support: number | null; resistance: number | null; reason?: string } | null> {
    if (!this.levels) return null;
    try {
      const st = await withTimeout(this.levels.structureFor(levelSymbolFor(underlying, kind), price, ownerUserId ?? undefined), STRUCTURE_TIMEOUT_MS);
      return { support: st.nearestSupport, resistance: st.nearestResistance, reason: st.reason ?? undefined };
    } catch (err) {
      this.logger.warn(`[signal-context] level book for ${underlying}: ${errText(err)}`);
      return null;
    }
  }

  /**
   * Engine SL when the channel hides it (domain/engine-sl). I/O here, the rule there: the underlying's
   * spot (fresh chain snapshot ≤ 10 min, else the feed via market-context; EQ / MCX futures are their
   * own underlying), the level book at that spot, the option delta from the chain snapshot's greeks
   * (same expiry, ≤ 30 min old) and — futures only, when no level works — the contract's daily ATR(14).
   * Never throws: any failed read just drops to the next fallback.
   */
  async engineSl(i: {
    signal: Pick<SignalView, 'underlying' | 'instrumentKind' | 'side' | 'strike'>;
    contract: ResolvedContract;
    price: number;
    ownerUserId: string | null;
    now: Date;
    optionPct: number;
    bufferPct: number;
  }): Promise<EngineSl> {
    const s = i.signal;
    const kind = s.instrumentKind;
    const option = kind === 'CE' || kind === 'PE';
    const ownUnderlying = kind === 'EQ' || (kind === 'FUT' && i.contract.exchange === 'MCX');
    const { spot, source: spotSource } = await this.underlyingSpot({ underlying: s.underlying, exchange: i.contract.exchange, own: ownUnderlying, price: i.price, ownerUserId: i.ownerUserId, now: i.now });
    const delta = option && spot !== null ? await this.optionDelta({ signal: s, contract: i.contract, ownerUserId: i.ownerUserId, now: i.now }) : null;
    const lv = spot !== null ? await this.nearestLevels(s.underlying, kind, spot, i.ownerUserId) : null;
    const base = {
      kind,
      side: s.side,
      price: i.price,
      tick: i.contract.tickSize,
      spot,
      support: lv?.support ?? null,
      resistance: lv?.resistance ?? null,
      delta,
      atr: null as number | null,
      optionPct: i.optionPct,
      bufferPct: i.bufferPct,
    };
    // A fallback stop carries what it was missing, so the decision record says why (not just "no level").
    const diag = [
      spot === null ? 'no underlying price' : `spot ${spot} (${spotSource})`,
      spot === null ? null : lv === null ? 'level book unavailable' : `level book: ${lv.reason ?? `support ${lv.support ?? 'none'} / resistance ${lv.resistance ?? 'none'}`}`,
      option ? (delta === null ? 'no delta' : `delta ${Math.round(Math.abs(delta) * 100) / 100}`) : null,
    ]
      .filter(Boolean)
      .join('; ');
    const explain = (r: EngineSl): EngineSl => (r.method === 'level' || r.method === 'level_fut' || r.method === 'level_delta' ? r : { ...r, detail: `${r.detail} — ${diag}` } as EngineSl);
    const first = deriveEngineSl(base);
    if (first.sl !== null || kind !== 'FUT') return explain(first);
    // Futures with no usable level: 1 × the contract's own daily ATR(14).
    const atr = await this.dailyAtr(i.ownerUserId, i.contract, i.now);
    return explain(atr ? deriveEngineSl({ ...base, atr }) : first);
  }

  /**
   * Engine targets when the channel gives none (domain/engine-target). Same reads as the engine SL —
   * the underlying's spot, the option delta — plus every line of the level book and, from a chain
   * snapshot ≤ 30 min old, the call / put walls (OI's own obstacles). `sl` = the stop the plan uses.
   * Never throws: a failed read leaves fewer levels, and the rule falls back to R multiples.
   */
  async engineTargets(i: {
    signal: Pick<SignalView, 'underlying' | 'instrumentKind' | 'side' | 'strike'>;
    contract: ResolvedContract;
    price: number;
    sl: number | null;
    ownerUserId: string | null;
    now: Date;
  }): Promise<EngineTargets> {
    const s = i.signal;
    const kind = s.instrumentKind;
    const option = kind === 'CE' || kind === 'PE';
    const ownUnderlying = kind === 'EQ' || (kind === 'FUT' && i.contract.exchange === 'MCX');
    const { spot } = await this.underlyingSpot({ underlying: s.underlying, exchange: i.contract.exchange, own: ownUnderlying, price: i.price, ownerUserId: i.ownerUserId, now: i.now });
    const delta = option && spot !== null ? await this.optionDelta({ signal: s, contract: i.contract, ownerUserId: i.ownerUserId, now: i.now }) : null;
    const levels: number[] = [];
    if (spot !== null && this.levels) {
      try {
        const book = await withTimeout(this.levels.levelsFor(levelSymbolFor(s.underlying, kind), i.ownerUserId ?? undefined), STRUCTURE_TIMEOUT_MS);
        if (book?.value) levels.push(...levelCandidates(book.value as unknown as LevelsSnapshot));
      } catch (err) {
        this.logger.warn(`[signal-context] level book (targets) for ${s.underlying}: ${errText(err)}`);
      }
    }
    if (spot !== null && this.chain && !ownUnderlying) {
      try {
        const c = await withTimeout(this.chain.latestChain(s.underlying), BLOCK_TIMEOUT_MS);
        if (c && i.now.getTime() - c.capturedAt.getTime() <= 30 * 60_000) {
          for (const w of [c.callWall, c.putWall]) if (typeof w === 'number' && Number.isFinite(w)) levels.push(w);
        }
      } catch (err) {
        this.logger.warn(`[signal-context] chain walls (targets) for ${s.underlying}: ${errText(err)}`);
      }
    }
    return deriveEngineTargets({ kind, side: s.side, price: i.price, tick: i.contract.tickSize, spot, levels, delta, sl: i.sl });
  }

  /**
   * The option's delta (signed as read): a chain snapshot of the same expiry ≤ 30 min old, else the
   * broker's optionGreek for that expiry (NFO / BFO; MCX has none). null for a non-option. Never throws.
   */
  async optionDelta(i: { signal: Pick<SignalView, 'underlying' | 'instrumentKind' | 'strike'>; contract: ResolvedContract; ownerUserId: string | null; now: Date }): Promise<number | null> {
    const s = i.signal;
    const kind = s.instrumentKind;
    if ((kind !== 'CE' && kind !== 'PE') || s.strike === null) return null;
    if (this.chain) {
      try {
        const c = await withTimeout(this.chain.latestChain(s.underlying), BLOCK_TIMEOUT_MS);
        if (c && i.now.getTime() - c.capturedAt.getTime() <= 30 * 60_000 && c.expiry === i.contract.expiry) {
          const row = c.strikes.find((r) => Math.abs(r.strike - (s.strike as number)) < 1e-6);
          const leg = kind === 'CE' ? row?.ce : row?.pe;
          if (typeof leg?.delta === 'number' && Number.isFinite(leg.delta)) return leg.delta;
        }
      } catch (err) {
        this.logger.warn(`[signal-context] chain snapshot delta (${s.underlying}): ${errText(err)}`);
      }
    }
    if (i.contract.exchange === 'MCX' || !i.contract.expiry) return null;
    return this.brokerDelta(s.underlying, i.contract.expiry, s.strike, kind, i.ownerUserId);
  }

  /**
   * The underlying's price, one ladder for the engine SL and the judge's level book: the contract
   * itself (EQ, MCX future) → a chain snapshot ≤ 10 min → market-context's feed (NSE only; it timed
   * out on GOLD) → a quote of the underlying. Never throws; `source` is '' when nothing answered.
   */
  async underlyingSpot(i: { underlying: string; exchange: string; own: boolean; price: number | null; ownerUserId: string | null; now: Date }): Promise<{ spot: number | null; source: string }> {
    if (i.own) return i.price !== null && i.price > 0 ? { spot: i.price, source: 'contract' } : { spot: null, source: '' };
    if (this.chain) {
      try {
        const c = await withTimeout(this.chain.latestChain(i.underlying), BLOCK_TIMEOUT_MS);
        if (c && i.now.getTime() - c.capturedAt.getTime() <= 10 * 60_000 && c.spot > 0) return { spot: c.spot, source: 'chain' };
      } catch (err) {
        this.logger.warn(`[signal-context] chain snapshot spot (${i.underlying}): ${errText(err)}`);
      }
    }
    if (this.marketCtx && i.exchange !== 'MCX') {
      try {
        const snap = await withTimeout(this.marketCtx.snapshot(i.underlying), BLOCK_TIMEOUT_MS);
        if (typeof snap.spot === 'number' && snap.spot > 0) return { spot: snap.spot, source: 'feed' };
      } catch (err) {
        this.logger.warn(`[signal-context] feed spot (${i.underlying}): ${errText(err)}`);
      }
    }
    // The chain snapshots cover ~10 underlyings every ~15 min and the feed map only the indices
    // (prod 2026-10-26: BSE / COPPER / CRUDEOIL options had no spot → every SL fell to 25%).
    // Quote the underlying itself: the stock's cash line, the index, or an MCX option's nearest future.
    const q = await this.underlyingQuote(i.underlying, i.exchange, i.ownerUserId, i.now);
    return q !== null ? { spot: q, source: 'quote' } : { spot: null, source: '' };
  }

  /** LTP of the underlying itself: NSE cash (or the index) for an NSE derivative, the nearest future for MCX. Never throws. */
  private async underlyingQuote(underlying: string, exchange: string, ownerUserId: string | null, now: Date): Promise<number | null> {
    if (!this.feeds || !this.instruments || !ownerUserId) return null;
    try {
      const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const inst =
        exchange === 'MCX'
          ? await this.instruments.getNearestFuture(underlying, 'MCX', startOfDay)
          : ((await this.instruments.getInstrumentBySymbol(`${underlying}-EQ`, 'NSE')) ?? (await this.instruments.getInstrumentBySymbol(underlying, 'NSE')));
      if (!inst?.token) return null;
      const q = await withTimeout(this.feeds.fetchQuote(ownerUserId, inst.token, inst.exchange), BLOCK_TIMEOUT_MS);
      return q && Number.isFinite(q.ltp) && q.ltp > 0 ? q.ltp : null;
    } catch (err) {
      this.logger.warn(`[signal-context] underlying quote for engine SL (${underlying}): ${errText(err)}`);
      return null;
    }
  }

  /** |delta| of one strike from the broker's optionGreek for that expiry; null when unreadable. */
  private async brokerDelta(underlying: string, expiry: string, strike: number, side: 'CE' | 'PE', ownerUserId: string | null): Promise<number | null> {
    if (!this.feeds || !ownerUserId) return null;
    try {
      const rows = await withTimeout(this.feeds.fetchOptionGreeks(ownerUserId, underlying, expiry), BLOCK_TIMEOUT_MS);
      const row = (rows ?? []).find((r) => r.optionType === side && Math.abs(r.strike - strike) < 1e-6);
      return row && Number.isFinite(row.delta) ? row.delta : null;
    } catch (err) {
      this.logger.warn(`[signal-context] broker greeks for engine SL (${underlying} ${expiry}): ${errText(err)}`);
      return null;
    }
  }

  /** ATR(14) of the contract's daily bars over the owner's own session; null when unreadable. */
  private async dailyAtr(ownerUserId: string | null, c: ResolvedContract, now: Date): Promise<number | null> {
    if (!this.feeds || !ownerUserId) return null;
    try {
      const from = new Date(now.getTime() - 40 * 86_400_000);
      const bars = await withTimeout(this.feeds.fetchCandles(ownerUserId, c.token, c.exchange, '1d', from, now), BLOCK_TIMEOUT_MS);
      return atr14((bars ?? []).map((b) => ({ high: b.high, low: b.low, close: b.close })));
    } catch (err) {
      this.logger.warn(`[signal-context] daily ATR for ${c.tradingsymbol}: ${errText(err)}`);
      return null;
    }
  }

  private mbmVisible(): boolean {
    if (this.mbmCfg?.packet === 'on') return true;
    try {
      return this.tuning?.get<boolean>(MBM_PACKET_TUNABLE, false) === true;
    } catch {
      return false;
    }
  }

  private async block(source: string, fn: () => Promise<unknown>, timeoutMs = BLOCK_TIMEOUT_MS): Promise<CtxBlock> {
    try {
      const value = await withTimeout(fn(), timeoutMs);
      if (value === null || value === undefined) return { status: 'unavailable', reason: `${source}: nothing available (not wired, or no data)` };
      return { status: 'present', source, value };
    } catch (err) {
      if (err instanceof NotApplicable) return { status: 'not_applicable', reason: `${source}: ${err.message}` };
      return { status: 'unavailable', reason: `${source}: ${errText(err)}` };
    }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      t = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(t));
}

/** ATR(14) over daily bars — moved to domain/atr (the paper watch's carried noise uses it too). */
export { atr14 };
