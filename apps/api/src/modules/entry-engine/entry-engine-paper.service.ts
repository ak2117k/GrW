import { Injectable, Logger } from '@nestjs/common';
import { TradeExecutionService } from '../trade-engine/services/trade-execution.service';
import { TradeRepository } from '../trade-engine/repositories/trade.repository';
import type { ExecuteTradeDto } from '../trade-engine/dto/trade.dto';
import { MarketDataRepository } from '../market-data/repositories/market-data.repository';
import type { EntryPlan } from '../signal-trader/domain/gate';
import { decisionTag } from '../signal-trader/domain/paper';
import { ENGINE_ENTRY_SOURCE, ENGINE_ENTRY_STRATEGY, ENGINE_ENTRY_TAG, ENGINE_UNDERLYING_TAG } from './entry-engine.config';

export interface EnginePaperInput {
  decisionId: string;
  plan: EntryPlan;
  underlying: string;
  kind: 'CE' | 'PE';
  strike: number;
  /** Contract expiry YYYY-MM-DD. */
  expiry: string;
  why: string;
}

export type EnginePaperResult = { ok: true; tradeId: string; entryPrice: number | null } | { ok: false; reason: string };

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The engine paper trade's tags: the engine, its decision (the paper watch's `decision:` convention), its underlying. */
export function enginePaperTags(decisionId: string, underlying: string): string[] {
  return [ENGINE_ENTRY_TAG, decisionTag(decisionId), `${ENGINE_UNDERLYING_TAG}${underlying.toUpperCase()}`];
}

/** The ExecuteTradeDto of an engine paper entry. ALWAYS isPaper: true. Pure. */
export function enginePaperDto(i: EnginePaperInput): ExecuteTradeDto {
  const p = i.plan;
  return {
    symbol: p.tradingsymbol,
    token: p.token,
    exchange: p.exchange,
    side: p.side,
    // Simulated as an immediate fill (a paper LIMIT would wait for a tick the contract may never get).
    orderType: 'MARKET',
    quantity: p.qty,
    // The fill base is the LTP the plan read, never the marketable limit (c6fc825).
    price: p.ltp > 0 ? p.ltp : p.limitPrice,
    positionType: 'INTRADAY',
    stoploss: p.sl > 0 ? p.sl : undefined,
    target: p.targets[0],
    entryReason: `Entry engine (decision ${i.decisionId}): BUY ${i.underlying} ${i.strike} ${i.kind} ${i.expiry} @ ${p.ltp}, SL ${p.sl}, T1 ${p.targets[0] ?? '—'}. ${i.why}`.slice(0, 2000),
    entryTags: enginePaperTags(i.decisionId, i.underlying),
    strategy: ENGINE_ENTRY_STRATEGY,
    isPaper: true,
    source: ENGINE_ENTRY_SOURCE,
  } as unknown as ExecuteTradeDto;
}

/**
 * Opens the engine's PAPER trade through the app's standard paper path — exactly the path a Telegram
 * paper trade takes (SignalPaperService): TradeExecutionService.executeTrade with isPaper: true (risk
 * validation, PaperTradeService simulation, Trade row, journal, paper balance and charges). Never a
 * broker order: the paper branch of executeTrade only simulates, and this file builds no order.
 */
@Injectable()
export class EntryEnginePaperService {
  private readonly logger = new Logger(EntryEnginePaperService.name);

  constructor(
    private readonly exec: TradeExecutionService,
    private readonly trades: TradeRepository,
    private readonly instruments: MarketDataRepository,
  ) {}

  async open(i: EnginePaperInput): Promise<EnginePaperResult> {
    try {
      await this.ensureInstrument(i);
      const dto = enginePaperDto(i);
      if ((dto as { isPaper?: boolean }).isPaper !== true) throw new Error('engine entries are paper only');
      const trade = await this.exec.executeTrade(dto);
      this.logger.warn(`[entry-engine] PAPER BUY ${i.plan.tradingsymbol} x${i.plan.qty} @ ${trade.entryPrice ?? i.plan.ltp} (decision ${i.decisionId}, trade ${trade.id})`);
      return { ok: true, tradeId: trade.id, entryPrice: trade.entryPrice ?? null };
    } catch (err) {
      const reason = errText(err);
      this.logger.warn(`[entry-engine] paper trade for decision ${i.decisionId} failed: ${reason}`);
      return { ok: false, reason };
    }
  }

  /** The Trade row needs an instruments row; an option may only be in the in-memory master. */
  private async ensureInstrument(i: EnginePaperInput): Promise<void> {
    const p = i.plan;
    if (await this.trades.findInstrumentId(p.tradingsymbol, p.exchange, p.token)) return;
    await this.instruments.upsertInstrument({
      symbol: p.tradingsymbol,
      token: p.token,
      name: i.underlying.toUpperCase(),
      exchange: p.exchange,
      segment: p.exchange,
      lotSize: p.lotSize,
      tickSize: p.tickSize,
      expiry: new Date(`${i.expiry}T00:00:00+05:30`),
      strike: i.strike,
      optionType: i.kind,
    });
  }
}
