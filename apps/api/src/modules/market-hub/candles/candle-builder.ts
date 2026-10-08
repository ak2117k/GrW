import { refKey, type InstrumentRef, type Price } from '../hub.types';
import type { HubCandle } from './candle.types';
import { istDay } from './trading-calendar';

export interface ClosedBar {
  ref: InstrumentRef;
  candle: HubCandle;
}

const MINUTE_MS = 60_000;

/**
 * Live ticks → 1-minute bars, for live-tier instruments only. Angel's tick
 * volume is the day's RUNNING TOTAL; a bar's volume is the difference between
 * ticks (summing it is the legacy double count). The first tick seen for an
 * instrument on a day only sets the baseline: the hub cannot know how much of
 * the running total traded in this minute. The nightly fix-up replaces these
 * bars with the broker's anyway.
 */
export class CandleBuilder {
  private readonly open = new Map<string, ClosedBar>();
  private readonly cumulative = new Map<string, { day: string; volume: number }>();
  private lateTicks = 0;

  constructor(private readonly graceMs = 2000) {}

  /** Returns the bar this tick closed (the instrument's previous minute), if any. */
  onPrice(p: Price): ClosedBar[] {
    if (!(p.ltp > 0)) return [];
    const key = refKey(p.ref);
    const minute = Math.floor(p.at / MINUTE_MS) * MINUTE_MS;
    const delta = this.volumeDelta(key, p);
    const closed: ClosedBar[] = [];
    const current = this.open.get(key);
    if (current && minute < current.candle.ts) {
      this.lateTicks++;
      return [];
    }
    if (current && minute > current.candle.ts) {
      closed.push(current);
      this.open.delete(key);
    }
    const bar = this.open.get(key);
    if (bar) {
      const c = bar.candle;
      c.high = Math.max(c.high, p.ltp);
      c.low = Math.min(c.low, p.ltp);
      c.close = p.ltp;
      c.volume += delta;
      if (p.oi !== undefined) c.oi = p.oi;
    } else {
      const candle: HubCandle = { ts: minute, open: p.ltp, high: p.ltp, low: p.ltp, close: p.ltp, volume: delta };
      if (p.oi !== undefined) candle.oi = p.oi;
      this.open.set(key, { ref: p.ref, candle });
    }
    return closed;
  }

  /** Close every bar whose minute ended more than `graceMs` ago (quiet instruments). */
  closeDue(now: number): ClosedBar[] {
    const out: ClosedBar[] = [];
    for (const [key, bar] of this.open) {
      if (bar.candle.ts + MINUTE_MS + this.graceMs <= now) {
        out.push(bar);
        this.open.delete(key);
      }
    }
    const today = istDay(now);
    for (const [key, c] of this.cumulative) if (c.day !== today && !this.open.has(key)) this.cumulative.delete(key);
    return out;
  }

  stats(): { building: number; lateTicks: number } {
    return { building: this.open.size, lateTicks: this.lateTicks };
  }

  private volumeDelta(key: string, p: Price): number {
    if (p.volume === undefined || !Number.isFinite(p.volume)) return 0;
    const day = istDay(p.at);
    const prev = this.cumulative.get(key);
    if (!prev || prev.day !== day) {
      this.cumulative.set(key, { day, volume: p.volume });
      return 0;
    }
    if (p.volume <= prev.volume) return 0; // out of order or unchanged: never negative
    const delta = p.volume - prev.volume;
    prev.volume = p.volume;
    return delta;
  }
}
