import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
} from '@nestjs/common';
import type { TradeTracker } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  CREDENTIAL_DECRYPTOR,
  CredentialDecryptor,
} from '../../credential-vault/execution/credential-decryptor';
import { PerUserBrokerSessionFactory } from '../../auto-execution/services/per-user-broker-session.factory';
import { TradeTrackerDto, toTradeTrackerDto } from '../dto/trade-tracker.dto';

/** A normalized open-book instrument (one open position or one holding). */
export interface BookItem {
  kind: 'POSITION' | 'HOLDING';
  symbol: string;
  exchange: string;
  token: string;
  /** Average cost (entry price). */
  entryPrice: number;
  qty: number;
  /** Latest broker LTP at snapshot time (seeds extremes on first-seen). */
  ltp: number;
}

/** Coerce a broker numeric-string (or number/null/undefined) to a finite number. */
function toNum(v: unknown): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : 0;
}

/**
 * The IST calendar date ('YYYY-MM-DD') for `d`. Used as the day-rollover marker
 * so `dayHigh`/`dayLow` reset when the Indian trading day changes, regardless of
 * the server's own timezone. `en-CA` formats as YYYY-MM-DD.
 */
export function istDateString(d: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/** P&L in rupees and percent for a price move off entry. */
export function computePnl(
  entryPrice: number,
  price: number,
  qty: number,
): { pnl: number; pnlPercent: number } {
  const pnl = (price - entryPrice) * qty;
  const pnlPercent =
    entryPrice !== 0 ? ((price - entryPrice) / entryPrice) * 100 : 0;
  return { pnl, pnlPercent };
}

/** Fields updated on every applied tick. */
export interface TickPatch {
  holdingHigh: number;
  holdingLow: number;
  dayHigh: number;
  dayLow: number;
  dayDate: string;
  lastLtp: number;
  pnl: number;
  pnlPercent: number;
}

/**
 * Pure tick-update math for one OPEN tracker: running holding-period high/low,
 * day high/low (reset to `ltp` when the IST date rolls past `tracker.dayDate`),
 * latest LTP and P&L. Kept pure + exported so the accumulation, rollover and
 * P&L rules are unit-tested without a DB.
 */
export function computeTickPatch(
  tracker: Pick<
    TradeTracker,
    'entryPrice' | 'qty' | 'holdingHigh' | 'holdingLow' | 'dayHigh' | 'dayLow' | 'dayDate'
  >,
  ltp: number,
  now: Date = new Date(),
): TickPatch {
  const today = istDateString(now);
  const rolled = tracker.dayDate !== today;

  const dayHigh = rolled ? ltp : Math.max(tracker.dayHigh ?? ltp, ltp);
  const dayLow = rolled ? ltp : Math.min(tracker.dayLow ?? ltp, ltp);
  const holdingHigh = Math.max(tracker.holdingHigh ?? ltp, ltp);
  const holdingLow = Math.min(tracker.holdingLow ?? ltp, ltp);

  const { pnl, pnlPercent } = computePnl(tracker.entryPrice, ltp, tracker.qty);

  return {
    holdingHigh,
    holdingLow,
    dayHigh,
    dayLow,
    dayDate: today,
    lastLtp: ltp,
    pnl,
    pnlPercent,
  };
}

/**
 * Normalize a raw Angel One `getPosition` `data` array into open-book items.
 * Only net-nonzero positions are "open"; a squared-off intraday leg (netqty 0)
 * is treated as gone from the book so its tracker closes on the next reconcile.
 */
export function normalizePositions(positions: unknown): BookItem[] {
  if (!Array.isArray(positions)) return [];
  const out: BookItem[] = [];
  for (const p of positions as Array<Record<string, unknown>>) {
    const token = p?.symboltoken ? String(p.symboltoken) : '';
    const qty = toNum(p?.netqty);
    if (!token || qty === 0) continue;
    out.push({
      kind: 'POSITION',
      symbol: p?.tradingsymbol
        ? String(p.tradingsymbol)
        : p?.symbolname
          ? String(p.symbolname)
          : '',
      exchange: p?.exchange ? String(p.exchange) : '',
      token,
      // Angel One reports average net price under a few keys across product
      // types; prefer avgnetprice, then netprice, then the buy average.
      entryPrice: toNum(p?.avgnetprice ?? p?.netprice ?? p?.buyavgprice),
      qty,
      ltp: toNum(p?.ltp),
    });
  }
  return out;
}

/**
 * Normalize a raw Angel One `get_all_holding` `data.holdings[]` array into
 * open-book items. Zero-quantity holdings are skipped.
 */
export function normalizeHoldings(holdings: unknown): BookItem[] {
  if (!Array.isArray(holdings)) return [];
  const out: BookItem[] = [];
  for (const h of holdings as Array<Record<string, unknown>>) {
    const token = h?.symboltoken ? String(h.symboltoken) : '';
    const qty = toNum(h?.quantity);
    if (!token || qty === 0) continue;
    out.push({
      kind: 'HOLDING',
      symbol: h?.tradingsymbol ? String(h.tradingsymbol) : '',
      exchange: h?.exchange ? String(h.exchange) : '',
      token,
      entryPrice: toNum(h?.averageprice),
      qty,
      ltp: toNum(h?.ltp),
    });
  }
  return out;
}

/** Composite identity of an open-book instrument within one user's book. */
function bookKey(token: string, kind: string): string {
  return `${token}:${kind}`;
}

/** How long applyTick coalesces ticks before a batched DB flush (design §4.1). */
const TICK_DEBOUNCE_MS = 3_000;

/**
 * Per-trade tracker reconciler + tick updater (design §4).
 *
 * Owns the DB lifecycle of `trade_trackers`: it opens a tracker the first time a
 * position/holding is seen, closes it when the instrument leaves the book, and
 * folds live socket ticks into the holding-period + day high/low and running
 * P&L. Every query is EXPLICITLY scoped by `userId` — `TradeTracker` is not a
 * TDA-003 tenant-auto-scoped model and the reconciler/poller run in a cron
 * context with no tenant, so isolation here is this service's own contract.
 */
@Injectable()
export class TradeTrackerService implements OnModuleDestroy {
  private readonly logger = new Logger(TradeTrackerService.name);

  /** Latest pending LTP per token, coalesced between debounced flushes. */
  private readonly pendingTicks = new Map<string, number>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(CREDENTIAL_DECRYPTOR)
    private readonly decryptor: CredentialDecryptor,
    private readonly brokerFactory: PerUserBrokerSessionFactory,
  ) {}

  onModuleDestroy(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  /**
   * Take a ONE-login ephemeral snapshot of a user's live positions + holdings
   * (reuses the TDA-017 vault pattern: isolated decrypt lease → disposable
   * per-user broker session). Returns the RAW broker arrays; the caller feeds
   * them to {@link reconcile}. Never logs or retains creds.
   */
  async snapshotBook(
    userId: string,
  ): Promise<{ positions: unknown[]; holdings: unknown[] }> {
    const raw = await this.decryptor.withDecryptedCredentials(
      userId,
      { reason: 'REVALIDATE' },
      (creds) =>
        this.brokerFactory.withSession(creds, async (session) => ({
          positions: await session.getPositions(),
          holdings: await session.getHoldings(),
        })),
    );
    const positions = Array.isArray(raw.positions) ? raw.positions : [];
    // getHoldings() returns the `{ holdings, totalholding }` envelope.
    const holdings = Array.isArray((raw.holdings as any)?.holdings)
      ? (raw.holdings as any).holdings
      : [];
    return { positions, holdings };
  }

  /**
   * Reconcile a user's stored OPEN trackers against a fresh broker book.
   * Idempotent: first-seen instruments open a tracker; instruments no longer in
   * the book close theirs; unchanged instruments are left untouched (ticks, not
   * reconcile, move their prices).
   */
  async reconcile(
    userId: string,
    positions: unknown[],
    holdings: unknown[],
  ): Promise<void> {
    const book = [
      ...normalizePositions(positions),
      ...normalizeHoldings(holdings),
    ];
    const bookByKey = new Map<string, BookItem>();
    for (const item of book) bookByKey.set(bookKey(item.token, item.kind), item);

    const open = await this.prisma.tradeTracker.findMany({
      where: { userId, status: 'OPEN' },
    });
    const openByKey = new Map<string, TradeTracker>();
    for (const t of open) openByKey.set(bookKey(t.token, t.kind), t);

    const now = new Date();
    const today = istDateString(now);

    // Open a tracker for every first-seen book instrument.
    for (const [key, item] of bookByKey) {
      if (openByKey.has(key)) continue; // already tracked — idempotent no-op
      const seed = item.ltp > 0 ? item.ltp : item.entryPrice;
      const { pnl, pnlPercent } = computePnl(item.entryPrice, seed, item.qty);
      await this.prisma.tradeTracker.create({
        data: {
          userId,
          symbol: item.symbol,
          exchange: item.exchange,
          token: item.token,
          kind: item.kind,
          entryPrice: item.entryPrice,
          qty: item.qty,
          entryTime: now,
          status: 'OPEN',
          holdingHigh: seed,
          holdingLow: seed,
          dayHigh: seed,
          dayLow: seed,
          dayDate: today,
          lastLtp: seed,
          pnl,
          pnlPercent,
        },
      });
    }

    // Close every OPEN tracker whose instrument left the book.
    for (const [key, tracker] of openByKey) {
      if (bookByKey.has(key)) continue;
      const exitPrice = tracker.lastLtp ?? tracker.entryPrice;
      const { pnl, pnlPercent } = computePnl(
        tracker.entryPrice,
        exitPrice,
        tracker.qty,
      );
      await this.prisma.tradeTracker.updateMany({
        where: { id: tracker.id, userId },
        data: {
          status: 'CLOSED',
          exitPrice,
          exitTime: now,
          lastLtp: exitPrice,
          pnl,
          pnlPercent,
        },
      });
    }
  }

  /**
   * First-run / on-demand fill: snapshot the caller's current book and
   * reconcile it, so existing positions/holdings appear immediately without
   * waiting for the cron.
   */
  async backfill(userId: string): Promise<void> {
    const { positions, holdings } = await this.snapshotBook(userId);
    await this.reconcile(userId, positions, holdings);
  }

  /**
   * Fold a live tick into every OPEN tracker on `token`. Writes are DEBOUNCED:
   * the latest LTP per token is coalesced and flushed in a batch every
   * {@link TICK_DEBOUNCE_MS}, not once per call (design §4.1).
   */
  applyTick(token: string, ltp: number): void {
    if (!token || !(ltp > 0)) return;
    this.pendingTicks.set(token, ltp);
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        void this.flushTicks();
      }, TICK_DEBOUNCE_MS);
    }
  }

  /**
   * Flush all coalesced ticks: for each pending token, update every OPEN
   * tracker across all users (ticks are market-wide, valid for any holder).
   * Exposed for the poller's shutdown drain and for tests.
   */
  async flushTicks(): Promise<void> {
    if (this.pendingTicks.size === 0) return;
    const batch = new Map(this.pendingTicks);
    this.pendingTicks.clear();

    const tokens = [...batch.keys()];
    const open = await this.prisma.tradeTracker.findMany({
      where: { status: 'OPEN', token: { in: tokens } },
    });
    if (open.length === 0) return;

    const now = new Date();
    for (const tracker of open) {
      const ltp = batch.get(tracker.token);
      if (ltp === undefined) continue;
      const patch = computeTickPatch(tracker, ltp, now);
      try {
        await this.prisma.tradeTracker.updateMany({
          where: { id: tracker.id, userId: tracker.userId },
          data: patch,
        });
      } catch (err) {
        this.logger.warn(
          `applyTick flush failed for tracker ${tracker.id}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }

  /**
   * Distinct tokens across ALL users' OPEN trackers. Used by the poller to
   * decide which tokens to subscribe to the feed and to sweep for quotes. This
   * is a deliberate system-level (cross-tenant) read from the cron.
   */
  async distinctOpenTokens(): Promise<string[]> {
    const rows = await this.prisma.tradeTracker.findMany({
      where: { status: 'OPEN' },
      select: { token: true },
      distinct: ['token'],
    });
    return rows.map((r) => r.token);
  }

  /**
   * The caller's trackers (OPEN + CLOSED), newest first, mapped to the §5 DTO.
   */
  async list(userId: string): Promise<TradeTrackerDto[]> {
    const rows = await this.prisma.tradeTracker.findMany({
      where: { userId },
      orderBy: { entryTime: 'desc' },
    });
    return rows.map(toTradeTrackerDto);
  }
}
