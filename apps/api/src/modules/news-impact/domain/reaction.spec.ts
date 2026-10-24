import { atrOf, isComplete, judgeReaction, judgeSessionOf, mergePoints, pointsFrom, type Bar } from './reaction';

const OPEN = Date.parse('2026-10-23T03:45:00Z'); // 09:15 IST
const CLOSE = Date.parse('2026-10-23T10:00:00Z'); // 15:30 IST
const NOPEN = Date.parse('2026-10-26T03:45:00Z');
const NCLOSE = Date.parse('2026-10-26T10:00:00Z');
const bars: Bar[] = [];
for (let t = OPEN; t < CLOSE; t += 60_000) bars.push({ t, open: 100 + (t - OPEN) / 3_600_000, close: 100 + (t - OPEN + 60_000) / 3_600_000 });
for (let t = NOPEN; t < NCLOSE; t += 60_000) bars.push({ t, open: 110, close: 110 });

describe('reaction points', () => {
  const session = { openAt: OPEN, closeAt: CLOSE };
  const next = { openAt: NOPEN, closeAt: NCLOSE };

  it('intraday anchor: p0 / +15 / +60 / close / next close from 1m bars', () => {
    const anchor = OPEN + 60 * 60_000; // 10:15 IST
    const p = pointsFrom(bars, anchor, false, session, next, NCLOSE + 60_000);
    expect(p.p0).toBeCloseTo(101 + 1 / 60);
    expect(p.p15).toBeCloseTo(101.25 + 1 / 60);
    expect(p.p60).toBeCloseTo(102 + 1 / 60);
    expect(p.pClose).toBeCloseTo(106.25);
    expect(p.pNextClose).toBe(110);
    expect(isComplete(p)).toBe(true);
  });

  it('points in the future stay null; an open anchor takes the first bar open', () => {
    const p = pointsFrom(bars, OPEN, true, session, next, OPEN + 20 * 60_000);
    expect(p.p0).toBe(100);
    expect(p.p15).not.toBeNull();
    expect(p.p60).toBeNull();
    expect(p.pClose).toBeNull();
    expect(p.pNextClose).toBeNull();
  });

  it('no bars → null, never zero; merge never overwrites a stored point', () => {
    const p = pointsFrom([], OPEN, true, session, next, NCLOSE + 1);
    expect(p).toEqual({ p0: null, p15: null, p60: null, pClose: null, pNextClose: null });
    expect(mergePoints({ ...p, p0: 5 }, { ...p, p0: 7, p15: 8 })).toMatchObject({ p0: 5, p15: 8 });
  });

  it('ATR over daily bars; null with < 5 days', () => {
    expect(atrOf([{ high: 1, low: 0, close: 1 }])).toBeNull();
    const days = Array.from({ length: 10 }, () => ({ high: 102, low: 98, close: 100 }));
    expect(atrOf(days)).toBe(4);
  });
});

describe('reaction verdict', () => {
  const base = { symbol: 'RELIANCE', atr: 40, p0: 1000, p15: 1005, p60: 1010, pClose: 1000, pNextClose: 1020 };

  it('INTRADAY: +60 m beyond 0.15×ATR in the called direction is right, against is wrong, inside is null', () => {
    expect(judgeReaction({ ...base, direction: 'BULL', horizon: 'INTRADAY' })).toMatchObject({ correct: true, status: 'RIGHT', band: 6 });
    expect(judgeReaction({ ...base, direction: 'BEAR', horizon: 'INTRADAY' })).toMatchObject({ correct: false, status: 'WRONG' });
    expect(judgeReaction({ ...base, p60: 1003, direction: 'BULL', horizon: 'INTRADAY' })).toMatchObject({ correct: null, status: 'INSIDE_BAND' });
  });

  it('DAYS: close-to-next-close vs 0.3×ATR', () => {
    expect(judgeReaction({ ...base, direction: 'BULL', horizon: 'DAYS' })).toMatchObject({ correct: true, band: 12, movePct: 2 });
    expect(judgeReaction({ ...base, pNextClose: 1010, direction: 'BULL', horizon: 'DAYS' }).correct).toBeNull();
  });

  it('WEEKS / NEUTRAL / missing bars are not judged; no ATR falls back to a % of price', () => {
    expect(judgeReaction({ ...base, direction: 'BULL', horizon: 'WEEKS' }).status).toBe('NOT_JUDGED_WEEKS');
    expect(judgeReaction({ ...base, direction: 'NEUTRAL', horizon: 'DAYS' }).correct).toBeNull();
    expect(judgeReaction({ ...base, pNextClose: null, direction: 'BULL', horizon: 'DAYS' }).status).toBe('NO_DATA');
    expect(judgeReaction({ ...base, atr: null, direction: 'BULL', horizon: 'DAYS' }).band).toBe(6); // 2 % × 1000 × 0.3
  });

  it('judge session: the anchor session for INTRADAY, the next one otherwise', () => {
    expect(judgeSessionOf('INTRADAY', '2026-10-23', '2026-10-26')).toBe('2026-10-23');
    expect(judgeSessionOf('DAYS', '2026-10-23', '2026-10-26')).toBe('2026-10-26');
  });
});
