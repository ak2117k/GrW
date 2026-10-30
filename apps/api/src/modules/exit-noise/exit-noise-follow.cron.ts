import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { bootJobsEnabled } from '../../common/utils/boot-jobs';
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

/**
 * The 30 minutes after an exit, from the underlying's 1m bars (the bars that START after the exit, to
 * exit + 30 min): the closes nearest +15 / +30 min and the best excursion in the position's favour /
 * against it (bar highs / lows, ≥ 0). Null where the bars cannot say. Pure.
 */
export function followUp(want: string, exitAt: Date, u0: number | null, bars: readonly MinuteBar[]) {
  const t0 = exitAt.getTime();
  const after = bars.filter((b) => b.at.getTime() > t0 && b.at.getTime() <= t0 + FOLLOW_AFTER_MIN * MIN && b.close > 0);
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

/**
 * Fills each exit noise read's follow-up (the underlying 15 / 30 min later, its excursions) from
 * candles_1m once the 30 minutes are over, so the night review can score the read. Every 5 min;
 * DB only (reads candles_1m, writes exit_noise_reads). Off with BOOT_JOBS=false or EXIT_NOISE_READS=off.
 */
@Injectable()
export class ExitNoiseFollowCron {
  private readonly logger = new Logger(ExitNoiseFollowCron.name);
  private busy = false;

  constructor(private readonly repo: ExitNoiseRepository) {}

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
    let done = 0;
    for (const r of rows) {
      try {
        const bars = r.underlyingExchange && r.underlyingToken
          ? await this.repo.minuteBars(r.underlyingExchange, r.underlyingToken, r.exitAt, new Date(r.exitAt.getTime() + (FOLLOW_AFTER_MIN + 1) * MIN))
          : [];
        const f = followUp(r.want, r.exitAt, r.underlyingAtExit, bars);
        const nothing = f.after15m === null && f.after30m === null && f.maxFavour30m === null;
        // No bars yet (a late hub write): retried next sweep until a day has passed, then closed with nulls.
        // A read with no underlying line or exit price can never be followed: closed now.
        const followable = !!r.underlyingExchange && !!r.underlyingToken && r.underlyingAtExit !== null;
        if (nothing && followable && now.getTime() - r.exitAt.getTime() < GIVE_UP_MIN * MIN - 10 * MIN) continue;
        await this.repo.setFollow(r.id, f, now);
        done += 1;
      } catch (err) {
        this.logger.warn(`[exit-noise] follow-up of ${r.id}: ${errText(err)}`);
      }
    }
    if (done > 0) this.logger.log(`[exit-noise] followed up ${done} exit noise read(s)`);
    return done;
  }
}
