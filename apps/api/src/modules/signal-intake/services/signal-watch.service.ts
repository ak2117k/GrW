import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { bootJobsEnabled } from '../../../common/utils/boot-jobs';
import { MarketDataRepository } from '../../market-data/repositories/market-data.repository';
import { UserFeedManager } from '../../market-data/services/user-feed-manager.service';
import { SIGNAL_READY_EVENT, type SignalReadyEvent } from '../domain/types';
import { watchCrossed, watchesFromItems, watchExpiry, watchSignal, type WatchClock } from '../domain/watch';
import { SignalIntakeRepository } from '../repositories/signal-intake.repository';
import { SIGNAL_CLOCK } from './signal-outcome.service';
import { SIGNAL_EMITTER, SIGNAL_VOCAB } from './signal-intake.service';
import type { SignalVocabularyService } from './signal-vocabulary.service';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** INFO rows this far back are turned into watches (a restart never loses a fresh one). */
const LOOKBACK_MS = 36 * 3_600_000;
/** At most this many watches are quoted per tick (the owner's 10 req/s broker budget is shared). */
const MAX_POLL = 25;

/**
 * Watched breakout levels (owner 2026-10-27; domain/watch). Every 30 s: new WATCH items with a level
 * become signal_watches rows; each ACTIVE watch whose market is open is quoted over the owner's own
 * Angel session (a quote, never an order); a crossed level creates a trade_signals row and emits
 * `signal.ready`, so the trader's gate + judge decide it like any channel call; a lapsed one expires.
 * SIGNAL_WATCH=off turns it off. Never throws out of the tick.
 */
@Injectable()
export class SignalWatchService {
  private readonly logger = new Logger(SignalWatchService.name);
  private busy = false;

  constructor(
    private readonly repo: SignalIntakeRepository,
    @Inject(SIGNAL_VOCAB) private readonly vocab: Pick<SignalVocabularyService, 'get'>,
    @Inject(SIGNAL_CLOCK) private readonly clock: WatchClock,
    @Optional() private readonly instruments?: MarketDataRepository,
    @Optional() private readonly feeds?: UserFeedManager,
    @Optional() @Inject(SIGNAL_EMITTER) private readonly emitter?: { emit(event: string, payload: unknown): unknown },
  ) {}

  private enabled(): boolean {
    return (process.env.SIGNAL_WATCH ?? 'on').trim().toLowerCase() !== 'off';
  }

  private owner(): string | null {
    return (process.env.HUB_OWNER_USER_ID ?? '').trim() || null;
  }

  @Cron('*/30 * * * * *', { timeZone: 'Asia/Kolkata' })
  async tick(): Promise<void> {
    if (!this.enabled() || !bootJobsEnabled() || this.busy) return;
    this.busy = true;
    try {
      const now = new Date();
      await this.sync(now);
      await this.poll(now);
    } catch (err) {
      this.logger.warn(`[signal-watch] tick failed: ${errText(err)}`);
    } finally {
      this.busy = false;
    }
  }

  /** New WATCH items → watches (their quote line resolved now, so a bad symbol is INVALID at once). */
  async sync(now: Date): Promise<number> {
    const rows = await this.repo.infosWithoutWatches(new Date(now.getTime() - LOOKBACK_MS));
    if (rows.length === 0) return 0;
    const vocab = await this.vocab.get();
    const out: Parameters<SignalIntakeRepository['createWatches']>[0] = [];
    for (const r of rows) {
      for (const d of watchesFromItems(r.items, (u) => vocab.classOf.get(u))) {
        const line = await this.quoteLine(d.underlying, vocab.classOf.get(d.underlying), now);
        const exchange = line?.exchange ?? (vocab.classOf.get(d.underlying) === 'COMMODITY' ? 'MCX' : 'NSE');
        const expiresAt = watchExpiry(this.clock, exchange, r.postedAt) ?? new Date(r.postedAt.getTime() + 48 * 3_600_000);
        out.push({
          messageId: r.messageId,
          itemIndex: d.itemIndex,
          channelId: r.channelId,
          postedAt: r.postedAt,
          underlying: d.underlying,
          instrumentKind: d.instrumentKind,
          side: d.side,
          level: d.level,
          exchange,
          token: line?.token ?? null,
          status: line ? (expiresAt.getTime() <= now.getTime() ? 'EXPIRED' : 'ACTIVE') : 'INVALID',
          reason: line ? null : `no quote line for ${d.underlying}`,
          expiresAt,
        });
      }
    }
    const n = await this.repo.createWatches(out);
    if (n > 0) this.logger.log(`[signal-watch] ${n} new watch(es): ${out.map((w) => `${w.underlying} ${w.side === 'BUY' ? '>' : '<'} ${w.level}`).join(', ')}`);
    return n;
  }

  /** Quote each open-market ACTIVE watch; fire the crossed ones, expire the lapsed ones. */
  async poll(now: Date): Promise<{ checked: number; fired: number; expired: number }> {
    const owner = this.owner();
    const active = await this.repo.activeWatches();
    let checked = 0;
    let fired = 0;
    let expired = 0;
    for (const w of active) {
      if (w.expiresAt.getTime() <= now.getTime()) {
        await this.repo.updateWatch(w.id, { status: 'EXPIRED', reason: `not crossed by ${w.expiresAt.toISOString()} (last LTP ${w.lastLtp ?? '?'})` });
        expired++;
        continue;
      }
      if (!owner || !this.feeds || !w.token || !w.exchange || checked >= MAX_POLL) continue;
      if (!this.clock.isOpen(w.exchange, now)) continue;
      checked++;
      const q = await this.feeds.fetchQuote(owner, w.token, w.exchange).catch(() => null);
      const ltp = q && Number.isFinite(q.ltp) && q.ltp > 0 ? q.ltp : null;
      if (ltp === null) continue;
      if (!watchCrossed(w.side as 'BUY' | 'SELL', w.level, ltp)) {
        await this.repo.updateWatch(w.id, { lastLtp: ltp, lastCheckAt: now });
        continue;
      }
      try {
        await this.fire(w, ltp, now);
        fired++;
      } catch (err) {
        this.logger.warn(`[signal-watch] firing ${w.underlying} ${w.level} failed: ${errText(err)}`);
      }
    }
    return { checked, fired, expired };
  }

  private async fire(w: Awaited<ReturnType<SignalIntakeRepository['activeWatches']>>[number], ltp: number, now: Date): Promise<void> {
    const postText = await this.repo.postText(w.messageId);
    const sessionDate = new Date(now.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);
    const signalId = await this.repo.createSignal(watchSignal(w, { at: now, ltp, sessionDate, postText }));
    await this.repo.updateWatch(w.id, { status: 'FIRED', firedAt: now, lastLtp: ltp, lastCheckAt: now, signalId });
    const ready: SignalReadyEvent = { signalId, clusterId: null, agreeCount: 1, conflict: false };
    this.emitter?.emit(SIGNAL_READY_EVENT, ready);
    this.logger.warn(`[signal-watch] FIRED ${w.underlying} ${w.side === 'BUY' ? 'above' : 'below'} ${w.level} at LTP ${ltp} → signal ${signalId}`);
  }

  /** The underlying's own quote line: NSE cash for a stock, the INDEX row for an index, the nearest MCX future. */
  private async quoteLine(underlying: string, cls: string | undefined, now: Date): Promise<{ token: string; exchange: string } | null> {
    if (!this.instruments) return null;
    try {
      const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const inst =
        cls === 'COMMODITY'
          ? await this.instruments.getNearestFuture(underlying, 'MCX', startOfDay)
          : cls === 'STOCK'
            ? await this.instruments.getInstrumentBySymbol(`${underlying}-EQ`, 'NSE')
            : await this.instruments.getInstrumentBySymbol(underlying, 'NSE');
      return inst?.token ? { token: inst.token, exchange: inst.exchange } : null;
    } catch (err) {
      this.logger.warn(`[signal-watch] quote line for ${underlying}: ${errText(err)}`);
      return null;
    }
  }
}
