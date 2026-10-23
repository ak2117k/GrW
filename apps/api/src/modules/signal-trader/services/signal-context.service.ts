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
  async nearestLevels(underlying: string, kind: string, price: number, ownerUserId: string | null): Promise<{ support: number | null; resistance: number | null } | null> {
    if (!this.levels) return null;
    try {
      const st = await withTimeout(this.levels.structureFor(levelSymbolFor(underlying, kind), price, ownerUserId ?? undefined), BLOCK_TIMEOUT_MS);
      return { support: st.nearestSupport, resistance: st.nearestResistance };
    } catch (err) {
      this.logger.warn(`[signal-context] level book for ${underlying}: ${errText(err)}`);
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
