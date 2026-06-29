import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { SellFuturesWatchRepository } from '../repositories/sell-futures-watch.repository';
import { SellFuturesService } from './sell-futures.service';
import { ExitPriceService } from '../../signal-generator/services/exit-price.service';

/**
 * REST-poll open SELL-futures positions every 30s during market hours, plus a
 * 15:15 IST EOD square-off. Clone of UngatedTickPoller — sidesteps the broker's
 * ~50-token WebSocket cap with one batched LTP call per exchange. Tokens here
 * are FUTURES NFO tokens, so the poll groups by exchange ('NFO').
 */
@Injectable()
export class SellFuturesTickPoller {
  private readonly logger = new Logger(SellFuturesTickPoller.name);

  constructor(
    private readonly repo: SellFuturesWatchRepository,
    private readonly svc: SellFuturesService,
    private readonly exitPrice: ExitPriceService,
  ) {}

  // Every 30s, Mon–Fri, 09:15–15:30 IST (6-field crontab: sec min hour dom mon dow).
  @Cron('*/30 * 9-15 * * 1-5', { timeZone: 'Asia/Kolkata' })
  async pollOpenPositions(): Promise<void> {
    const open = await this.repo.findAllActive();
    const traded = open.filter((e) => e.status === 'TRADED');
    if (traded.length === 0) return;

    const byExchange = new Map<string, string[]>();
    for (const e of traded) {
      const list = byExchange.get(e.exchange) ?? [];
      list.push(e.token);
      byExchange.set(e.exchange, list);
    }

    const now = new Date();
    let dispatched = 0;
    for (const [exchange, tokens] of byExchange) {
      const priceMap = await this.exitPrice.resolveExitPrices(exchange, [...new Set(tokens)]);
      for (const [token, r] of priceMap) {
        if (!r.fresh) {
          this.logger.warn(`[sell-futures-poll] ${token} unmonitored — no fresh price, onTick skipped`);
          continue;
        }
        try {
          await this.svc.onTick(token, r.price, now);
          dispatched++;
        } catch (err) {
          this.logger.warn(
            `[sell-futures-poll] onTick(${token}) threw: ${err instanceof Error ? err.message : err}`,
          );
        }
      }
    }
    if (dispatched > 0) {
      this.logger.debug(
        `[sell-futures-poll] ${dispatched} ticks dispatched across ${traded.length} open entries`,
      );
    }
  }

  // EOD square-off at 15:15 IST Mon–Fri — intraday only, no overnight carry.
  @Cron('0 15 15 * * 1-5', { timeZone: 'Asia/Kolkata' })
  async eodSquareOff(): Promise<void> {
    this.logger.warn('[sell-futures-eod] EOD square-off starting');
    const res = await this.svc.squareOffOpenPositions();
    this.logger.warn(`[sell-futures-eod] done — closed=${res.closed} errors=${res.errors}`);
  }
}
