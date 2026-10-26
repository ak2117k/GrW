import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { MarketContextService } from '../../market-data/services/market-context.service';
import { MbmChainReader } from '../../mbm/services/mbm-chain-reader.service';
import { MbmClient } from '../../mbm/services/mbm-client.service';
import { MBM_CONFIG, type MbmConfig } from '../../mbm/mbm.config';
import { mbmInstrumentFor } from '../../mbm/domain/mbm-applies';
import { TUNING_READER, type TuningReader } from '../../self-review/tuning/tunables';
import { SentinelChartContextAdapter } from '../../trade-sentinel/adapters/chart-context.adapter';
import { NEWS_SHIM, type NewsShim } from '../../trade-sentinel/services/context-packet.service';
import { MBM_PACKET_TUNABLE } from '../../trade-sentinel/services/context-packet.service';
import { UserFeedManager } from '../../market-data/services/user-feed-manager.service';
import { MarketDataRepository } from '../../market-data/repositories/market-data.repository';
import { deriveEngineSl, type EngineSl } from '../domain/engine-sl';
import type { ResolvedContract } from '../domain/contract-resolver';
import type { SignalView } from '../domain/signal.types';

/** A block that is either present with its source, or stated unavailable WITH the reason (never silent). */
export type CtxBlock = { status: 'present'; source: string; value: unknown } | { status: 'unavailable'; reason: string };

const BLOCK_TIMEOUT_MS = 8_000;
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

  async build(i: { underlying: string; kind: string; exchange: string; ownerUserId: string | null; now: Date }): Promise<Record<string, CtxBlock>> {
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
      this.block('signal-generator 15m level book + context factors (trend)', async () => {
        if (!this.levels) return null;
        const st = await this.levels.structureFor(sym, null, i.ownerUserId ?? undefined);
        return st;
      }),
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
      const st = await withTimeout(this.levels.structureFor(levelSymbolFor(underlying, kind), price, ownerUserId ?? undefined), BLOCK_TIMEOUT_MS);
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
    let spot: number | null = ownUnderlying ? i.price : null;
    let delta: number | null = null;
    if (!ownUnderlying && this.chain) {
      try {
        const c = await withTimeout(this.chain.latestChain(s.underlying), BLOCK_TIMEOUT_MS);
        const age = c ? i.now.getTime() - c.capturedAt.getTime() : Infinity;
        if (c && age <= 10 * 60_000 && c.spot > 0) spot = c.spot;
        if (c && option && age <= 30 * 60_000 && c.expiry === i.contract.expiry && s.strike !== null) {
          const row = c.strikes.find((r) => Math.abs(r.strike - (s.strike as number)) < 1e-6);
          const leg = kind === 'CE' ? row?.ce : row?.pe;
          delta = typeof leg?.delta === 'number' && Number.isFinite(leg.delta) ? leg.delta : null;
        }
      } catch (err) {
        this.logger.warn(`[signal-context] chain snapshot for engine SL (${s.underlying}): ${errText(err)}`);
      }
    }
    let spotSource = ownUnderlying ? 'contract' : spot !== null ? 'chain' : '';
    if (spot === null && !ownUnderlying && this.marketCtx) {
      try {
        const snap = await withTimeout(this.marketCtx.snapshot(s.underlying), BLOCK_TIMEOUT_MS);
        spot = typeof snap.spot === 'number' && snap.spot > 0 ? snap.spot : null;
        if (spot !== null) spotSource = 'feed';
      } catch (err) {
        this.logger.warn(`[signal-context] spot for engine SL (${s.underlying}): ${errText(err)}`);
      }
    }
    // The chain snapshots cover ~10 underlyings every ~15 min and the feed map only the indices
    // (prod 2026-10-26: BSE / COPPER / CRUDEOIL options had no spot → every SL fell to 25%).
    // Quote the underlying itself: the stock's cash line, or an MCX option's nearest future.
    if (spot === null && !ownUnderlying) {
      spot = await this.underlyingQuote(s.underlying, i.contract.exchange, i.ownerUserId, i.now);
      if (spot !== null) spotSource = 'quote';
    }
    // No greeks from a snapshot: the broker's own optionGreek for this expiry (NFO/BFO; MCX has none).
    if (option && delta === null && spot !== null && i.contract.exchange !== 'MCX' && i.contract.expiry && s.strike !== null) {
      delta = await this.brokerDelta(s.underlying, i.contract.expiry, s.strike, kind as 'CE' | 'PE', i.ownerUserId);
    }
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

  /** LTP of the underlying itself: NSE cash for a stock derivative, the nearest future for MCX. Never throws. */
  private async underlyingQuote(underlying: string, exchange: string, ownerUserId: string | null, now: Date): Promise<number | null> {
    if (!this.feeds || !this.instruments || !ownerUserId) return null;
    try {
      const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const inst =
        exchange === 'MCX'
          ? await this.instruments.getNearestFuture(underlying, 'MCX', startOfDay)
          : await this.instruments.getInstrumentBySymbol(`${underlying}-EQ`, 'NSE');
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

  private async block(source: string, fn: () => Promise<unknown>): Promise<CtxBlock> {
    try {
      const value = await withTimeout(fn(), BLOCK_TIMEOUT_MS);
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

/** Simple (unsmoothed) ATR(14) over daily bars (oldest first); null with fewer than 2 bars. */
export function atr14(bars: ReadonlyArray<{ high: number; low: number; close: number }>, n = 14): number | null {
  const ok = bars.filter((b) => [b.high, b.low, b.close].every((v) => typeof v === 'number' && Number.isFinite(v) && v > 0));
  if (ok.length < 2) return null;
  const tr: number[] = [];
  for (let k = 1; k < ok.length; k++) {
    const b = ok[k];
    const pc = ok[k - 1].close;
    tr.push(Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc)));
  }
  const last = tr.slice(-n);
  const v = last.reduce((a, x) => a + x, 0) / last.length;
  return v > 0 ? Math.round(v * 100) / 100 : null;
}
