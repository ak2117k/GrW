import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
} from '@nestjs/common';
import type { TradeTracker } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  CREDENTIAL_DECRYPTOR,
  CredentialDecryptor,
} from '../../credential-vault/execution/credential-decryptor';
import { PerUserBrokerSessionFactory } from '../../auto-execution/services/per-user-broker-session.factory';
import { AngelOneAuthService } from '../../market-data/services/angel-one-auth.service';
import { AngelOneAdapterService } from '../../market-data/services/angel-one-adapter.service';
import {
  DailyOhlcDto,
  SoldTradeDto,
  TradeTrackerDto,
  toSoldTradeDto,
  toTradeTrackerDto,
} from '../dto/trade-tracker.dto';

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

/** One day in milliseconds — used by the sold-trade OHLC window math. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Compute the daily-OHLC fetch window for a sold trade (2026-07-13 design):
 * `from` = (entryTime ?? exitTime − 30d) − 3d small pre-entry pad;
 * `to`   = (exitTime ?? now) + 10d post-exit tail, clamped to <= now.
 * Pure + exported so the window rules are unit-tested without a DB or broker.
 */
export function computeOhlcWindow(
  entryTime: Date | null,
  exitTime: Date | null,
  now: Date = new Date(),
): { from: Date; to: Date } {
  const exit = exitTime ?? now;
  const base = entryTime ?? new Date(exit.getTime() - 30 * DAY_MS);
  const from = new Date(base.getTime() - 3 * DAY_MS);
  let to = new Date(exit.getTime() + 10 * DAY_MS);
  if (to.getTime() > now.getTime()) to = now;
  return { from, to };
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
    // Persistent feed session — reused for the feed account's snapshot so a
    // second login doesn't kill the live feed (see snapshotBook).
    private readonly authService: AngelOneAuthService,
    // Daily historical candles for the sold-trade OHLC series (TTL-cached +
    // rate-paced; returns [] on any broker hiccup rather than throwing).
    private readonly adapter: AngelOneAdapterService,
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
    // If the caller IS the market-data feed account, read via the feed's live
    // session instead of a fresh login — a second login on the same Angel One
    // client code would kill the feed's streaming session. Falls back to an
    // ephemeral login on any failure.
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { isFeedAccount: true },
    });
    let raw: { positions: unknown; holdings: unknown };
    if (user?.isFeedAccount && this.authService.isAuthenticated()) {
      try {
        const api = this.authService.getSmartApi();
        raw = {
          positions: (await api.getPosition())?.data ?? null,
          holdings: (await api.getAllHolding())?.data ?? null,
        };
      } catch (err) {
        this.logger.warn(
          `Feed-session snapshot failed; falling back to ephemeral login: ${err instanceof Error ? err.message : err}`,
        );
        raw = await this.ephemeralSnapshot(userId);
      }
    } else {
      raw = await this.ephemeralSnapshot(userId);
    }
    const positions = Array.isArray(raw.positions) ? raw.positions : [];
    // getHoldings() returns the `{ holdings, totalholding }` envelope.
    const holdings = Array.isArray((raw.holdings as any)?.holdings)
      ? (raw.holdings as any).holdings
      : [];
    return { positions, holdings };
  }

  /** One-login ephemeral broker snapshot via the isolated decrypt lease. */
  private ephemeralSnapshot(
    userId: string,
  ): Promise<{ positions: unknown; holdings: unknown }> {
    return this.decryptor.withDecryptedCredentials(userId, { reason: 'REVALIDATE' }, (creds) =>
      this.brokerFactory.withSession(creds, async (session) => ({
        positions: await session.getPositions(),
        holdings: await session.getHoldings(),
      })),
    );
  }

  /**
   * Reconcile a user's stored OPEN trackers against a fresh broker book.
   * Idempotent: first-seen instruments open a tracker; instruments no longer in
   * the book close theirs; unchanged instruments are left untouched (ticks, not
   * reconcile, move their prices).
   */
  /**
   * Which halves of the book the broker actually ANSWERED for.
   *
   * `UserBrokerSession.read` returns `response?.data ?? null`, so a failed or
   * unauthenticated call yields **null** — it does not throw and it does not
   * return `[]`. `normalizePositions(null)` then produces `[]`, which is
   * byte-identical to "the broker says you hold nothing".
   *
   * Those are opposite facts and collapsing them destroyed real data: one bad
   * fetch closed every open tracker, and the next good fetch re-created them
   * with new ids — orphaning the sentinel's verdicts and theses, and resetting
   * `holdingHigh`/`holdingLow` (the best and worst excursion the agent reasons
   * from) and `entryTime`. The positions themselves were never touched, which
   * is what made it silent.
   *
   * An array — even an empty one — is an answer. Anything else is not.
   */
  private static fetchedKinds(positions: unknown, holdings: unknown): Set<string> {
    const kinds = new Set<string>();
    if (Array.isArray(positions)) kinds.add('POSITION');
    if (Array.isArray(holdings)) kinds.add('HOLDING');
    return kinds;
  }

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

    // Close every OPEN tracker whose instrument left the book — but ONLY for
    // the kinds the broker actually answered for. See `fetchedKinds`: a failed
    // read is indistinguishable from an empty book by the time it reaches here,
    // and closing on a failure is destructive and silent.
    //
    // Scoped by KIND rather than all-or-nothing so a broken positions read does
    // not also freeze holdings reconciliation, and vice versa.
    const fetched = TradeTrackerService.fetchedKinds(positions, holdings);
    const unanswered = ['POSITION', 'HOLDING'].filter((k) => !fetched.has(k));
    if (unanswered.length > 0) {
      // WARN, not debug. This is the state in which the tracker knowingly stops
      // reconciling part of the book; if it were quiet, a broker session that
      // stayed broken all session would look exactly like a calm one.
      this.logger.warn(
        `[trade-tracker] broker returned no answer for ${unanswered.join(' and ')} — ` +
          'skipping closes for those kinds this pass. Open trackers are LEFT OPEN rather ' +
          'than closed on an unanswered read.',
      );
    }

    for (const [key, tracker] of openByKey) {
      if (bookByKey.has(key)) continue;
      if (!fetched.has(tracker.kind)) continue;
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
   * All OPEN trackers (positions and holdings) for ONE user, oldest entry
   * first. Distinct from {@link list}, which returns OPEN *and CLOSED* rows:
   * callers that poll — the trade sentinel's roster runs every heartbeat —
   * must not drag a user's whole closed-trade history along to read the open
   * book. Returns raw rows rather than the §5 DTO simply because no wire
   * contract is involved; `TradeTrackerDto` would carry these fields fine.
   */
  async listOpen(userId: string): Promise<TradeTracker[]> {
    return this.prisma.tradeTracker.findMany({
      where: { userId, status: 'OPEN' },
      orderBy: { entryTime: 'asc' },
    });
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

  /**
   * The caller's CLOSED trackers (the persistent "sold" record), newest exit
   * first, mapped to the sold-trade DTO (2026-07-13 design).
   */
  async listSold(userId: string): Promise<SoldTradeDto[]> {
    const rows = await this.prisma.tradeTracker.findMany({
      where: { userId, status: 'CLOSED' },
      orderBy: { exitTime: 'desc' },
    });
    return rows.map(toSoldTradeDto);
  }

  /**
   * Daily OHLC series for one sold trade over its window (hold + short
   * post-exit tail; see {@link computeOhlcWindow}). Caller-scoped: the tracker
   * must belong to `userId` (else 404). A broker/data hiccup degrades to an
   * empty series (logged warn) — it never 500s the request.
   */
  async listSoldOhlc(
    userId: string,
    id: string,
  ): Promise<{ symbol: string; ohlc: DailyOhlcDto[] }> {
    const tracker = await this.prisma.tradeTracker.findFirst({
      where: { id, userId },
    });
    if (!tracker) {
      throw new NotFoundException(`Sold trade ${id} not found`);
    }

    const { from, to } = computeOhlcWindow(tracker.entryTime, tracker.exitTime);

    let candles: unknown;
    try {
      candles = await this.adapter.getHistoricalData(
        tracker.token,
        tracker.exchange,
        'ONE_DAY',
        from,
        to,
      );
    } catch (err) {
      this.logger.warn(
        `[sold-ohlc] historical fetch failed for tracker ${id} (${tracker.symbol}): ` +
          `${err instanceof Error ? err.message : err}`,
      );
      return { symbol: tracker.symbol, ohlc: [] };
    }

    if (!Array.isArray(candles)) {
      return { symbol: tracker.symbol, ohlc: [] };
    }

    const ohlc: DailyOhlcDto[] = (candles as Array<Record<string, unknown>>).map(
      (c) => ({
        date: new Date(c.timestamp as string).toISOString(),
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
      }),
    );
    return { symbol: tracker.symbol, ohlc };
  }
}
