import { Body, Controller, ForbiddenException, Get, NotFoundException, Optional, Param, Patch, Query } from '@nestjs/common';
import { IsNotEmpty, IsString } from 'class-validator';
import { CurrentUser, AuthenticatedUser, AdminOnly } from '../../../common/decorators';
import { SubscriptionService, Seg } from '../../subscription/subscription.service';
import { toPublicEntry, AnandEntryLike } from '../dto/public-entry.dto';
import { AnandDualTrackRepository } from '../repositories/anand-dual-track.repository';
import { ChartinkRepository } from '../../chartink/repositories/chartink.repository';
import { AngelOneAdapterService } from '../../market-data/services/angel-one-adapter.service';
import { LevelBookService } from '../../signal-generator/services/level-book.service';
import { resolvePriceFields } from '../price-fields';
import { realizedIntradayPnlPct } from '../intraday-pnl';
import { withBudget } from '../../../common/utils/with-budget';
import {
  computeLotLivePnl,
  sumOpenLotsUnrealizedPnl,
} from '../utils/reinvest-pnl.util';

class UpdateCategoryDto {
  @IsString() @IsNotEmpty() category!: string;
}

/** Live-price enrichment is best-effort and MUST NOT block the list response.
 *  A cold/dead Angel feed makes getLtpsBatch hang and pushes every open token
 *  to the serialized lazyLoad historical fallback — together that blew past the
 *  web client's 30s timeout on the swing/intraday lists. Each phase is bounded;
 *  tokens unresolved in time render `priceStale` and fill in via WS / next poll. */
const LTP_BUDGET_MS = 3000;
const SEED_BUDGET_MS = 3000;

@Controller('api/anand')
export class AnandDualTrackController {
  constructor(
    private readonly repo: AnandDualTrackRepository,
    private readonly chartinkRepo: ChartinkRepository,
    private readonly adapter: AngelOneAdapterService,
    private readonly subs: SubscriptionService,
    @Optional() private readonly levelBook?: LevelBookService,
  ) {}

  /**
   * Plan-gate (TDA-007): a non-ADMIN USER may only reach a segment they hold an
   * ACTIVE subscription for. ADMIN bypasses entirely. Throws 403
   * {code:'NOT_SUBSCRIBED', segment} otherwise.
   */
  private async assertSubscribed(
    user: AuthenticatedUser,
    segment: Seg,
  ): Promise<void> {
    if (user?.role === 'ADMIN') return;
    if (!(await this.subs.hasActive(user.userId, segment))) {
      throw new ForbiddenException({ code: 'NOT_SUBSCRIBED', segment });
    }
  }

  @Get('intraday/entries')
  async listIntraday(
    @CurrentUser() user: AuthenticatedUser,
    @Query('status') status?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    await this.assertSubscribed(user, 'INTRADAY');
    const entries = await this.repo.listIntradayEntries({
      status: status || undefined,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
    });
    const enriched = await this.enrichWithLivePrice(entries);
    const rows = await this.enrichWithScannerName(enriched);
    // Strip provenance/IP last: a non-ADMIN gets the allowlisted public shape;
    // an ADMIN keeps the raw enriched rows. Absent role fails closed (sanitized).
    // The enriched row carries `enteredAt` (a DB column) at runtime, but the
    // enrichment helpers surface it only through an index signature, so it must
    // be widened to AnandEntryLike for the serializer.
    return user?.role === 'ADMIN'
      ? rows
      : rows.map((r) => toPublicEntry(r as unknown as AnandEntryLike, 'INTRADAY'));
  }

  @Get('swing/entries')
  async listSwing(
    @CurrentUser() user: AuthenticatedUser,
    @Query('status') status?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    await this.assertSubscribed(user, 'SWING');
    const entries = await this.repo.listSwingEntries({
      status: status || undefined,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
    });
    const enriched = await this.enrichWithLivePrice(entries);
    const withScanner = await this.enrichWithScannerName(enriched);
    const rows = await this.enrichWithLeadStat(withScanner);
    return user?.role === 'ADMIN'
      ? rows
      : rows.map((r) => toPublicEntry(r as unknown as AnandEntryLike, 'SWING'));
  }

  @Get('swing/exits')
  async listSwingExits(
    @CurrentUser() user: AuthenticatedUser,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('status') status?: string,
  ) {
    await this.assertSubscribed(user, 'SWING');
    const entries = await this.repo.listSwingExits({
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      status: status || undefined,
    });
    // These rows are all closed (terminal status + non-null exitedAt), so
    // enrichWithLivePrice never live-prices them — it reports realized pnlPct
    // from the exit price, keeping the row shape identical to swing/entries.
    const enriched = await this.enrichWithLivePrice(entries);
    const withScanner = await this.enrichWithScannerName(enriched);
    const rows = await this.enrichWithLeadStat(withScanner);
    return user?.role === 'ADMIN'
      ? rows
      : rows.map((r) => toPublicEntry(r as unknown as AnandEntryLike, 'SWING'));
  }

  @Get('intraday/pnl-summary')
  async intradayPnl(@CurrentUser() user: AuthenticatedUser) {
    await this.assertSubscribed(user, 'INTRADAY');
    return this.repo.getPnlSummary('intraday');
  }

  @Get('swing/pnl-summary')
  async swingPnl(@CurrentUser() user: AuthenticatedUser) {
    await this.assertSubscribed(user, 'SWING');
    return this.repo.getPnlSummary('swing');
  }

  @Get('swing/capital')
  async getSwingCapital() {
    return this.repo.getSwingCapital();
  }

  // Reinvest is an ADMIN cockpit feature, not part of the USER product surface.
  // reinvestLots spreads raw ReinvestmentLot (incl. exitReason, a forbidden
  // provenance key), so both reinvest endpoints are ADMIN-only.
  @AdminOnly()
  @Get('reinvest/pool')
  async reinvestPool() {
    const pool = await this.repo.getPool();
    // Unrealized P&L is summed over ALL open lots (not the filtered list the
    // /lots endpoint serves), so the card stays correct regardless of which
    // row filter the page is showing. Realized P&L (harvested + closed-lot
    // P&L) is composed on the client from the pool fields it already has.
    const openLots = await this.enrichLotsWithLivePnl(
      await this.repo.listReinvestmentLots('OPEN'),
    );
    const unrealizedPnl = sumOpenLotsUnrealizedPnl(openLots);
    return { ...pool, unrealizedPnl };
  }

  @AdminOnly()
  @Get('reinvest/lots')
  async reinvestLots(@Query('status') status?: string) {
    const lots = await this.repo.listReinvestmentLots(status || undefined);
    return this.enrichLotsWithLivePnl(lots);
  }

  /**
   * Mark a set of reinvestment lots to their live price. Token/LTP resolution
   * is best-effort: an unresolved token falls back to the lot's exit price (for
   * closed lots) then its entry price, so P&L is 0 rather than NaN. Shared by
   * the /reinvest/lots (per-row) and /reinvest/pool (aggregate) endpoints.
   */
  private async enrichLotsWithLivePnl<
    T extends { symbol: string; entryPrice: number; capital: number; exitPrice: number | null },
  >(lots: T[]): Promise<Array<T & { currentPrice: number; pnlPct: number; pnlRs: number }>> {
    const tokenMap = await this.repo
      .resolveTokens(lots.map((l) => l.symbol))
      .catch(() => new Map<string, string>());
    const tokens = [...new Set([...tokenMap.values()])];
    const ltpMap = tokens.length
      ? await this.adapter.getLtpsBatch('NSE', tokens).catch(() => new Map<string, number>())
      : new Map<string, number>();
    return lots.map((l) => {
      const token = tokenMap.get(l.symbol);
      const currentPrice =
        (token ? ltpMap.get(token) : undefined) ?? l.exitPrice ?? l.entryPrice;
      return { ...l, ...computeLotLivePnl(l, currentPrice) };
    });
  }

  // Read-only: returns the recorded daily OHLC for a swing trade (entry → exit
  // + up to 60 post-exit days). Rows are pre-sorted by date asc. Does NOT
  // trigger fetching — the EOD worker + boot backfill populate the rows.
  @Get('swing/:id/daily-ohlc')
  async swingDailyOhlc(@Param('id') id: string) {
    const entry = await this.repo.findSwingEntryById(id);
    if (!entry) throw new NotFoundException(`Swing entry ${id} not found`);
    const rows = await this.repo.listSwingDailyOhlc(id);
    return {
      entry: {
        id: entry.id,
        symbol: entry.symbol,
        enteredAt: entry.enteredAt,
        exitedAt: entry.exitedAt,
        status: entry.status,
      },
      rows,
    };
  }

  // Tagging a scanner's category mutates scanner IP — an ADMIN cockpit write,
  // not part of the USER product surface. Handler-level gate (no class-level
  // guard) keeps the USER product endpoints on this controller reachable.
  @AdminOnly()
  @Patch('scanners/:id/category')
  async tagScanner(
    @Param('id') id: string,
    @Body() body: UpdateCategoryDto,
  ) {
    const updated = await this.chartinkRepo.updateScannerCategory(id, body.category);
    if (!updated) throw new NotFoundException(`Scanner ${id} not found`);
    return updated;
  }

  private async enrichWithLivePrice(
    entries: Array<{ id: string; symbol: string; token: string | null; entryPrice: number; targetPct: number; stopPct: number; status: string; [key: string]: unknown }>,
  ) {
    // Live prices are only needed for OPEN positions; closed rows report their
    // realized exit price below.
    const openTokens = [
      ...new Set(entries.filter((e) => e.exitPrice == null).map((e) => e.token).filter(Boolean) as string[]),
    ];
    const ltpMap = openTokens.length
      ? await withBudget(
          this.adapter.getLtpsBatch('NSE', openTokens).catch(() => new Map<string, number>()),
          LTP_BUDGET_MS,
          new Map<string, number>(),
        )
      : new Map<string, number>();

    // Secondary fallback: for open-position tokens the live LTP batch dropped
    // (e.g. a stock whose Angel feed went quiet mid-session), seed the price
    // from the level book (candle-derived spot). Only the still-missing tokens
    // are queried, so this is a no-op in the common case. A token that resolves
    // nowhere is left out of both maps → resolvePriceFields marks that row stale
    // rather than faking entryPrice (which read as a misleading 0% P&L).
    const seedMap = new Map<string, number>();
    if (this.levelBook) {
      const missing = openTokens.filter((t) => !ltpMap.has(t));
      // Each lazyLoad does a 350ms-paced historical fetch, so N missing tokens
      // serialize into a long chain. Bound the whole fallback: lazyLoads that
      // resolve within the budget seed the map (as a side effect); the rest are
      // left unresolved → resolvePriceFields marks those rows stale.
      await withBudget(
        Promise.all(
          missing.map(async (token) => {
            const symbol = entries.find((e) => e.token === token)?.symbol ?? '';
            try {
              const book = await this.levelBook!.lazyLoad(token, 'NSE', symbol);
              const seed = book ? book.spot || book.vwap || book.prevClose || 0 : 0;
              if (seed > 0) seedMap.set(token, seed);
            } catch {
              /* leave unresolved → resolvePriceFields marks the row stale */
            }
          }),
        ),
        SEED_BUDGET_MS,
        [],
      );
    }

    return entries.map((e) => {
      // Closed positions report realized P&L from their actual exit price —
      // never live-priced, never stale.
      if (e.exitPrice != null) {
        // Blends the booked partial leg with the final-exit leg for intraday
        // partial-booked trades. Swing rows carry no partial fields, so the
        // helper falls back to the plain final-exit %.
        const pnlPct =
          realizedIntradayPnlPct({
            entryPrice: e.entryPrice,
            exitPrice: e.exitPrice as number,
            partialExitPrice: e.partialExitPrice as number | null | undefined,
            partialFraction: e.partialFraction as number | null | undefined,
          }) ?? 0;
        return {
          ...e,
          currentPrice: e.exitPrice,
          pnlPct,
          targetLeftPct: e.targetPct - pnlPct,
          priceStale: false,
          partialBookedAt: (e as { partialBookedAt?: unknown }).partialBookedAt ?? null,
          partialExitPrice: (e as { partialExitPrice?: unknown }).partialExitPrice ?? null,
        };
      }
      return { ...e, ...resolvePriceFields(e, ltpMap, seedMap) };
    });
  }

  private async enrichWithLeadStat<T extends { symbol: string; [key: string]: unknown }>(
    entries: T[],
  ): Promise<Array<T & { leadCount: number; leadDates: string[] }>> {
    const leadMap = await this.repo
      .getLeadStats('swing', entries.map((e) => e.symbol))
      .catch(() => new Map<string, { count: number; dates: string[] }>());
    return entries.map((e) => {
      const lead = leadMap.get(e.symbol);
      return { ...e, leadCount: lead?.count ?? 0, leadDates: lead?.dates ?? [] };
    });
  }

  private async enrichWithScannerName<T extends { alertId?: string | null; [key: string]: unknown }>(
    entries: T[],
  ): Promise<Array<T & { scannerName: string | null }>> {
    const alertIds = entries.map((e) => e.alertId).filter((id): id is string => !!id);
    const scannerMap = await this.repo.findScannerNamesByAlertIds(alertIds).catch(() => new Map<string, string>());
    return entries.map((e) => ({
      ...e,
      scannerName: (e.alertId ? scannerMap.get(e.alertId) : undefined) ?? null,
    }));
  }
}
