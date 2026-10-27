import type { NewSignal } from '../repositories/signal-intake.repository';
import { asInfoItems } from './info';
import type { UnderlyingClass } from './vocabulary';

/**
 * Watched breakout levels (owner 2026-10-27, step 2 of the INFO work). Pure.
 *
 * A WATCH item with a level ("Radico breakout above 4330", "BSE breakout above 3500") becomes a
 * watch on the underlying's LTP. When the price crosses it, a trade_signals row is created and
 * `signal.ready` emitted, so the trader judges it like any channel call (the late-entry rule and
 * the room check apply when the price is already past the level). A watch lives for the rest of the
 * current / next session plus one more, then expires. Items without a level are not watched.
 */

export interface WatchDraft {
  itemIndex: number;
  underlying: string;
  /** EQ for a stock; an index or a commodity has no cash line, so it trades as the nearest FUT. */
  instrumentKind: 'EQ' | 'FUT';
  /** BUY = breakout above the level; SELL = breakdown below it. */
  side: 'BUY' | 'SELL';
  level: number;
}

/** The watches a stored channel_infos `items` value asks for (WATCH items with a level and a direction). */
export function watchesFromItems(raw: unknown, classOf: (underlying: string) => UnderlyingClass | undefined): WatchDraft[] {
  const out: WatchDraft[] = [];
  asInfoItems(raw).forEach((it, i) => {
    if (it.kind !== 'WATCH' || it.levels.length === 0) return;
    if (it.bias !== 'BULL' && it.bias !== 'BEAR') return;
    const cls = classOf(it.underlying);
    if (!cls) return;
    const side = it.bias === 'BULL' ? 'BUY' : 'SELL';
    // "breakout above 3500" with other levels mentioned: the breakout is the outermost one.
    const level = side === 'BUY' ? Math.max(...it.levels) : Math.min(...it.levels);
    out.push({ itemIndex: i, underlying: it.underlying, instrumentKind: cls === 'STOCK' ? 'EQ' : 'FUT', side, level });
  });
  return out;
}

/** Has the underlying crossed the level in the watch's direction? */
export function watchCrossed(side: 'BUY' | 'SELL', level: number, ltp: number | null): boolean {
  if (ltp === null || !(ltp > 0)) return false;
  return side === 'BUY' ? ltp >= level : ltp <= level;
}

/** The parts of a SessionClock the expiry needs. */
export interface WatchClock {
  isOpen(exchange: string, at: Date): boolean;
  nextOpen(exchange: string, at: Date): Date | null;
  tradingWindow(exchange: string, at: Date): { openMin: number; closeMin: number } | null;
}

/** Close of the session after the current (or next) one; null when the calendar has none. */
export function watchExpiry(clock: WatchClock, exchange: string, postedAt: Date): Date | null {
  const first = clock.isOpen(exchange, postedAt) ? postedAt : clock.nextOpen(exchange, postedAt);
  if (!first) return null;
  const second = clock.nextOpen(exchange, first);
  if (!second) return null;
  const w = clock.tradingWindow(exchange, second);
  if (!w) return null;
  return new Date(second.getTime() + (w.closeMin - w.openMin) * 60_000);
}

/**
 * Stop for a fired watch: just beyond the breakout level — back through it, the breakout failed. 1% for
 * a stock, 0.5% for an index / commodity future (a NIFTY 1% is ~230 points). The judge may tighten it.
 */
export function watchStop(side: 'BUY' | 'SELL', instrumentKind: string, level: number): number {
  const pct = instrumentKind === 'EQ' ? 0.01 : 0.005;
  return Math.round((side === 'BUY' ? level * (1 - pct) : level * (1 + pct)) * 100) / 100;
}

/** The trade_signals row a fired watch creates: an ABOVE / BELOW entry at the level, the failed-breakout stop, no targets. */
export function watchSignal(
  w: { messageId: string; itemIndex: number; channelId: string; underlying: string; instrumentKind: string; side: string; level: number },
  fired: { at: Date; ltp: number; sessionDate: string; postText: string },
): NewSignal {
  const buy = w.side === 'BUY';
  return {
    messageId: `${w.messageId}:watch:${w.itemIndex}`,
    channelId: w.channelId,
    receivedAt: fired.at,
    sessionDate: fired.sessionDate,
    parser: 'watch',
    underlying: w.underlying,
    instrumentKind: w.instrumentKind,
    strike: null,
    expiry: null,
    expirySource: null,
    exchange: null,
    token: null,
    tradingsymbol: null,
    side: w.side,
    direction: buy ? 'BULL' : 'BEAR',
    entryLow: w.level,
    entryHigh: w.level,
    entryType: buy ? 'ABOVE' : 'BELOW',
    sl: watchStop(buy ? 'BUY' : 'SELL', w.instrumentKind, w.level),
    targets: [],
    qty: null,
    horizon: 'INTRADAY',
    tags: ['WATCH'],
    confidence: 0.5,
    rawText: `[watch fired: ${w.underlying} ${buy ? 'crossed above' : 'fell below'} ${w.level}, LTP ${fired.ltp}]\n${fired.postText}`.slice(0, 4000),
    dedupKey: `watch|${w.channelId}|${w.underlying}|${w.side}|${w.level}`,
  };
}
