import { Inject, Injectable, Logger, Optional, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { bootJobsEnabled } from '../../../common/utils/boot-jobs';
import { TICK_STREAM, type StreamTick, type TickStream } from '../ports/tick-stream.port';
import { givebackOffPeak } from '../tripwires/giveback-off-peak.tripwire';
import { levelBreak } from '../tripwires/level-break.tripwire';
import type { TripwireFire, TripwireInput } from '../tripwires/types';
import { SentinelRunnerService } from './sentinel-runner.service';
import { TickSensorBook, type TickSensorContext } from './tick-sensor-book';

export const TICK_EVAL_MIN_MS = 1_000;
export const WAKE_COOLDOWN_MS = 15_000;
export const SUBSCRIBE_EVERY_MS = 10_000;

/** The two price-only sensors over a context. Pure; a throwing sensor is silent. */
export function tickFires(ctx: TickSensorContext): TripwireFire[] {
  const input: TripwireInput = {
    trackerId: ctx.trackerId, symbol: ctx.symbol, segment: ctx.segment, side: ctx.side, entryPrice: ctx.entryPrice,
    qty: 0, ltp: ctx.ltp, underlyingLtp: ctx.underlyingLtp, holdingHigh: ctx.holdingHigh, holdingLow: ctx.holdingLow,
    nearestSupport: ctx.nearestSupport, nearestResistance: ctx.nearestResistance, volumeRatio: null,
    oiWallNow: null, oiWallPrev: null, freshNewsCount: null, factorValues: {}, prevFactorValues: {},
  };
  const out: TripwireFire[] = [];
  for (const t of [levelBreak, givebackOffPeak]) {
    try {
      const f = t.check(input);
      if (f) out.push(f);
    } catch {
      // A broken sensor degrades to silence; the 30-s cron still runs it with logging.
    }
  }
  return out;
}

/**
 * Part B (spec §4, plan R14). Level break and giveback, evaluated on hub ticks
 * (≤ 1/s per tracker). A RISING-EDGE fire wakes the user's ordinary sensor pass —
 * every existing cap applies there. The cron stays the fallback and runs the
 * other four sensors. Tick path: synchronous, O(contexts on the key), no I/O.
 */
@Injectable()
export class TickTripwireService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TickTripwireService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private on = false;
  private readonly unsubs = new Map<string, () => void>();
  private readonly lastWake = new Map<string, number>();

  constructor(
    private readonly book: TickSensorBook,
    private readonly runner: SentinelRunnerService,
    @Inject(TICK_STREAM) private readonly stream: TickStream,
    @Optional() private readonly config?: ConfigService,
  ) {}

  onModuleInit(): void {
    this.start({
      shadow: this.config?.get<string>('SENTINEL_SHADOW_ENABLED') === 'true',
      tickTripwires: this.config?.get<string>('SENTINEL_TICK_TRIPWIRES') !== 'false',
    });
  }

  start(cfg: { shadow: boolean; tickTripwires: boolean }): boolean {
    if (!bootJobsEnabled() || !cfg.shadow || !cfg.tickTripwires) {
      if (cfg.shadow && !cfg.tickTripwires) this.logger.log('[sentinel-tick] tick tripwires off (SENTINEL_TICK_TRIPWIRES=false)');
      return false;
    }
    this.on = true;
    this.timer = setInterval(() => this.subscribeNew(), SUBSCRIBE_EVERY_MS);
    this.timer.unref?.();
    this.logger.log('[sentinel-tick] level-break and giveback also run on hub ticks (≤ 1/s per position)');
    return true;
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const off of this.unsubs.values()) off();
    this.unsubs.clear();
    this.on = false;
  }

  /** Subscribe users the cycle has published and we have not subscribed yet. */
  subscribeNew(): void {
    if (!this.on) return;
    for (const u of this.book.users()) {
      if (this.unsubs.has(u)) continue;
      const off = this.stream.subscribe(u, (t) => this.onTick(u, t));
      if (off) this.unsubs.set(u, off);
    }
  }

  onTick(userId: string, t: StreamTick, now: number = Date.now()): void {
    for (const ctx of this.book.forKey(t.key)) {
      if (ctx.userId !== userId) continue;
      if (t.key === ctx.contractKey) {
        ctx.ltp = t.ltp;
        if (ctx.side === 'LONG') ctx.holdingHigh = Math.max(ctx.holdingHigh ?? t.ltp, t.ltp);
        else ctx.holdingLow = Math.min(ctx.holdingLow ?? t.ltp, t.ltp);
      }
      if (t.key === ctx.underlyingKey) ctx.underlyingLtp = t.ltp;
      if (now - ctx.lastEvalAt < TICK_EVAL_MIN_MS) continue;
      ctx.lastEvalAt = now;
      const fires = tickFires(ctx);
      const was = ctx.firing;
      ctx.firing = fires.length > 0;
      if (!ctx.firing || was) continue;
      if (now - (this.lastWake.get(userId) ?? -Infinity) < WAKE_COOLDOWN_MS) continue;
      this.lastWake.set(userId, now);
      this.runner.wakeForTick(userId, `${fires.map((f) => f.name).join(', ')} on ${ctx.symbol}`);
    }
  }
}
