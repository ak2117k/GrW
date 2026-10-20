import type { ChainSnapshotRow, ChainStrikeRow } from '../../mbm/domain/chain-snapshot';
import type { CueRecord, FiiDerivatives, FiiDiiCash } from '../../market-cues/market-cues.types';
import {
  scoreExpiry,
  scoreFiiDii,
  scoreIndicators,
  scoreMood,
  scoreNews,
  scoreOi,
  scoreVix,
  timeframeVote,
} from './factors';
import { betaTo } from './indicators';
import { assemble, bandOf, clampPoints, compactScorecard } from './scoring';

const leg = (oi: number, oi_chg: number | null) => ({ ltp: 1, oi, oi_chg, vol: 0, iv: null, delta: null, gamma: null, theta: null, vega: null });
const strikes = (spot: number, ce: (k: number) => [number, number | null], pe: (k: number) => [number, number | null]): ChainStrikeRow[] =>
  [-5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5].map((i) => {
    const k = spot + i * 20;
    return { strike: k, ce: leg(...ce(k)), pe: leg(...pe(k)) };
  });
const chain = (over: Partial<ChainSnapshotRow>): ChainSnapshotRow => ({
  instrument: 'RELIANCE', expiry: '2026-10-28', capturedAt: new Date('2026-10-19T10:00:00Z'), spot: 1260, pcr: 1.0,
  maxPain: 1260, callWall: 1300, putWall: 1200, strikes: strikes(1260, () => [1000, 0], () => [1000, 0]), ...over,
});

describe('bands and points', () => {
  it.each([
    [-7, 'STRONG_AGAINST'], [-4, 'STRONG_AGAINST'], [-3, 'AGAINST'], [-1, 'AGAINST'], [0, 'NEUTRAL'],
    [1, 'SUPPORTS'], [3, 'SUPPORTS'], [4, 'STRONG_SUPPORTS'], [9, 'STRONG_SUPPORTS'],
  ])('total %i ⇒ %s', (t, b) => expect(bandOf(t)).toBe(b));

  it('clamps to −2…+2 and maps NaN to 0', () => {
    expect([clampPoints(5), clampPoints(-3), clampPoints(1.4), clampPoints(NaN), clampPoints(-0.2)]).toEqual([2, -2, 1, 0, 0]);
  });

  it('assemble orders all seven factors, counts only available ones, and compacts to ≤400 chars', () => {
    const sc = assemble({
      userId: 'u', symbol: 'X', exchange: 'NFO', underlying: 'X', side: 'BULLISH', window: 'OVERNIGHT', computedAt: new Date(0),
      factors: [{ name: 'news', points: 2, value: 'v'.repeat(500), reason: 'r', available: true }, { name: 'oi', points: 2, value: 'p', reason: 'r', available: true }],
    });
    expect(sc.factors.map((f) => f.name)).toEqual(['oi', 'fii_dii', 'vix', 'expiry', 'news', 'indicators', 'mood']);
    expect(sc.factors.filter((f) => !f.available)).toHaveLength(5);
    expect(sc.total).toBe(4);
    expect(sc.band).toBe('STRONG_SUPPORTS');
    expect(compactScorecard(sc).length).toBeLessThanOrEqual(400);
  });
});

describe('OI factor', () => {
  it('missing chain ⇒ unavailable, 0 points', () => {
    const f = scoreOi({ latest: null, history: [] }, 'BULLISH');
    expect(f).toMatchObject({ available: false, points: 0 });
    expect(f.reason).toMatch(/unavailable/);
  });

  it('PCR far above its 5-session median + put writing near spot = +2 for a bull, −2 for a bear (RELIANCE case)', () => {
    const latest = chain({ pcr: 2.1, strikes: strikes(1260, () => [1000, 10], () => [3000, 900]) });
    const history = [1.2, 1.3, 1.3, 1.4, 1.2].map((pcr) => chain({ pcr }));
    const bull = scoreOi({ latest, history }, 'BULLISH');
    expect(bull.points).toBe(2);
    expect(bull.value).toMatch(/PCR 2\.10 \(5d med 1\.30\)/);
    expect(bull.value).toMatch(/put build/);
    expect(scoreOi({ latest, history }, 'BEARISH').points).toBe(-2);
  });

  it('no history: absolute PCR bands; call writing and spot under the put wall are bearish', () => {
    const latest = chain({ pcr: 0.6, spot: 1190, strikes: strikes(1190, () => [3000, 900], () => [1000, 0]) });
    expect(scoreOi({ latest, history: [] }, 'BULLISH').points).toBe(-2);
  });

  it('neutral chain ⇒ 0 but available', () => {
    expect(scoreOi({ latest: chain({}), history: [] }, 'BULLISH')).toMatchObject({ points: 0, available: true });
  });
});

const rec = <T>(values: T | null, status: 'ok' | 'stale' | 'unavailable' = 'ok'): CueRecord<T> => ({
  values, sourceTime: '2026-10-19', fetchedAt: null, basis: 'session', source: 'nse', status,
});
const cash = (fii: number, dii: number | null): FiiDiiCash => ({
  date: '2026-10-19', fii: { buy: 0, sell: 0, net: fii }, dii: dii == null ? null : { buy: 0, sell: 0, net: dii }, unit: '₹ crore',
});
const fo = (long: number, short: number, dLong: number, dShort: number): FiiDerivatives => ({
  date: '2026-10-19', unit: 'contracts', indexFutures: { long, short }, indexCalls: { long: 0, short: 0 }, indexPuts: { long: 0, short: 0 },
  change: { previousDate: '2026-10-16', indexFutures: { long: dLong, short: dShort }, indexCalls: { long: 0, short: 0 }, indexPuts: { long: 0, short: 0 } },
});

describe('FII/DII factor', () => {
  it('no readings ⇒ unavailable', () => {
    expect(scoreFiiDii({ fiiDii: null, fiiOi: null }, 'BULLISH')).toMatchObject({ available: false, points: 0 });
    expect(scoreFiiDii({ fiiDii: rec<FiiDiiCash>(null, 'unavailable'), fiiOi: null }, 'BULLISH').available).toBe(false);
  });
  it('FII buying + adding index longs = +2 bull / −2 bear', () => {
    const input = { fiiDii: rec(cash(2500, -300)), fiiOi: rec(fo(60000, 40000, 8000, -2000)) };
    expect(scoreFiiDii(input, 'BULLISH').points).toBe(2);
    expect(scoreFiiDii(input, 'BEARISH').points).toBe(-2);
  });
  it('FII selling absorbed by DII is not a bearish vote', () => {
    expect(scoreFiiDii({ fiiDii: rec(cash(-2000, 2500)), fiiOi: null }, 'BULLISH').points).toBe(0);
    expect(scoreFiiDii({ fiiDii: rec(cash(-2000, 500)), fiiOi: null }, 'BULLISH').points).toBe(-1);
  });
});

describe('VIX factor', () => {
  const flat = Array(20).fill(14);
  it('fewer than 5 closes ⇒ unavailable', () => {
    expect(scoreVix({ closes: [14, 15], isLongOption: true, isIndex: true }, 'BULLISH')).toMatchObject({ available: false, points: 0 });
    expect(scoreVix({ closes: null, isLongOption: true, isIndex: true }, 'BULLISH').available).toBe(false);
  });
  it('long stock option: rich VIX −1 (crush if it mean-reverts), rising +1 (vega tailwind), same both sides', () => {
    const richRising = [...flat, 16.5]; // elevated AND +18% d/d ⇒ −1 + 1 = 0
    for (const side of ['BULLISH', 'BEARISH'] as const) {
      const f = scoreVix({ closes: richRising, isLongOption: true, isIndex: false }, side);
      expect(f.points).toBe(0);
      expect(f.reason).toContain('rich VIX: crush risk if it mean-reverts');
      expect(f.reason).toContain('rising VIX: vega tailwind for a long option');
    }
    const risingOnly = [...flat, 14.8]; // +5.7%, not elevated
    expect(scoreVix({ closes: risingOnly, isLongOption: true, isIndex: false }, 'BEARISH').points).toBe(1);
    const richFlat = [...flat, 16.5, 16.5]; // elevated, unchanged d/d
    expect(scoreVix({ closes: richFlat, isLongOption: true, isIndex: false }, 'BULLISH').points).toBe(-1);
  });
  it('rich VIX that is falling ⇒ −2 for a long option ("VIX deflating")', () => {
    const closes = [...flat, 18, 16.5]; // −8% d/d, still ≥ 10% over the 20d mean
    const f = scoreVix({ closes, isLongOption: true, isIndex: false }, 'BULLISH');
    expect(f.points).toBe(-2);
    expect(f.reason).toContain('VIX deflating');
  });
  it('clamps to −2…+2 when the index direction stacks on the long-option read', () => {
    // index long put, rich + falling VIX: −1 −1 (option) −1 (falling VIX bullish ⇒ against a put) = −3 ⇒ −2
    expect(scoreVix({ closes: [...flat, 18, 16.5], isLongOption: true, isIndex: true }, 'BEARISH').points).toBe(-2);
    // index long put, rising (not rich) VIX: +1 vega + 1 bearish direction = +2
    expect(scoreVix({ closes: [...flat, 14.8], isLongOption: true, isIndex: true }, 'BEARISH').points).toBe(2);
  });
  it('rising VIX is directional for the index: helps an index put, hurts an index call', () => {
    const closes = [...flat, 14.8]; // +5.7%, not elevated (< +10% over avg)
    expect(scoreVix({ closes, isLongOption: false, isIndex: true }, 'BEARISH').points).toBe(1);
    expect(scoreVix({ closes, isLongOption: false, isIndex: true }, 'BULLISH').points).toBe(-1);
  });
  it('calm VIX on a cash stock ⇒ 0, available', () => {
    expect(scoreVix({ closes: [...flat, 14], isLongOption: false, isIndex: false }, 'BULLISH')).toMatchObject({ points: 0, available: true });
  });
});

describe('expiry factor', () => {
  const base = { isOption: true, isLongOption: true, expiry: '2026-10-28' };
  it('never positive; scales with sessions left and a holiday gap', () => {
    expect(scoreExpiry({ ...base, dte: { calendarDays: 2, tradingSessionsLeft: 2 }, gapDays: 0.7 }).points).toBe(-2);
    expect(scoreExpiry({ ...base, dte: { calendarDays: 6, tradingSessionsLeft: 5 }, gapDays: 0.7 }).points).toBe(-1);
    expect(scoreExpiry({ ...base, dte: { calendarDays: 20, tradingSessionsLeft: 14 }, gapDays: 0.7 }).points).toBe(0);
    expect(scoreExpiry({ ...base, dte: { calendarDays: 9, tradingSessionsLeft: 6 }, gapDays: 2.7 }).points).toBe(-1);
    expect(scoreExpiry({ ...base, dte: { calendarDays: 6, tradingSessionsLeft: 4 }, gapDays: 2.7 }).points).toBe(-2);
  });
  it('unknown expiry ⇒ unavailable; short options, futures and cash ⇒ 0', () => {
    expect(scoreExpiry({ ...base, dte: null, gapDays: 1 })).toMatchObject({ available: false, points: 0 });
    expect(scoreExpiry({ ...base, isLongOption: false, dte: { calendarDays: 1, tradingSessionsLeft: 1 }, gapDays: 1 }).points).toBe(0);
    expect(scoreExpiry({ isOption: false, isLongOption: false, expiry: null, dte: null, gapDays: 1 })).toMatchObject({ points: 0, available: true });
  });
});

describe('news factor', () => {
  const a = (score: number, source = 'ET') => ({ id: 'n', title: 'Big news', source, sentiment: null, sentimentScore: score, publishedAt: new Date() });
  it('read failure ⇒ unavailable; no news ⇒ 0 available', () => {
    expect(scoreNews(null, 'BULLISH')).toMatchObject({ available: false, points: 0 });
    expect(scoreNews([], 'BULLISH')).toMatchObject({ available: true, points: 0 });
  });
  it('strongest headline decides; NSE announcements weigh 1.5×', () => {
    expect(scoreNews([a(0.2), a(-0.7)], 'BULLISH').points).toBe(-2);
    expect(scoreNews([a(0.2), a(-0.7)], 'BEARISH').points).toBe(2);
    expect(scoreNews([a(0.45)], 'BULLISH').points).toBe(1);
    expect(scoreNews([a(0.45, 'NSE Announcements')], 'BULLISH').points).toBe(2);
    expect(scoreNews([a(0.1)], 'BULLISH').points).toBe(0);
  });
});

describe('indicators factor', () => {
  const up = Array.from({ length: 60 }, (_, i) => 100 + i + (i % 3 === 0 ? -0.6 : 0));
  const down = up.map((x) => 300 - x);
  it('fewer than 35 daily bars ⇒ unavailable', () => {
    expect(scoreIndicators({ dailyCloses: up.slice(0, 20), m15Closes: null, setups: [] }, 'BULLISH')).toMatchObject({ available: false, points: 0 });
    expect(scoreIndicators({ dailyCloses: null, m15Closes: null, setups: [] }, 'BULLISH').available).toBe(false);
  });
  it('an uptrend supports a bull and opposes a bear; a downtrend the reverse', () => {
    expect(timeframeVote(up)!.vote).toBeGreaterThanOrEqual(1);
    expect(scoreIndicators({ dailyCloses: up, m15Closes: up, setups: [] }, 'BULLISH').points).toBeGreaterThan(0);
    expect(scoreIndicators({ dailyCloses: up, m15Closes: up, setups: [] }, 'BEARISH').points).toBeLessThan(0);
    expect(scoreIndicators({ dailyCloses: down, m15Closes: null, setups: [] }, 'BULLISH').points).toBeLessThan(0);
  });
  it('daily setups vote for INDEX positions only: long setup +1 oriented to the side', () => {
    const flat = Array.from({ length: 60 }, () => 100);
    const long = [{ setup: 'BB_BREAKOUT_UP', action: 'LONG_SETUP' }];
    expect(scoreIndicators({ dailyCloses: flat, m15Closes: null, setups: [] }, 'BULLISH').points).toBe(0);
    expect(scoreIndicators({ dailyCloses: flat, m15Closes: null, setups: long, isIndex: true, isLongCe: true }, 'BULLISH')).toMatchObject({
      points: 1, value: expect.stringContaining('setup BB_BREAKOUT_UP'), reason: expect.stringContaining('daily setup +1'),
    });
    expect(scoreIndicators({ dailyCloses: flat, m15Closes: null, setups: long, isIndex: true }, 'BEARISH').points).toBe(-1);
    expect(scoreIndicators({ dailyCloses: flat, m15Closes: null, setups: long, isIndex: false }, 'BULLISH').points).toBe(0);
  });
  it('a tighten-longs warning is −1 for a long CE only (never supports a PE)', () => {
    const flat = Array.from({ length: 60 }, () => 100);
    const warn = [{ setup: 'EMA_DOWNCROSS', action: 'EXIT_OR_TIGHTEN_LONGS' }];
    expect(scoreIndicators({ dailyCloses: flat, m15Closes: null, setups: warn, isIndex: true, isLongCe: true }, 'BULLISH').points).toBe(-1);
    expect(scoreIndicators({ dailyCloses: flat, m15Closes: null, setups: warn, isIndex: true, isLongCe: false }, 'BEARISH').points).toBe(0);
    expect(scoreIndicators({ dailyCloses: flat, m15Closes: null, setups: warn, isIndex: true, isLongCe: false }, 'BULLISH').points).toBe(0);
  });
  it('technicals + setup clamp to −2…+2', () => {
    expect(scoreIndicators({ dailyCloses: up, m15Closes: up, setups: [{ setup: 'S', action: 'LONG_SETUP' }], isIndex: true, isLongCe: true }, 'BULLISH').points).toBe(2);
  });
});

describe('expected-move factor (key mood)', () => {
  const b = (regime: string, p = 0.71) => ({ status: 'ok' as const, horizons: { '30m': { p: 0.2, regime: 'QUIET' }, '60m': { p, regime } } });
  it('absent / stale MBM ⇒ unavailable for an index position; 0 with a note for a stock', () => {
    expect(scoreMood({ behaviour: { status: 'absent' }, isIndex: true, isLongOption: true })).toMatchObject({ available: false, points: 0 });
    expect(scoreMood({ behaviour: null, isIndex: true, isLongOption: true }).available).toBe(false);
    expect(scoreMood({ behaviour: { status: 'absent' }, isIndex: false, isLongOption: true })).toMatchObject({
      points: 0, available: true, value: 'NIFTY expected move n/a (no live or stored prediction)',
    });
  });
  it('index long option: big move +1, quiet −1, normal 0 — longest horizon, size never direction', () => {
    expect(scoreMood({ behaviour: b('ACTIVE'), isIndex: true, isLongOption: true })).toMatchObject({
      points: 1, value: 'NIFTY 60m: p(big) 0.71 → big move', reason: 'big move expected: can outrun theta',
    });
    expect(scoreMood({ behaviour: b('QUIET', 0.1), isIndex: true, isLongOption: true })).toMatchObject({
      points: -1, reason: 'quiet session expected: theta dominates',
    });
    expect(scoreMood({ behaviour: b('NORMAL', 0.4), isIndex: true, isLongOption: true }).points).toBe(0);
  });
  it('futures / cash / short options: context only, 0', () => {
    expect(scoreMood({ behaviour: b('ACTIVE'), isIndex: true, isLongOption: false })).toMatchObject({ points: 0, available: true });
    expect(scoreMood({ behaviour: b('QUIET'), isIndex: false, isLongOption: false, beta: 1.2 }).points).toBe(0);
  });
  it('stock long option rides NIFTY through its beta: ≥ 0.5 votes, < 0.5 or unknown does not', () => {
    expect(scoreMood({ behaviour: b('ACTIVE'), isIndex: false, isLongOption: true, beta: 1.1 })).toMatchObject({
      points: 1, value: 'NIFTY 60m: p(big) 0.71 → big move (beta 1.10)',
    });
    expect(scoreMood({ behaviour: b('QUIET'), isIndex: false, isLongOption: true, beta: 0.9 }).points).toBe(-1);
    const low = scoreMood({ behaviour: b('ACTIVE'), isIndex: false, isLongOption: true, beta: 0.3 });
    expect(low).toMatchObject({ points: 0, value: 'NIFTY 60m: p(big) 0.71 → big move (beta 0.30)' });
    expect(low.reason).toContain('beta 0.30 < 0.5');
    expect(scoreMood({ behaviour: b('ACTIVE'), isIndex: false, isLongOption: true, beta: null })).toMatchObject({
      points: 0, value: 'NIFTY 60m: p(big) 0.71 → big move (beta n/a)', reason: 'beta to NIFTY unavailable: no vote',
    });
  });
  it('stored (after-hours) predictions carry their IST as-of in the label and score normally', () => {
    const stored = { ...b('ACTIVE'), storedAsOf: new Date('2026-10-19T09:59:00Z') };
    expect(scoreMood({ behaviour: stored, isIndex: false, isLongOption: true, beta: 1.1 })).toMatchObject({
      points: 1, value: 'NIFTY 60m: p(big) 0.71 → big move (beta 1.10, as of 2026-10-19 15:29 IST)',
    });
    expect(scoreMood({ behaviour: stored, isIndex: true, isLongOption: true })).toMatchObject({
      points: 1, value: 'NIFTY 60m: p(big) 0.71 → big move (as of 2026-10-19 15:29 IST)',
    });
  });
});

describe('betaTo', () => {
  const days = (n: number) => Array.from({ length: n }, (_, i) => `2026-07-${String(i + 1).padStart(2, '0')}`);
  const walk = (n: number, f: (i: number) => number) => {
    let x = 100;
    return days(n).map((day, i) => ({ day, close: (x *= Math.exp(f(i))) }));
  };
  const idx = walk(31, (i) => 0.01 * Math.sin(i * 1.7));
  it('recovers a known beta from day-aligned closes', () => {
    const stock = walk(31, (i) => 2 * 0.01 * Math.sin(i * 1.7));
    expect(betaTo(stock, idx)).toBeCloseTo(2, 6);
  });
  it('too little overlap, or a flat index ⇒ null', () => {
    expect(betaTo(idx.slice(0, 10), idx)).toBeNull();
    expect(betaTo(idx, idx.map((b) => ({ ...b, close: 100 })))).toBeNull();
  });
});
