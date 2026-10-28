import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { bootJobsEnabled } from '../../../common/utils/boot-jobs';
import { UserFeedManager } from '../../market-data/services/user-feed-manager.service';
import { SIGNAL_READY_EVENT, type SignalReadyEvent } from '../domain/types';
import {
  istDay,
  istMinutes,
  openingRange,
  sessionOpen,
  setupBroken,
  setupLevel,
  setupSignal,
  SETUP_CUTOFF_MIN,
  SETUP_OPEN_MIN,
  type Bar,
  type SetupForWatch,
} from '../domain/setup-watch';
import type { WatchClock } from '../domain/watch';
import { SignalIntakeRepository } from '../repositories/signal-intake.repository';
import { SIGNAL_CLOCK } from './signal-outcome.service';
import { SIGNAL_EMITTER } from './signal-intake.service';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** At most this many setups are quoted per tick (the owner's 10 req/s broker budget is shared). */
const MAX_POLL = 15;

/**
 * Night setups → paper (owner 2026-10-28; domain/setup-watch). Every 30 s from 09:30 to 13:00 IST on a
 * trading day: each of the owner's setups for today gets its first 15-min candle's range (once, over
 * the owner's own Angel session), is quoted, and on a break of the range edge becomes a trade_signals
 * row + `signal.ready` — the trader's gate + judge then decide and paper trade it. A quote, never an
 * order. SETUP_PAPER=off turns it off. Never throws out of the tick.
 */
@Injectable()
export class SetupWatchService {
  private readonly logger = new Logger(SetupWatchService.name);
  private busy = false;
  /** setup id → its opening range (the 09:15 bar never changes once it has closed). */
  private readonly ranges = new Map<string, { high: number; low: number }>();
  private rangesDay: string | null = null;

  constructor(
    private readonly repo: SignalIntakeRepository,
    @Inject(SIGNAL_CLOCK) private readonly clock: WatchClock,
    @Optional() private readonly feeds?: UserFeedManager,
    @Optional() @Inject(SIGNAL_EMITTER) private readonly emitter?: { emit(event: string, payload: unknown): unknown },
  ) {}

  private enabled(): boolean {
    return (process.env.SETUP_PAPER ?? 'on').trim().toLowerCase() !== 'off';
  }

  private owner(): string | null {
    return (process.env.HUB_OWNER_USER_ID ?? '').trim() || null;
  }

  @Cron('*/30 * * * * *', { timeZone: 'Asia/Kolkata' })
  async tick(): Promise<void> {
    if (!this.enabled() || !bootJobsEnabled() || this.busy) return;
    this.busy = true;
    try {
      await this.poll(new Date());
    } catch (err) {
      this.logger.warn(`[setup-watch] tick failed: ${errText(err)}`);
    } finally {
      this.busy = false;
    }
  }

  async poll(now: Date): Promise<{ checked: number; fired: number }> {
    const mins = istMinutes(now);
    const owner = this.owner();
    if (mins < SETUP_OPEN_MIN || mins >= SETUP_CUTOFF_MIN || !owner || !this.feeds) return { checked: 0, fired: 0 };
    if (!this.clock.isOpen('NSE', now)) return { checked: 0, fired: 0 };
    const day = istDay(now);
    if (this.rangesDay !== day) {
      this.ranges.clear();
      this.rangesDay = day;
    }
    const setups = await this.repo.setupsToWatch(owner, day);
    let checked = 0;
    let fired = 0;
    for (const s of setups) {
      if (checked >= MAX_POLL) break;
      if (!s.instrumentToken || !s.exchange) continue;
      const range = await this.rangeOf(owner, s);
      if (!range) continue;
      checked++;
      const q = await this.feeds.fetchQuote(owner, s.instrumentToken, s.exchange).catch(() => null);
      const ltp = q && Number.isFinite(q.ltp) && q.ltp > 0 ? q.ltp : null;
      const level = setupLevel(s.side, range);
      if (!setupBroken(s.side, level, ltp)) continue;
      try {
        await this.fire(s, { at: now, ltp: ltp as number, level, range });
        fired++;
      } catch (err) {
        this.logger.warn(`[setup-watch] firing ${s.symbol} ${level} failed: ${errText(err)}`);
      }
    }
    return { checked, fired };
  }

  private async rangeOf(owner: string, s: SetupForWatch): Promise<{ high: number; low: number } | null> {
    const hit = this.ranges.get(s.id);
    if (hit) return hit;
    try {
      const from = sessionOpen(s.sessionDate);
      const bars = (await this.feeds!.fetchCandles(owner, s.instrumentToken as string, s.exchange, '15m', from, new Date(from.getTime() + 15 * 60_000))) as Bar[];
      const range = openingRange(bars, s.sessionDate);
      if (range) this.ranges.set(s.id, range);
      return range;
    } catch (err) {
      this.logger.warn(`[setup-watch] opening range for ${s.symbol}: ${errText(err)}`);
      return null;
    }
  }

  private async fire(s: SetupForWatch, f: { at: Date; ltp: number; level: number; range: { high: number; low: number } }): Promise<void> {
    const signalId = await this.repo.createSignal(setupSignal(s, f));
    const ready: SignalReadyEvent = { signalId, clusterId: null, agreeCount: 1, conflict: false };
    this.emitter?.emit(SIGNAL_READY_EVENT, ready);
    this.logger.warn(`[setup-watch] ${s.side} ${s.symbol} broke ${f.level} at LTP ${f.ltp} → signal ${signalId}`);
  }
}
