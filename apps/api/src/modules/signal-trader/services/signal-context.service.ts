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

/** A block that is either present with its source, or stated unavailable WITH the reason (never silent). */
export type CtxBlock = { status: 'present'; source: string; value: unknown } | { status: 'unavailable'; reason: string };

const BLOCK_TIMEOUT_MS = 8_000;
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
  ) {}

  async build(i: { underlying: string; kind: string; exchange: string; ownerUserId: string | null; now: Date; ltp?: number | null }): Promise<Record<string, CtxBlock>> {
    const sym = levelSymbolFor(i.underlying, i.kind);
    const [chain, market, structure, news, mbm] = await Promise.all([
      this.block('mbm_chain_snapshots', async () => {
        if (!this.chain) return null;
        const c = await this.chain.latestChain(i.underlying);
        return c ? { expiry: c.expiry, capturedAt: c.capturedAt.toISOString(), spot: c.spot, fut: c.fut ?? null, pcr: c.pcr, maxPain: c.maxPain, callWall: c.callWall, putWall: c.putWall } : null;
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
        if (!this.mbmVisible()) throw new Error('MBM is hidden from judges until the self-review clears it (MBM_PACKET / mbm.packet)');
        const inst = mbmInstrumentFor({ symbol: i.underlying, exchange: i.exchange === 'MCX' ? 'MCX' : 'NSE' }, this.mbmCfg.instruments);
        if (!inst) throw new Error(`${i.underlying} is not an MBM instrument`);
        const b = await this.mbm.behaviour(inst, i.now.getTime());
        return b.status === 'absent' ? null : b;
      }),
    ]);
    return { chain, market, structure, news, mbm };
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
