/**
 * Owner case 2026-11-20 — GOLD27NOV26125000PE learning-paper trade, 19 Nov 2026, −₹15,632.
 * Owner: "the loss is a loss … the overall point is to have the right entry and exit point."
 *
 * What the chart (GOLD04DEC26FUT, 15m) says at each moment — the bar for any future entry/exit chart reader:
 *   09:15 entry  — gold had just flushed 1,504 pts in the 09:00 bar; price sat ~4 x N15 below the 15m Supertrend line.
 *                  A stretched entry at the bottom of the move (the live gate refused it as a chase). WRONG ENTRY.
 *   11:05 exit   — gold 885 pts against from the trade's best (≈3 x N15) and the 15m Supertrend flipped UP on the
 *                  11:00 bar. The chart was against the PE: the exit was RIGHT by the chart, not just by the AI's rule.
 *   17:45        — 15m Supertrend flipped back DOWN (bar 17:30 closed 128,675), in line with the 4-day daily downtrend
 *                  (135,853 → 127,548). This was the RIGHT ENTRY: PE ≈ 750 at 19:20, 1,078 at 21:58 (≈ +₹30k / GOLD lot).
 */
import { readChart, supertrend, type ChartBar } from '../chart-read';
import { GOLD_15M_2026_11_19 } from './fixtures/gold-2026-11-19-15m';

const MIN15 = 15 * 60_000;
const t = (ist: string) => Date.parse(ist.replace(' ', 'T') + ':00+05:30');
const BARS: ChartBar[] = GOLD_15M_2026_11_19.map(([s, open, high, low, close]) => ({ ts: t(s), open, high, low, close }));
/** Bars CLOSED by `ist`. */
const closedBy = (ist: string) => BARS.filter((b) => b.ts + MIN15 <= t(ist));
const n15 = (bars: ChartBar[], p = 14) => {
  const w = bars.slice(-p - 1);
  let s = 0;
  for (let i = 1; i < w.length; i++) s += Math.max(w[i].high - w[i].low, Math.abs(w[i].high - w[i - 1].close), Math.abs(w[i].low - w[i - 1].close));
  return s / (w.length - 1);
};

describe('GOLD 125000 PE, 19 Nov 2026 (owner case: right entry, right exit)', () => {
  it('the 09:00 bar is the 1,500-pt opening flush the trade bought into', () => {
    const open = BARS.find((b) => b.ts === t('2026-11-19 09:00'))!;
    expect(open.high - open.low).toBe(1504);
  });

  it('09:15 entry was stretched: price ≥ 3 x N15 below the 15m Supertrend line (do not chase)', () => {
    const bars = closedBy('2026-11-19 09:15');
    const st = supertrend(bars)!;
    expect(st.dir).toBe('DOWN');
    const stretch = (st.line - bars[bars.length - 1].close) / n15(bars);
    expect(stretch).toBeGreaterThanOrEqual(3);
  });

  it('11:05 exit agrees with the chart: gold ≥ 1.5 x N15 against from the best', () => {
    const bars15 = closedBy('2026-11-19 11:05');
    const r = readChart({
      bull: false, underlyingNow: 129_525, invalidation: 129_550, bestUnderlying: 128_640,
      bars5: [], bars15, n15: n15(bars15), k15: 1.5,
    });
    expect(r.against).toBe(true);
    expect(r.reasons.join(' ')).toMatch(/against from its best/);
  });

  it('15m Supertrend flips UP on the 11:00 bar (thesis broken) and back DOWN on the 17:30 bar (re-entry)', () => {
    const flips: string[] = [];
    let prev: string | null = null;
    for (let i = 12; i <= BARS.length; i++) {
      const dir = supertrend(BARS.slice(0, i))!.dir;
      const at = new Date(BARS[i - 1].ts + 5.5 * 3_600_000).toISOString().slice(0, 16).replace('T', ' ');
      if (prev && dir !== prev && at.startsWith('2026-11-19')) flips.push(`${dir} ${at.slice(11)}`);
      prev = dir;
    }
    expect(flips).toEqual(['UP 11:00', 'DOWN 17:30']);
  });

  it('21:30: with a PE bought on the 17:45 flip, the chart is still intact', () => {
    const bars15 = closedBy('2026-11-19 21:30');
    const r = readChart({
      bull: false, underlyingNow: 127_517, invalidation: 129_550, bestUnderlying: 127_414,
      bars5: [], bars15, n15: n15(bars15), k15: 1.5,
    });
    expect(r.against).toBe(false);
  });

  it.todo('entry chart reader (Phase C): SKIP / wait at 09:15 (stretched after the flush), TAKE at the 17:45 Supertrend flip');
});
