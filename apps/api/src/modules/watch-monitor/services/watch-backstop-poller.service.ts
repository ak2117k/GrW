import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { WatchRepository } from '../repositories/watch.repository';
import { WatchService } from './watch.service';
import { ExitPriceService } from '../../signal-generator/services/exit-price.service';

/**
 * REST backstop poller for the gated `watch-monitor` track.
 *
 * The gated track is driven ONLY by the Angel WebSocket feed
 * (watch-monitor.module's onApplicationBootstrap → feed.registerWatchTickHandler
 * → watch.onTick). The WS feed has a ~50-token cap; a TRADED held position
 * evicted from the feed stops receiving onTick and its stop NEVER fires — there
 * is no REST safety net.
 *
 * This poller prices the WS-starved TRADED positions via the already-built
 * fresh-or-surface ExitPriceService and drives their exits through the SAME
 * watch.onTick path. It is purely additive and does NOT touch the WS path.
 */
@Injectable()
export class WatchBackstopPollerService {
  private readonly logger = new Logger(WatchBackstopPollerService.name);

  /** A TRADED position un-ticked longer than this is assumed WS-starved. */
  private static readonly STALE_MS = 60_000;

  constructor(
    private readonly repo: WatchRepository,
    private readonly watch: WatchService,
    private readonly exitPrice: ExitPriceService,
  ) {}

  // Backstop WS-starved gated positions every 30s during market hours (IST).
  @Cron('*/30 * 9-15 * * 1-5', { timeZone: 'Asia/Kolkata' })
  async backstopOpenPositions(): Promise<void> {
    const active = await this.repo.findAllActive();
    const now = Date.now();
    // Only TRADED entries with a token that the WS feed has NOT ticked recently.
    const starved = active.filter(
      (e) =>
        e.status === 'TRADED' &&
        e.token &&
        (!e.lastTickAt || now - new Date(e.lastTickAt).getTime() > WatchBackstopPollerService.STALE_MS),
    );
    if (starved.length === 0) return;

    // Group by exchange (entries carry their own exchange).
    const byExchange = new Map<string, typeof starved>();
    for (const e of starved) {
      const arr = byExchange.get(e.exchange) ?? [];
      arr.push(e);
      byExchange.set(e.exchange, arr);
    }

    const ts = new Date();
    let dispatched = 0;
    for (const [exchange, entries] of byExchange) {
      const tokens = [...new Set(entries.map((e) => e.token as string))];
      const priceMap = await this.exitPrice.resolveExitPrices(exchange, tokens);
      for (const e of entries) {
        const r = priceMap.get(e.token as string);
        if (!r || !r.fresh) {
          this.logger.warn(
            `[watch-backstop] ${e.symbol} unmonitored — no fresh price, stop not evaluated`,
          );
          continue;
        }
        try {
          await this.watch.onTick(e.token as string, r.price, ts);
          dispatched++;
        } catch (err) {
          this.logger.warn(
            `[watch-backstop] onTick(${e.symbol}) threw: ${err instanceof Error ? err.message : err}`,
          );
        }
      }
    }
    if (dispatched > 0) {
      this.logger.log(`[watch-backstop] backstopped ${dispatched} WS-starved gated position(s)`);
    }
  }
}
