import { Controller, Get, HttpCode, HttpStatus, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { WatchStatus } from '@prisma/client';
import { AdaptiveStopWatchRepository } from '../repositories/adaptive-stop-watch.repository';
import { AdaptiveStopTradeRepository } from '../repositories/adaptive-stop-trade.repository';
import { AdaptiveStopAccountService } from '../services/adaptive-stop-account.service';
import { AdaptiveStopComparisonService } from '../services/adaptive-stop-comparison.service';
import { AdaptiveStopTickPoller } from '../services/adaptive-stop-tick-poller.service';
import { AngelOneAdapterService } from '../../market-data/services/angel-one-adapter.service';
import { AdminOnly } from '../../../common/decorators';

@AdminOnly()
@ApiTags('Adaptive-Stop Track (A/B experiment)')
@Controller('api/adaptive-stop')
export class AdaptiveStopController {
  constructor(
    private readonly watchRepo: AdaptiveStopWatchRepository,
    private readonly tradeRepo: AdaptiveStopTradeRepository,
    private readonly _account: AdaptiveStopAccountService,
    private readonly _comparison: AdaptiveStopComparisonService,
    private readonly poller: AdaptiveStopTickPoller,
    private readonly adapter: AngelOneAdapterService,
  ) {}

  /**
   * Manual square-off — flatten every TRADED adaptive position on demand,
   * running the same logic as the 15:15 IST cron. Useful when the timer was
   * missed (e.g. a mid-window restart) or the feed recovered late.
   */
  @Post('square-off')
  @HttpCode(HttpStatus.OK)
  async squareOff() {
    return this.poller.eodSquareOff();
  }

  @Get('watch/:id')
  async get(@Param('id') id: string) {
    const entry = await this.watchRepo.findByIdWithEvents(id);
    if (!entry) throw new NotFoundException(`AdaptiveStopWatchEntry ${id} not found`);
    const r = entry.paperTradeId
      ? (await this.tradeRepo.findRealization([entry.paperTradeId])).get(entry.paperTradeId)
      : undefined;
    const scannerNames = await this.watchRepo.findScannerNames([entry.alertId]);
    return {
      ...entry,
      scannerName: entry.alertId ? scannerNames.get(entry.alertId) ?? null : null,
      realizedPnl: r?.pnl ?? null,
      realizedFees: r?.fees ?? null,
    };
  }

  @Get('watch')
  async list(
    @Query('status') status?: WatchStatus,
    @Query('date') date?: string,
  ) {
    const entries = await this.watchRepo.list({ status, date });
    const tradeIds = entries
      .map((e) => e.paperTradeId)
      .filter((x): x is string => !!x);
    const [realization, scannerNames] = await Promise.all([
      this.tradeRepo.findRealization(tradeIds),
      this.watchRepo.findScannerNames(entries.map((e) => e.alertId)),
    ]);
    return entries.map((e) => {
      const r = e.paperTradeId ? realization.get(e.paperTradeId) : undefined;
      return {
        ...e,
        scannerName: e.alertId ? scannerNames.get(e.alertId) ?? null : null,
        realizedPnl: r?.pnl ?? null,
        realizedFees: r?.fees ?? null,
      };
    });
  }

  @Get('paper-account')
  async account() {
    const snap = await this._account.snapshot();
    const unrealized = 0; // open positions snapshot can add this later
    return {
      ...snap,
      unrealizedPnl: unrealized,
      equity: snap.cash + snap.deployedCapital + unrealized,
    };
  }

  @Get('comparison')
  async comparison(@Query('date') date: string) {
    return this._comparison.daily(date);
  }

  /**
   * Dry-run verification of the REST poller path: fetches LTPs for every
   * currently TRADED adaptive-stop entry in one batched Angel One quote call,
   * compares each against entry price + SL threshold, and reports what
   * would happen on a real poll. DOES NOT mutate any entry, does NOT
   * call onTick — purely observational.
   *
   * Useful for verifying the poller will work after a code change without
   * waiting for the next market-hours cron firing.
   */
  @Get('_poll-dry-run')
  async pollDryRun() {
    const active = await this.watchRepo.findAllActive();
    const traded = active.filter((e) => e.status === WatchStatus.TRADED);
    if (traded.length === 0) return { traded: 0, fetched: 0, samples: [] };

    // Group tokens by exchange (always NSE for adaptive-stop today)
    const byExchange = new Map<string, string[]>();
    for (const e of traded) {
      const list = byExchange.get(e.exchange) ?? [];
      list.push(e.token);
      byExchange.set(e.exchange, list);
    }

    const tokenToEntry = new Map(traded.map((e) => [e.token, e]));
    const allLtps = new Map<string, number>();
    for (const [exchange, tokens] of byExchange) {
      const m = await this.adapter.getLtpsBatch(exchange, tokens);
      for (const [tok, ltp] of m) allLtps.set(tok, ltp);
    }

    type Sample = {
      symbol: string; side: string; executed: number; ltp: number;
      deltaPct: string; openPnl: number; slThreshold: number; wouldCut: boolean;
    };
    const samples: Sample[] = [];
    let wouldCut = 0;
    for (const [token, ltp] of allLtps) {
      const e = tokenToEntry.get(token)!;
      const ref = e.executedPrice ?? e.initialPrice ?? 0;
      const sideMul = e.side === 'BUY' ? 1 : -1;
      const qty = e.remainingQty ?? e.quantity ?? 0;
      const openPnl = (ltp - ref) * sideMul * qty;
      const slThreshold = -0.004 * ref * qty;
      const cut = openPnl <= slThreshold;
      if (cut) wouldCut++;
      samples.push({
        symbol: e.symbol,
        side: e.side,
        executed: Number(ref.toFixed(2)),
        ltp,
        deltaPct: ref > 0 ? `${(((ltp - ref) / ref) * sideMul * 100).toFixed(3)}%` : 'n/a',
        openPnl: Number(openPnl.toFixed(2)),
        slThreshold: Number(slThreshold.toFixed(2)),
        wouldCut: cut,
      });
    }

    return {
      traded: traded.length,
      fetched: allLtps.size,
      missing: traded.length - allLtps.size,
      wouldCut,
      samples: samples
        .sort((a, b) => Math.abs(parseFloat(b.deltaPct)) - Math.abs(parseFloat(a.deltaPct)))
        .slice(0, 10),
    };
  }
}
