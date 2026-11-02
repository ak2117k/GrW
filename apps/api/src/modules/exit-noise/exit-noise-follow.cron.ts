import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { bootJobsEnabled } from '../../common/utils/boot-jobs';
import { UserFeedManager } from '../market-data/services/user-feed-manager.service';
import { ExitNoiseRepository, type MinuteBar } from './exit-noise.repository';

const MIN = 60_000;
/** A read is followed once its 30 minutes are over. */
export const FOLLOW_AFTER_MIN = 30;
/** Reads older than this are not followed any more; without bars by then they are closed with nulls. */
const GIVE_UP_MIN = 24 * 60;
/** Reads followed per sweep. */
const PER_SWEEP = 50;
/** The 15- / 30-minute close: the bar nearest the mark, at most this far from it. */
const MARK_TOLERANCE_MIN = 3;

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const r2 = (x: number) => Math.round(x * 100) / 100;

/** The bars the follow-up reads: those that START after the exit, up to exit + 30 min, with a close. */
function windowBars(exitAt: Date, bars: readonly MinuteBar[]): MinuteBar[] {
  const t0 = exitAt.getTime();
  return bars.filter((b) => b.at.getTime() > t0 && b.at.getTime() <= t0 + FOLLOW_AFTER_MIN * MIN && b.close > 0);
}

/**
 * The 30 minutes after an exit, from the underlying's 1m bars (the bars that START after the exit, to
 * exit + 30 min): the closes nearest +15 / +30 min and the best excursion in the position's favour /
 * against it (bar highs / lows, ≥ 0). Null where the bars cannot say. Pure.
 */
export function followUp(want: string, exitAt: Date, u0: number | null, bars: readonly MinuteBar[]) {
  const t0 = exitAt.getTime();
  const after = windowBars(exitAt, bars);
  const mark = (min: number) => {
    let best: { d: number; c: number } | null = null;
    for (const b of after) {
      const d = Math.abs(b.at.getTime() - (t0 + min * MIN));
      if (d <= MARK_TOLERANCE_MIN * MIN && (!best || d < best.d)) best = { d, c: b.close };
    }
    return best?.c ?? null;
  };
  const out = { after15m: mark(15), after30m: mark(30), maxFavour30m: null as number | null, maxAgainst30m: null as number | null };
  if (u0 !== null && u0 > 0 && after.length > 0) {
    const hi = Math.max(...after.map((b) => (b.high > 0 ? b.high : b.close)));
    const lo = Math.min(...after.map((b) => (b.low > 0 ? b.low : b.close)));
    const bull = want === 'BULLISH';
    out.maxFavour30m = r2(Math.max(0, bull ? hi - u0 : u0 - lo));
    out.maxAgainst30m = r2(Math.max(0, bull ? u0 - lo : hi - u0));
  }
  return out;
}

/** How many bars of the 30-minute window followUp() would read. */
export function barsInWindow(exitAt: Date, bars: readonly MinuteBar[]): number {
  return windowBars(exitAt, bars).length;
}

/** Of the window's 30 one-minute bars, at least this many for candles_1m to count as covering it. */
export const COVER_MIN_BARS = 20;

/**
 * candles_1m "covers" a read's window when it has a close near +15 AND near +30 min (within the
 * 3-min mark tolerance) and at least {@link COVER_MIN_BARS} of the 30 bars, so the high / low
 * excursions are not read off a fragment. The hub writes candles_1m only for the ~30 tokens on its
 * live feed slots, so an underlying off the slots has holes (prod 2026-11-02 RELIANCE NSE 2885: no
 * bars 09:50–11:05 IST) or nothing at all (LAURUSLABS).
 */
export function covers(f: ReturnType<typeof followUp>, barCount: number): boolean {
  return f.after15m !== null && f.after30m !== null && barCount >= COVER_MIN_BARS;
}

/** Broker 1m-history calls per sweep, at most (Angel's historical limit is ~3/s; the session paces too). */
export const BROKER_CALLS_PER_SWEEP = 5;
/** Extra spacing between this sweep's history calls. */
const BROKER_GAP_MS = 400;
/** A read whose broker fetch failed or came back empty is not re-fetched sooner than this. */
const BROKER_RETRY_MIN = 15;
/**
 * The broker's history of a PAST window is complete, so a non-empty answer is final even without a
 * +30 close (the session closed inside the window) — once the window is this old (history lags the live edge).
 */
const BROKER_FINAL_AFTER_MIN = 45;

/**
 * Fills each exit noise read's follow-up (the underlying 15 / 30 min later, its excursions) once the
 * 30 minutes are over, so the night review can score the read. Every 5 min. The underlying line is
 * the one the read was taken on (exit_noise_reads.underlying_exchange / underlying_token).
 *
 * Sources, in order: the hub's candles_1m (DB); when they do not {@link covers cover} the window, the
 * broker's 1m history over the OWNER's own session (UserFeedManager.fetchCandles, HUB_OWNER_USER_ID) —
 * at most {@link BROKER_CALLS_PER_SWEEP} calls per sweep, spaced, each read at most every 15 min. A
 * broker failure or an empty answer counts as not-yet-available: the read is retried for a day, then
 * closed with what candles_1m had (or nulls). Without the broker (no UserFeedManager / no owner) a read
 * closes as soon as candles_1m say anything, as before. Which source filled it is kept in read.follow.
 * Off with BOOT_JOBS=false or EXIT_NOISE_READS=off.
 */
@Injectable()
export class ExitNoiseFollowCron {
  private readonly logger = new Logger(ExitNoiseFollowCron.name);
  private busy = false;
  /** Read id → last broker attempt that did not close it (failed or empty), for BROKER_RETRY_MIN. */
  private readonly brokerTried = new Map<string, number>();
  /** Overridable in tests. */
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((res) => setTimeout(res, ms));

  constructor(
    private readonly repo: ExitNoiseRepository,
    @Optional() private readonly feeds?: UserFeedManager,
  ) {}

  @Cron('0 */5 * * * *', { timeZone: 'Asia/Kolkata' })
  async tick(): Promise<void> {
    if (!bootJobsEnabled() || (process.env.EXIT_NOISE_READS ?? 'on').trim().toLowerCase() === 'off' || this.busy) return;
    this.busy = true;
    try {
      await this.sweep(new Date());
    } catch (err) {
      this.logger.warn(`[exit-noise] follow sweep failed: ${errText(err)}`);
    } finally {
      this.busy = false;
    }
  }

  async sweep(now: Date): Promise<number> {
    const rows = await this.repo.unfollowed(new Date(now.getTime() - FOLLOW_AFTER_MIN * MIN), new Date(now.getTime() - GIVE_UP_MIN * MIN), PER_SWEEP);
    for (const [id, at] of this.brokerTried) if (now.getTime() - at > (GIVE_UP_MIN + 60) * MIN) this.brokerTried.delete(id);
    const owner = (process.env.HUB_OWNER_USER_ID ?? '').trim() || null;
    const feeds = this.feeds && owner ? this.feeds : null;
    let brokerCalls = 0;
    let done = 0;
    for (const r of rows) {
      try {
        // A read with no underlying line or exit price can never be followed: closed now.
        if (!r.underlyingExchange || !r.underlyingToken || r.underlyingAtExit === null) {
          await this.repo.setFollow(r.id, followUp(r.want, r.exitAt, r.underlyingAtExit, []), now, { source: 'none', note: 'no underlying line or exit price' });
          done += 1;
          continue;
        }
        const ageMin = (now.getTime() - r.exitAt.getTime()) / MIN;
        const to = new Date(r.exitAt.getTime() + (FOLLOW_AFTER_MIN + 1) * MIN);
        const bars = await this.repo.minuteBars(r.underlyingExchange, r.underlyingToken, r.exitAt, to);
        const f = followUp(r.want, r.exitAt, r.underlyingAtExit, bars);
        const n = barsInWindow(r.exitAt, bars);
        if (covers(f, n)) {
          await this.repo.setFollow(r.id, f, now, { source: 'candles_1m', bars: n });
          this.brokerTried.delete(r.id);
          done += 1;
          continue;
        }

        const lastTry = this.brokerTried.get(r.id);
        if (feeds && owner && brokerCalls < BROKER_CALLS_PER_SWEEP && (lastTry === undefined || now.getTime() - lastTry >= BROKER_RETRY_MIN * MIN)) {
          if (brokerCalls > 0) await this.sleep(BROKER_GAP_MS);
          brokerCalls += 1;
          try {
            const candles = await feeds.fetchCandles(owner, r.underlyingToken, r.underlyingExchange, '1m', new Date(r.exitAt.getTime() - MIN), to);
            const bb: MinuteBar[] = (candles ?? []).map((c) => ({ at: c.timestamp, high: Number(c.high), low: Number(c.low), close: Number(c.close), volume: Number(c.volume ?? 0) }));
            const fb = followUp(r.want, r.exitAt, r.underlyingAtExit, bb);
            const nb = barsInWindow(r.exitAt, bb);
            if (nb > 0 && (fb.after30m !== null || ageMin >= BROKER_FINAL_AFTER_MIN)) {
              await this.repo.setFollow(r.id, fb, now, { source: 'broker', bars: nb, candles1mBars: n });
              this.brokerTried.delete(r.id);
              done += 1;
              continue;
            }
            this.brokerTried.set(r.id, now.getTime());
          } catch (err) {
            this.brokerTried.set(r.id, now.getTime());
            this.logger.warn(`[exit-noise] broker 1m history for ${r.id} (${r.underlyingExchange}:${r.underlyingToken}) failed, retried later: ${errText(err)}`);
          }
        }

        // No broker to ask: close as soon as candles_1m say anything (the pre-broker behaviour).
        // Otherwise retried each sweep until a day has passed, then closed with what candles_1m had.
        const something = f.after15m !== null || f.after30m !== null || f.maxFavour30m !== null;
        const giveUp = ageMin >= GIVE_UP_MIN - 10;
        if ((!feeds && something) || giveUp) {
          await this.repo.setFollow(r.id, f, now, { source: n > 0 ? 'candles_1m' : 'none', bars: n, partial: true, ...(giveUp ? { note: 'gave up after a day' } : {}) });
          this.brokerTried.delete(r.id);
          done += 1;
        }
      } catch (err) {
        this.logger.warn(`[exit-noise] follow-up of ${r.id}: ${errText(err)}`);
      }
    }
    if (done > 0 || brokerCalls > 0) this.logger.log(`[exit-noise] followed up ${done} exit noise read(s); ${brokerCalls} broker 1m history call(s)`);
    return done;
  }
}
