import { Injectable, Logger } from '@nestjs/common';
import { TradeExecutionService } from '../../trade-engine/services/trade-execution.service';
import { TradeRepository } from '../../trade-engine/repositories/trade.repository';
import type { ExecuteTradeDto } from '../../trade-engine/dto/trade.dto';
import { MarketDataRepository } from '../../market-data/repositories/market-data.repository';
import { SignalTraderRepository, type PaperRecord } from '../repositories/signal-trader.repository';
import { SIGNAL_PAPER_SOURCE, SIGNAL_PAPER_STRATEGY, paperEntryReason, paperTags } from '../domain/paper';
import type { EntryPlan } from '../domain/gate';
import type { SignalView } from '../domain/signal.types';

export interface PaperOpenInput {
  decisionId: string;
  plan: EntryPlan;
  signal: Pick<SignalView, 'underlying' | 'instrumentKind' | 'strike' | 'horizon'>;
  /** Contract expiry YYYY-MM-DD (null for cash). */
  expiry: string | null;
  /** INTRADAY (squared off before the close) | DELIVERY / CARRYFORWARD (a carried BTST / POSITIONAL call). */
  product: 'INTRADAY' | 'DELIVERY' | 'CARRYFORWARD';
  channel: string;
  what: string;
  why: string;
  trigger: PaperRecord['trigger'];
}

export type PaperOpenResult = { ok: true; tradeId: string; entryPrice: number | null; duplicate: boolean } | { ok: false; reason: string };

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Opens the PAPER (no funds) trade through the app's existing paper path: TradeExecutionService.
 * executeTrade with isPaper:true (risk validation, PaperTradeService simulation, Trade row, journal,
 * paper balance and charges — exactly as every other paper track). Never a broker ORDER: the paper
 * branch of executeTrade only simulates. The entry is the signal's marketable LIMIT, simulated as an
 * immediate fill (order type MARKET with price = the limit, so the simulator fills at its cached LTP
 * or the limit; a paper LIMIT would wait for a WebSocket tick this contract may never get).
 * SL and T1 go on the Trade row; SignalPaperWatchService exits it at either.
 */
@Injectable()
export class SignalPaperService {
  private readonly logger = new Logger(SignalPaperService.name);

  constructor(
    private readonly repo: SignalTraderRepository,
    private readonly exec: TradeExecutionService,
    private readonly trades: TradeRepository,
    private readonly instruments: MarketDataRepository,
  ) {}

  async open(i: PaperOpenInput): Promise<PaperOpenResult> {
    const existing = await this.repo.paperTradeFor(i.decisionId);
    if (existing) return { ok: true, tradeId: existing.id, entryPrice: existing.entryPrice, duplicate: true };
    const at = () => new Date().toISOString();
    try {
      await this.ensureInstrument(i);
      const p = i.plan;
      const dto = {
        symbol: p.tradingsymbol,
        token: p.token,
        exchange: p.exchange,
        side: p.side,
        orderType: 'MARKET',
        quantity: p.qty,
        price: p.limitPrice,
        positionType: i.product,
        stoploss: p.sl,
        target: p.targets[0],
        entryReason: paperEntryReason({ decisionId: i.decisionId, channel: i.channel, what: i.what, plan: p, why: i.why }),
        entryTags: paperTags(i.decisionId, i.signal.horizon),
        strategy: SIGNAL_PAPER_STRATEGY,
        isPaper: true,
        source: SIGNAL_PAPER_SOURCE,
      } as unknown as ExecuteTradeDto;
      const trade = await this.exec.executeTrade(dto);
      const entryPrice = trade.entryPrice ?? null;
      await this.repo.recordPaper(i.decisionId, { status: trade.status === 'OPEN' ? 'OPEN' : 'PENDING', tradeId: trade.id, at: at(), trigger: i.trigger, entryPrice });
      this.logger.warn(`[signal-paper] PAPER ${p.side} ${p.tradingsymbol} x${p.qty} @ ${entryPrice ?? p.limitPrice} (decision ${i.decisionId}, trade ${trade.id})`);
      return { ok: true, tradeId: trade.id, entryPrice, duplicate: false };
    } catch (err) {
      const reason = errText(err);
      this.logger.warn(`[signal-paper] paper trade for decision ${i.decisionId} failed: ${reason}`);
      await this.repo.recordPaper(i.decisionId, { status: 'FAILED', tradeId: null, at: at(), trigger: i.trigger, reason }).catch(() => undefined);
      return { ok: false, reason };
    }
  }

  /** The Trade row needs an instruments row; derivatives may only be in the in-memory master. */
  private async ensureInstrument(i: PaperOpenInput): Promise<void> {
    const p = i.plan;
    if (await this.trades.findInstrumentId(p.tradingsymbol, p.exchange, p.token)) return;
    const kind = i.signal.instrumentKind;
    await this.instruments.upsertInstrument({
      symbol: p.tradingsymbol,
      token: p.token,
      name: i.signal.underlying,
      exchange: p.exchange,
      // Same convention as the instrument-master refresh: segment = the exchange segment.
      segment: p.exchange,
      lotSize: p.lotSize,
      tickSize: p.tickSize,
      expiry: i.expiry ? new Date(`${i.expiry}T00:00:00+05:30`) : undefined,
      strike: kind === 'CE' || kind === 'PE' ? (i.signal.strike ?? undefined) : undefined,
      optionType: kind === 'CE' || kind === 'PE' ? kind : undefined,
    });
  }
}
