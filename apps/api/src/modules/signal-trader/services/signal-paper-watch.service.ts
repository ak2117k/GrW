import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { TradeExecutionService } from '../../trade-engine/services/trade-execution.service';
import { TradeRepository } from '../../trade-engine/repositories/trade.repository';
import { bootJobsEnabled } from '../../../common/utils/boot-jobs';
import { SignalTraderRepository } from '../repositories/signal-trader.repository';
import { decisionIdFromTags, horizonFromTags, paperExitDecision } from '../domain/paper';
import { aiCheck, aiDecisionOf } from '../domain/ai-check';
import type { PaperTradeRow } from '../repositories/signal-trader.repository';
import type { SignalTraderConfig } from '../domain/signal-trader.config';
import {
  SIGNAL_QUOTES,
  SIGNAL_SESSION_CLOCK,
  SIGNAL_TRADER_CONFIG,
  type QuotesLike,
  type SessionClockLike,
} from './signal-trader.service';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * SL / target exits for the PAPER (no funds) trades. The paper engine has none of its own (the open
 * paper refresher only marks option P&L, and each paper track runs its own exit poller), so this is
 * the minimal one for these tagged trades: every 30 s, a fresh LTP over the owner's own Angel feed
 * session (a quote, never an order), then paperExitDecision → TradeExecutionService.closeTrade with
 * the exit price and reason tag (the standard paper close: journal, charges, paper balance), else a
 * mark-to-market P&L on the row. Only trades whose strategy is TELEGRAM_SIGNAL_NO_FUNDS are touched.
 */
@Injectable()
export class SignalPaperWatchService {
  private readonly logger = new Logger(SignalPaperWatchService.name);
  private busy = false;

  constructor(
    @Inject(SIGNAL_TRADER_CONFIG) private readonly cfg: SignalTraderConfig,
    private readonly repo: SignalTraderRepository,
    private readonly exec: TradeExecutionService,
    private readonly trades: TradeRepository,
    @Inject(SIGNAL_SESSION_CLOCK) private readonly clock: SessionClockLike,
    @Inject(SIGNAL_QUOTES) private readonly quotes: QuotesLike,
  ) {}

  @Cron('*/30 * * * * *', { timeZone: 'Asia/Kolkata' })
  async tick(): Promise<void> {
    if (this.cfg.mode === 'off' || !bootJobsEnabled() || this.busy) return;
    this.busy = true;
    try {
      await this.sweep(new Date());
    } catch (err) {
      this.logger.warn(`[signal-paper] sweep failed: ${errText(err)}`);
    } finally {
      this.busy = false;
    }
  }

  async sweep(now: Date): Promise<{ checked: number; exited: number }> {
    const owner = this.cfg.ownerUserId;
    if (!owner) return { checked: 0, exited: 0 };
    const open = await this.repo.openPaperTrades();
    let exited = 0;
    for (const t of open) {
      const inst = t.instrument;
      if (!inst?.token || !inst.exchange) continue;
      let isOpen = false;
      let minutesToClose: number | null = null;
      try {
        isOpen = this.clock.isOpen(inst.exchange, now);
        minutesToClose = this.clock.minutesToClose(inst.exchange, now);
      } catch {
        isOpen = false;
      }
      if (!isOpen) continue;
      const ltp = await this.quotes.ltp(owner, inst.token, inst.exchange).catch(() => null);
      const d = paperExitDecision({
        side: t.side,
        ltp,
        sl: t.stoploss,
        target: t.target,
        product: t.positionType,
        minutesToClose,
        // A carried (BTST / POSITIONAL) trade: held overnight, closed on its contract's expiry day / at the hold limit.
        horizon: horizonFromTags(t.entryTags),
        entryTime: t.entryTime ?? t.createdAt,
        now,
        expiry: inst.expiry ?? null,
      });
      try {
        if (d.exit) {
          await this.exec.closeTrade(t.id, { exitReasonTag: d.tag, reason: d.reason, exitNotes: d.reason, exitPrice: d.price });
          exited += 1;
          this.logger.warn(`[signal-paper] closed paper ${inst.symbol} (${t.id}): ${d.reason}`);
          if (t.entryTags.includes('learn')) await this.scoreAi(t, d.price, d.tag, now);
        } else if (ltp !== null && ltp > 0 && t.entryPrice && t.entryPrice > 0) {
          const sign = String(t.side).toUpperCase() === 'BUY' ? 1 : -1;
          const pnl = sign * (ltp - t.entryPrice) * t.quantity;
          await this.trades.updateTrade(t.id, { pnl: r2(pnl), pnlPercent: r2(((sign * (ltp - t.entryPrice)) / t.entryPrice) * 100) });
        }
      } catch (err) {
        this.logger.warn(`[signal-paper] ${inst.symbol} (${t.id}): ${errText(err)}`);
      }
    }
    return { checked: open.length, exited };
  }

  /** Learning mode: the closed trade held against the judge's own call (never throws). */
  private async scoreAi(t: PaperTradeRow, exit: number, tag: string, now: Date): Promise<void> {
    const decisionId = decisionIdFromTags(t.entryTags);
    if (!decisionId) return;
    try {
      const judge = await this.repo.decisionJudge(decisionId);
      const check = aiCheck({ aiDecision: aiDecisionOf(judge), side: t.side, entry: t.entryPrice, exit, qty: t.quantity, exitTag: tag, at: now });
      await this.repo.recordAiCheck(decisionId, check);
      this.logger.log(`[signal-paper] AI check ${decisionId}: AI said ${check.aiDecision}, move ${check.movePct}% → ${check.correct === null ? 'not scored' : check.correct ? 'RIGHT' : 'WRONG'}`);
    } catch (err) {
      this.logger.warn(`[signal-paper] AI check for ${decisionId} failed: ${errText(err)}`);
    }
  }
}
