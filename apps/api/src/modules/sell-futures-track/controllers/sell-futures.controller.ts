import { Controller, Get, NotFoundException, Param, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { WatchStatus } from '@prisma/client';
import { SellFuturesWatchRepository } from '../repositories/sell-futures-watch.repository';
import { SellFuturesTradeRepository } from '../repositories/sell-futures-trade.repository';
import { SellFuturesPaperAccountService } from '../services/sell-futures-paper-account.service';

@ApiTags('SELL-Futures Track (paper)')
@Controller('api/sell-futures')
export class SellFuturesController {
  constructor(
    private readonly watchRepo: SellFuturesWatchRepository,
    private readonly tradeRepo: SellFuturesTradeRepository,
    private readonly account: SellFuturesPaperAccountService,
  ) {}

  @Get('watch/:id')
  async get(@Param('id') id: string) {
    const entry = await this.watchRepo.findByIdWithEvents(id);
    if (!entry) throw new NotFoundException(`SellFuturesWatchEntry ${id} not found`);
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
  async paperAccount() {
    const snap = await this.account.snapshot();
    const unrealized = 0; // open-position MTM can be added later
    return {
      ...snap,
      unrealizedPnl: unrealized,
      equity: snap.cash + snap.deployedCapital + unrealized,
    };
  }
}
