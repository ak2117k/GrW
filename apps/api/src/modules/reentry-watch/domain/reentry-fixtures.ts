import type { Bar1m } from '../../entry-engine/domain/entry-decision';

/**
 * Test fixtures: 1-minute index bars reconstructed around the 2026-11-05 prod exits (the exit points and the
 * later premiums are from the prod trades; the index paths between them are shaped to the reported moves, the
 * prod DB was not reachable from the build machine). Index volume is 0 (the trend uses TWAP), as in prod.
 */
const MIN = 60_000;

export const istTs = (ymd: string, hhmm: string): number => Date.parse(`${ymd}T${hhmm}:00+05:30`);

/** Minute bars from the first point to the last (exclusive), linear between points, zig-zag ± wiggle/2. */
export function pathBars(ymd: string, points: ReadonlyArray<readonly [string, number]>, wiggle: number): Bar1m[] {
  const out: Bar1m[] = [];
  let prev = points[0][1];
  for (let p = 0; p < points.length - 1; p++) {
    const a = istTs(ymd, points[p][0]);
    const b = istTs(ymd, points[p + 1][0]);
    const steps = (b - a) / MIN;
    for (let i = 0; i < steps; i++) {
      const base = points[p][1] + ((points[p + 1][1] - points[p][1]) * i) / steps;
      const close = base + (out.length % 2 === 0 ? wiggle / 2 : -wiggle / 2);
      out.push({ ts: a + i * MIN, open: prev, high: Math.max(prev, close) + wiggle / 4, low: Math.min(prev, close) - wiggle / 4, close, volume: 0 });
      prev = close;
    }
  }
  return out;
}

/** NIFTY: two gently rising sessions, then 2026-11-05 — up, a pullback to the 10:01 exit (≈24,402), then the run. */
export function niftyBars(): Bar1m[] {
  return [
    ...pathBars('2026-11-03', [['09:15', 24100], ['12:00', 24180], ['15:30', 24250]], 20),
    ...pathBars('2026-11-04', [['09:15', 24260], ['12:00', 24300], ['15:30', 24330]], 20),
    ...pathBars('2026-11-05', [['09:15', 24350], ['09:50', 24445], ['10:01', 24402], ['10:20', 24410], ['11:00', 24480], ['13:00', 24560], ['15:30', 24570]], 20),
  ];
}

/** NIFTY reversal: the same morning, then after the 10:01 exit the index rolls over and falls. */
export function niftyReversalBars(): Bar1m[] {
  return [
    ...pathBars('2026-11-03', [['09:15', 24300], ['12:00', 24280], ['15:30', 24250]], 20),
    ...pathBars('2026-11-04', [['09:15', 24260], ['12:00', 24250], ['15:30', 24240]], 20),
    ...pathBars('2026-11-05', [['09:15', 24300], ['09:50', 24445], ['10:01', 24402], ['10:30', 24360], ['11:30', 24250], ['13:00', 24180], ['15:30', 24170]], 20),
  ];
}

/** BANKNIFTY: up into 09:55, the pullback to the 10:07 exit (≈56,880), then the afternoon run. */
export function bankNiftyBars(): Bar1m[] {
  return [
    ...pathBars('2026-11-03', [['09:15', 56200], ['12:00', 56350], ['15:30', 56450]], 50),
    ...pathBars('2026-11-04', [['09:15', 56450], ['12:00', 56520], ['15:30', 56580]], 50),
    ...pathBars('2026-11-05', [['09:15', 56600], ['09:55', 56960], ['10:07', 56880], ['10:30', 56900], ['11:30', 57100], ['13:43', 57350], ['15:30', 57380]], 50),
  ];
}
