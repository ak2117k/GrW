import type { NewSignal } from '../repositories/signal-intake.repository';

/**
 * Night setups traded in paper (owner 2026-10-28). Pure.
 *
 * Every trade setup carries the same rule: "wait for the first 15-min candle (09:15–09:30 IST) to
 * close; LONG on a break of its high (SHORT: its low); no break by 13:00 IST, no trade". From 09:30
 * the setup is watched on its own future; the break creates a trade_signals row (parser 'setup',
 * channel NIGHT_SETUP_CHANNEL) and emits `signal.ready`, so the trader's gate + judge decide it like
 * any channel call and paper trades it. The call's stop and T1 / T2 are the setup's own rule applied AT
 * THE BREAK (setupLevels): stop 1 R, T1 1.5 R, T2 2.5 R from the broken level, R = the setup's stop
 * distance. The night plan's printed prices are measured from the last close (on the cash chart, while
 * the watch reads the future), so after a gap they can sit on the wrong side of the entry — prod
 * 2026-11-03 MARICO LONG broke 851.2 with T1/T2 824.38 / 841.59 below it, a fake TARGET1 at once.
 * The after-close replay (trade-setup) still scores the setup itself; this only makes it trade live.
 */

/** The channel id setup calls are filed under (no telegram_channels row: lookups fall back to the id). */
export const NIGHT_SETUP_CHANNEL = 'night-setup';
/** The watch opens when the first 15-min candle has closed… */
export const SETUP_OPEN_MIN = 9 * 60 + 30;
/** …and a break after this is no trade. */
export const SETUP_CUTOFF_MIN = 13 * 60;

export interface SetupForWatch {
  id: string;
  sessionDate: string;
  symbol: string;
  /** FUTURES | CASH_MIS */
  instrumentKind: string;
  /** "<future symbol> (NFO futures, …)" or "<SYM> intraday cash (MIS)". */
  instrument: string;
  exchange: string;
  instrumentToken: string | null;
  expiry: string | null;
  /** LONG | SHORT */
  side: string;
  entryRule: string;
  stop: number;
  target1: number;
  target2: number;
  /** The setup's R (1× daily ATR); null on rows read without it — then |T2 − T1| (= 1 R) is used. */
  stopDistance?: number | null;
}

export interface Bar {
  timestamp: Date;
  high: number;
  low: number;
}

/** Minutes since IST midnight. */
export function istMinutes(at: Date): number {
  const d = new Date(at.getTime() + 5.5 * 3_600_000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/** IST 'YYYY-MM-DD'. */
export function istDay(at: Date): string {
  return new Date(at.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);
}

/** 09:15 IST of the session, as a UTC instant. */
export function sessionOpen(sessionDate: string): Date {
  return new Date(`${sessionDate}T09:15:00+05:30`);
}

/** The 09:15 15-min bar's high and low; null when the broker has not got it (yet). */
export function openingRange(bars: readonly Bar[], sessionDate: string): { high: number; low: number } | null {
  const open = sessionOpen(sessionDate).getTime();
  const bar = bars.find((b) => b.timestamp.getTime() === open);
  if (!bar || !(bar.high > 0) || !(bar.low > 0) || bar.low > bar.high) return null;
  return { high: bar.high, low: bar.low };
}

/** The level the setup waits for: the range's high for a LONG, its low for a SHORT. */
export function setupLevel(side: string, range: { high: number; low: number }): number {
  return side === 'SHORT' ? range.low : range.high;
}

/** Has the price broken the level in the setup's direction? */
export function setupBroken(side: string, level: number, ltp: number | null): boolean {
  if (ltp === null || !(ltp > 0)) return false;
  return side === 'SHORT' ? ltp < level : ltp > level;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const pos = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

/**
 * The call's stop and targets at the break: the setup's rule ("stop 1× ATR, T1 1.5 R, T2 2.5 R — from
 * your fill") on the broken level. R = the setup's stopDistance, else |T2 − T1| (the plan's 1 R step).
 * Without either, the printed levels are kept only when they lie on the right side of the level
 * (stop behind it, targets beyond it) — a wrong-side target is dropped, never passed on.
 */
export function setupLevels(
  s: Pick<SetupForWatch, 'side' | 'stop' | 'target1' | 'target2' | 'stopDistance'>,
  level: number,
): { sl: number | null; targets: number[]; r: number | null } {
  const dir = s.side === 'SHORT' ? -1 : 1;
  const r = pos(s.stopDistance) ? s.stopDistance : pos(s.target1) && pos(s.target2) && s.target1 !== s.target2 ? Math.abs(s.target2 - s.target1) : null;
  if (r !== null && pos(level)) {
    const sl = r2(level - dir * r);
    return { sl: sl > 0 ? sl : null, targets: [1.5, 2.5].map((m) => r2(level + dir * m * r)).filter((t) => t > 0), r: r2(r) };
  }
  const sl = pos(s.stop) && dir * (level - s.stop) > 0 ? s.stop : null;
  const targets = [s.target1, s.target2].filter((t) => pos(t) && dir * (t - level) > 0);
  return { sl, targets, r: null };
}

/** The trade_signals message id of a setup's call (unique: a setup trades at most once). */
export const setupMessageId = (setupId: string) => `setup:${setupId}`;

/** The trade_signals row a broken setup creates: ABOVE / BELOW the range edge, the setup's stop and targets from the break. */
export function setupSignal(s: SetupForWatch, fired: { at: Date; ltp: number; level: number; range: { high: number; low: number } }): NewSignal {
  const buy = s.side !== 'SHORT';
  const lv = setupLevels(s, fired.level);
  const levels = lv.r !== null ? `from the break: SL ${lv.sl ?? '—'} (1R ${lv.r}), T ${lv.targets.join(' / ') || '—'}` : `as printed: SL ${lv.sl ?? '—'}, T ${lv.targets.join(' / ') || '—'}`;
  const fut = s.instrumentKind === 'FUTURES';
  const tradingsymbol = fut ? s.instrument.split(' ')[0] : null;
  return {
    messageId: setupMessageId(s.id),
    channelId: NIGHT_SETUP_CHANNEL,
    receivedAt: fired.at,
    sessionDate: s.sessionDate,
    parser: 'setup',
    underlying: s.symbol,
    instrumentKind: fut ? 'FUT' : 'EQ',
    strike: null,
    expiry: fut ? s.expiry : null,
    expirySource: fut && s.expiry ? 'setup' : null,
    exchange: s.exchange,
    token: s.instrumentToken,
    tradingsymbol,
    side: buy ? 'BUY' : 'SELL',
    direction: buy ? 'BULL' : 'BEAR',
    entryLow: fired.level,
    entryHigh: fired.level,
    entryType: buy ? 'ABOVE' : 'BELOW',
    sl: lv.sl,
    targets: lv.targets,
    qty: null,
    horizon: 'INTRADAY',
    tags: ['NIGHT_SETUP'],
    confidence: 0.6,
    rawText: (
      `[night setup: ${buy ? 'LONG' : 'SHORT'} ${s.symbol} broke the first 15-min ${buy ? 'high' : 'low'} ${fired.level} ` +
      `(range ${fired.range.low}–${fired.range.high}), LTP ${fired.ltp}; ${levels}]\n${s.entryRule}`
    ).slice(0, 4000),
    dedupKey: `setup|${s.id}`,
  };
}
