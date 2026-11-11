import type { TrendBar } from '../../signal-trader/domain/trend-tag';
import { ENTRY_ENGINE, type Bar1m } from './entry-decision';
import {
  applyEntryGates,
  atr15,
  chaseGate,
  clusterGate,
  extensionReading,
  gateLine,
  inIndexCluster,
  indicatorGate,
  indicatorReading,
  rollTo15m,
  sessionBars,
  type ExtensionReading,
  type IndicatorReading,
} from './entry-gates';

const MIN = 60_000;
/** IST wall time → epoch ms. */
const ist = (s: string) => Date.parse(`${s}+05:30`);

const ind = (o: Partial<IndicatorReading> = {}): IndicatorReading => ({
  direction: 'BULLISH',
  tag: 'WITH',
  trend: 'UP',
  ema20: 100,
  ema80: 95,
  macdHist: 2,
  macdPrevHist: 1,
  rsi: 60,
  bars: 200,
  lastBarAt: null,
  source: 'test',
  ...o,
});

const ext = (o: Partial<ExtensionReading> = {}): ExtensionReading => ({ direction: 'BULLISH', price: 110, n15: 10, swingRef: 105, fromSwingN15: 0.5, ema20: 100, fromEma20N15: 1, ...o });

/** `n` NSE sessions of 15m bars (25 a day, 09:15..15:15 IST, weekdays) ending on 2026-11-11, closes from `f(i)`. */
function sessions15(n: number, f: (i: number) => number): TrendBar[] {
  const out: TrendBar[] = [];
  let i = 0;
  for (let d = n + 6; d >= 0; d--) {
    const day = ist('2026-11-11T09:15:00') - d * 86_400_000;
    const wd = new Date(day + 330 * MIN).getUTCDay();
    if (wd === 0 || wd === 6) continue;
    for (let k = 0; k < 25; k++) {
      const c = f(i);
      const p = i === 0 ? c : f(i - 1);
      out.push({ ts: day + k * 15 * MIN, open: p, high: Math.max(p, c) + 1, low: Math.min(p, c) - 1, close: c });
      i++;
    }
  }
  return out.slice(-n * 25);
}

describe('entry gates — session bars', () => {
  it('drops off-session, weekend and frozen copies (the hub writes flat index bars all night), keeps MCX evenings', () => {
    const bar = (t: string, c: number, flat = false) => ({ ts: ist(t), open: flat ? c : c - 1, high: flat ? c : c + 2, low: flat ? c : c - 2, close: c });
    const nse = sessionBars(
      [
        bar('2026-11-11T09:00:00', 25576), // pre-open auction
        bar('2026-11-11T09:15:00', 25340),
        bar('2026-11-11T09:30:00', 25410),
        bar('2026-11-11T09:45:00', 25410, true), // frozen copy of the previous close
        bar('2026-11-11T15:30:00', 25410, true), // after the close
        bar('2026-11-11T20:00:00', 25410, true),
        bar('2026-11-14T10:00:00', 25410), // Saturday
      ],
      'NSE',
    );
    expect(nse.map((b) => b.close)).toEqual([25340, 25410]);
    const mcx = sessionBars([bar('2026-11-11T08:45:00', 9000), bar('2026-11-11T09:00:00', 9001), bar('2026-11-11T22:30:00', 9050), bar('2026-11-11T23:55:00', 9050)], 'MCX');
    expect(mcx.map((b) => b.close)).toEqual([9001, 9050]);
  });

  it('rolls 1m bars into completed 15m buckets only', () => {
    const m: Bar1m[] = [];
    for (let i = 0; i < 40; i++) m.push({ ts: ist('2026-11-11T09:15:00') + i * MIN, open: 100 + i, high: 101 + i, low: 99 + i, close: 100.5 + i, volume: 0 });
    const r = rollTo15m(m, new Date(ist('2026-11-11T09:55:00')));
    expect(r).toHaveLength(2); // 09:15 and 09:30; 09:45 is still forming
    expect(r[0]).toEqual({ ts: ist('2026-11-11T09:15:00'), open: 100, high: 115, low: 99, close: 114.5 });
  });
});

describe('entry gates — N15', () => {
  it('is the mean true range of the last 14 bars; a session’s first bar is its own range (no overnight gap)', () => {
    const bars: TrendBar[] = [];
    for (let i = 0; i < 15; i++) bars.push({ ts: ist('2026-11-10T09:15:00') + i * 15 * MIN, open: 100, high: 105, low: 95, close: 100 });
    expect(atr15(bars)).toBe(10);
    // Next morning gaps up 300 with a 20-pt first bar: TR counts 20, not 305.
    const gap = [...bars.slice(1), { ts: ist('2026-11-11T09:15:00'), open: 400, high: 410, low: 390, close: 400 }];
    expect(atr15(gap)).toBeCloseTo((13 * 10 + 20) / 14, 6);
    // Inside a session a gap from the previous close does count.
    const inSession = [...bars.slice(1), { ts: ist('2026-11-10T13:00:00'), open: 120, high: 125, low: 115, close: 120 }];
    expect(atr15(inSession)).toBeCloseTo((13 * 10 + 25) / 14, 6);
    expect(atr15(bars.slice(0, 10))).toBeNull();
  });
});

describe('entry gates — indicators', () => {
  it('reads the signal-trader trend tag + MACD (with the previous bar) + RSI for the direction', () => {
    const up = sessions15(8, (i) => 25_000 + i * i * 0.05 + (i % 3 === 0 ? -3 : 0));
    const r = indicatorReading(up, 'BULLISH', new Date(ist('2026-11-11T15:31:00')), 'test');
    expect(r.tag).toBe('WITH');
    expect(r.macdHist).not.toBeNull();
    expect(r.macdPrevHist).not.toBeNull();
    expect(r.rsi!).toBeGreaterThan(50);
    expect(indicatorReading(up, 'BEARISH', new Date(ist('2026-11-11T15:31:00')), 'test').tag).toBe('AGAINST');
    const few = indicatorReading(up.slice(-50), 'BULLISH', new Date(ist('2026-11-11T15:31:00')), 'test');
    expect(few).toMatchObject({ tag: 'UNKNOWN', macdHist: null, macdPrevHist: null });
  });

  it('AGAINST blocks; MACD neither positive nor rising blocks; positive OR rising passes; mirrored for PE', () => {
    expect(indicatorGate(ind({ tag: 'AGAINST' })).verdict).toBe('BLOCK');
    expect(indicatorGate(ind({ tag: 'MIXED', macdHist: -2, macdPrevHist: -1 })).verdict).toBe('BLOCK');
    expect(indicatorGate(ind({ tag: 'MIXED', macdHist: -2, macdPrevHist: -3 })).verdict).toBe('PASS'); // rising toward 0
    expect(indicatorGate(ind({ macdHist: 2, macdPrevHist: 3 })).verdict).toBe('PASS'); // positive, falling
    expect(indicatorGate(ind({ direction: 'BEARISH', macdHist: 2, macdPrevHist: 1 })).verdict).toBe('BLOCK');
    expect(indicatorGate(ind({ direction: 'BEARISH', macdHist: -2, macdPrevHist: -1 })).verdict).toBe('PASS');
  });

  it('RSI at / beyond the extreme line waits (CE overbought, PE oversold); UNKNOWN never blocks', () => {
    expect(indicatorGate(ind({ rsi: ENTRY_ENGINE.rsiOverbought })).verdict).toBe('WAIT');
    expect(indicatorGate(ind({ rsi: ENTRY_ENGINE.rsiOverbought - 0.1 })).verdict).toBe('PASS');
    expect(indicatorGate(ind({ direction: 'BEARISH', macdHist: -1, macdPrevHist: 0, rsi: ENTRY_ENGINE.rsiOversold })).verdict).toBe('WAIT');
    expect(indicatorGate(ind({ tag: 'UNKNOWN', macdHist: null, macdPrevHist: null, reason: '50 bars' }))).toMatchObject({ verdict: 'UNKNOWN' });
    expect(indicatorGate(ind({ tag: 'UNKNOWN', macdHist: null, macdPrevHist: null, rsi: 95 })).verdict).toBe('WAIT');
  });

  it('the compact reading is what the trade summary shows', () => {
    expect(gateLine('indicators', indicatorGate(ind({ macdHist: 32.1154, macdPrevHist: 22.89, rsi: 83.67 })))).toMatch(/^indicators: ✓ WITH, MACD 32\.1 rising, RSI 84 — /);
  });
});

describe('entry gates — chase', () => {
  it('measures the run from the 30-min low (CE) / high (PE) and the EMA20, in N15', () => {
    const at = new Date(ist('2026-11-11T09:50:00'));
    const bars15: TrendBar[] = [];
    for (let i = 0; i < 30; i++) bars15.push({ ts: ist('2026-11-10T09:15:00') + i * 15 * MIN, open: 100, high: 105, low: 95, close: 100 });
    const bars1m: Bar1m[] = [];
    for (let i = 0; i < 35; i++) bars1m.push({ ts: ist('2026-11-11T09:15:00') + i * MIN, open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 0 });
    const e = extensionReading({ bars15, bars1m, price: 134, at, direction: 'BULLISH' });
    // 30-min window from 09:20 → lowest low 99 + 5 = 104; N15 10; EMA20 100.
    expect(e).toMatchObject({ n15: 10, swingRef: 104, fromSwingN15: 3, ema20: 100, fromEma20N15: 3.4 });
    const pe = extensionReading({ bars15, bars1m, price: 134, at, direction: 'BEARISH' });
    expect(pe).toMatchObject({ swingRef: 135, fromSwingN15: 0.1, fromEma20N15: -3.4 });
  });

  it('waits at / beyond the swing threshold; the EMA20 distance is recorded only; unreadable never blocks', () => {
    const max = ENTRY_ENGINE.maxFromSwingN15;
    expect(chaseGate(ext({ fromSwingN15: max })).verdict).toBe('WAIT');
    expect(chaseGate(ext({ fromSwingN15: max - 0.01, fromEma20N15: 9 })).verdict).toBe('PASS');
    expect(chaseGate(ext({ fromSwingN15: null, fromEma20N15: null })).verdict).toBe('UNKNOWN');
    expect(chaseGate(ext({ fromSwingN15: 1.61 })).reason).toContain('already extended (1.61 ≥ 1.5 N15 off the low)');
  });
});

describe('entry gates — index cluster', () => {
  const base = { underlying: 'BANKNIFTY', direction: 'BULLISH' as const, openBullish: 0, openBearish: 0, enteredThisPass: [] as string[] };
  it('one open engine position per direction and one new entry per scan, across NIFTY/BANKNIFTY/SENSEX/FINNIFTY/MIDCPNIFTY/BANKEX', () => {
    expect(['NIFTY', 'BANKNIFTY', 'SENSEX', 'FINNIFTY', 'MIDCPNIFTY', 'BANKEX'].every(inIndexCluster)).toBe(true);
    expect(clusterGate(base).verdict).toBe('PASS');
    expect(clusterGate({ ...base, openBullish: 1 }).verdict).toBe('BLOCK');
    expect(clusterGate({ ...base, openBearish: 1 }).verdict).toBe('PASS'); // the other direction is a separate bet
    expect(clusterGate({ ...base, enteredThisPass: ['NIFTY'] })).toMatchObject({ verdict: 'BLOCK', reason: expect.stringContaining('NIFTY already entered') });
    expect(clusterGate({ ...base, openBullish: null }).verdict).toBe('BLOCK'); // fails closed
    expect(clusterGate({ ...base, underlying: 'CRUDEOIL', openBullish: 3, enteredThisPass: ['NIFTY'] }).verdict).toBe('PASS');
  });
});

describe('entry gates — combined', () => {
  it('only an ENTER changes: indicators BLOCK → NO_TRADE, any WAIT → WAIT; both readings are always reasons', () => {
    expect(applyEntryGates('ENTER_CE', { indicators: ind(), extension: ext() }).action).toBe('ENTER_CE');
    expect(applyEntryGates('ENTER_CE', { indicators: ind({ tag: 'AGAINST' }), extension: ext({ fromSwingN15: 3 }) }).action).toBe('NO_TRADE');
    expect(applyEntryGates('ENTER_CE', { indicators: ind(), extension: ext({ fromSwingN15: 3 }) }).action).toBe('WAIT');
    expect(applyEntryGates('ENTER_CE', { indicators: ind({ rsi: 99 }), extension: ext() }).action).toBe('WAIT');
    const nt = applyEntryGates('NO_TRADE', { indicators: ind({ tag: 'AGAINST' }), extension: ext({ fromSwingN15: 3 }) });
    expect(nt.action).toBe('NO_TRADE');
    expect(nt.reasons.map((r) => r.split(' — ')[0])).toEqual([expect.stringMatching(/^indicators: ✗/), expect.stringMatching(/^chase: WAIT/)]);
    const none = applyEntryGates('ENTER_PE', { indicators: null, extension: null }, '15m bars unreadable: db down');
    expect(none.action).toBe('ENTER_PE');
    expect(none.reasons[0]).toContain('not read (15m bars unreadable: db down), not blocking');
  });
});
