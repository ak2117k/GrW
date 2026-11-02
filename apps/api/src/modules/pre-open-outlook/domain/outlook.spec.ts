import { readFileSync } from 'fs';
import { join } from 'path';
import type { NewsTheme } from '../../entry-engine/domain/news-theme';
import { chartMove, GLOBAL_STALE_MS, parseYahooChart, priceAt, type GlobalMove } from './global-chart';
import { headlineMedianPct, inSession, OUTLOOK, outlookAlertText, outlookOf, parseHeadlineMove, preOpenWindowMin, type OutlookInput } from './outlook';

/** Yahoo CL=F 1h bars, Fri 30 Oct 12:00Z → Mon 2 Nov 06:00Z (trimmed prod-server fetch of 2 Nov). */
const clf = () => parseYahooChart(JSON.parse(readFileSync(join(__dirname, '..', '__fixtures__', 'yahoo-clf-1h-2026-11-02.json'), 'utf8')), 'CL=F');
const MCX_CLOSE = Date.parse('2026-10-30T18:25:00Z'); // last in-session crude bar (23:55 IST settle print) + 1 min
const AT_0830 = new Date('2026-11-02T03:00:00Z');

const noTheme: NewsTheme = { side: null, material: false, stories: 0, against: 0, neutral: 0, sources: 0, net: 0, sideShare: 0, windowMin: 3420, items: [], summary: 'theme none' };
const input = (o: Partial<OutlookInput> = {}): OutlookInput => ({
  underlying: 'CRUDEOIL',
  sessionDate: '2026-11-02',
  at: AT_0830,
  lastClose: { price: 9917, at: new Date(MCX_CLOSE).toISOString() },
  move: null,
  theme: noTheme,
  headlineMoves: [],
  ...o,
});

describe('global chart (Yahoo v8)', () => {
  it('parses bars and the last trade; priceAt reads only bars that had ENDED (no look-ahead)', () => {
    const c = clf();
    expect(c.symbol).toBe('CL=F');
    expect(c.intervalMs).toBe(3_600_000);
    // 23:55 IST Fri: the 17:00Z bar ended 18:00Z → 104.30 (the 18:00Z bar ends 19:00Z, after).
    expect(priceAt({ ...c, price: null, priceAt: null }, MCX_CLOSE)).toEqual({ price: 104.3, at: Date.parse('2026-10-30T18:00:00Z') });
    // 08:30 IST Mon: the 02:00Z bar ended exactly 03:00Z.
    expect(priceAt({ ...c, price: null, priceAt: null }, AT_0830.getTime())?.price).toBe(100.95);
  });

  it('WTI −3.21 % between the MCX Friday close and 08:30 IST Monday', () => {
    const m = chartMove({ ...clf(), price: null, priceAt: null }, MCX_CLOSE, AT_0830.getTime(), 'test');
    expect(m).toMatchObject({ status: 'OK', movePct: -3.21, from: { price: 104.3 }, to: { price: 100.95 } });
  });

  it('fetch failure / empty → NO_DATA with a reason; an old price → STALE; a bad payload throws (caller records NO_DATA)', () => {
    expect(chartMove(null, 0, 1, 'Yahoo chart CL=F', 'HTTP 429')).toMatchObject({ status: 'NO_DATA', movePct: null, reason: 'HTTP 429' });
    const c = { symbol: 'CL=F', price: null, priceAt: null, intervalMs: 3_600_000, bars: [{ t: 0, close: 100 }, { t: 3_600_000, close: 99 }] };
    expect(chartMove(c, 3_600_000, 2 * 3_600_000 + GLOBAL_STALE_MS + 60_000, 's').status).toBe('STALE');
    expect(chartMove(c, 0, 2 * 3_600_000, 's').status).toBe('NO_DATA'); // nothing had ended by t = 0
    expect(() => parseYahooChart({ chart: { result: null, error: { description: 'No data found' } } }, 'XX=F')).toThrow('No data found');
  });
});

describe('pre-open outlook', () => {
  const wti = (movePct: number, status: GlobalMove['status'] = 'OK') => ({ status, symbol: 'CL=F', from: { price: 104.3, at: '' }, to: { price: 100.95, at: '' }, movePct, source: 't', beta: 1 });

  it('CRUDEOIL 2 Nov 08:30: WTI −3.21 % → BEARISH, gap ≈ −318 pts off 9917, confident enough for the engine', () => {
    const o = outlookOf(input({ move: wti(-3.21) }));
    expect(o.bias).toBe('BEARISH');
    expect(o.components.price).toBe(-1);
    expect(o.score).toBe(-0.75);
    expect(o.confidence).toBe(0.75);
    expect(o.gap).toEqual({ pct: -3.21, points: -318, basis: 'GLOBAL_PRICE' });
    expect(o.summary).toContain('gap ≈ -318 pts');
    expect(outlookAlertText([o])).toContain('CRUDEOIL: BEARISH conf 0.75');
  });

  it('a small move is NEUTRAL; beta scales the gap; price/theme disagreement and staleness cut confidence', () => {
    expect(outlookOf(input({ move: wti(-0.3) })).bias).toBe('NEUTRAL');
    expect(outlookOf(input({ move: { ...wti(-1), beta: 1.1 } })).gap?.pct).toBe(-1.1);
    const bullTheme: NewsTheme = { ...noTheme, side: 'BULLISH', material: true, net: 0.4 };
    const dis = outlookOf(input({ move: wti(-3.21), theme: bullTheme }));
    expect(dis.score).toBe(-0.5); // 0.75·(−1) + 0.25·(+1)
    expect(dis.confidence).toBe(0.3); // 0.5 × 0.6
    expect(outlookOf(input({ move: wti(-3.21, 'STALE') })).confidence).toBe(0.375);
  });

  it('without a global price: theme + headlines only, confidence capped below the engine threshold', () => {
    const bearTheme: NewsTheme = { ...noTheme, side: 'BEARISH', material: true, net: -0.5 };
    const moves = ['Oil prices fall over 1% as talks progress', 'Brent crude drops 2%', 'Oil slips more than 1%'].map((h, i) => parseHeadlineMove('CRUDEOIL', `c${i}`, h)!);
    const o = outlookOf(input({ move: { ...wti(0, 'NO_DATA'), movePct: null, reason: 'HTTP 503' }, theme: bearTheme, headlineMoves: moves }));
    expect(o.bias).toBe('BEARISH');
    expect(o.confidence).toBe(OUTLOOK.noPriceConfidenceCap);
    expect(o.gap).toMatchObject({ basis: 'HEADLINES', pct: -1 });
    expect(o.summary).toContain('no global price');
  });

  it('headline moves: crude price verbs, capped %, and nothing for non-crude underlyings', () => {
    expect(parseHeadlineMove('CRUDEOIL', 'a', 'Oil prices fall over 1% as Iran-Qatar talks raise hopes')).toMatchObject({ direction: 'BEAR', pct: 1 });
    expect(parseHeadlineMove('CRUDEOIL', 'a', 'Stock Market LIVE: GIFT Nifty rises over 100 pts; Brent crude drops 2%')).toMatchObject({ direction: 'BEAR', pct: 2 });
    expect(parseHeadlineMove('CRUDEOIL', 'a', 'Oil prices soar 14% in October to 6-month high')).toMatchObject({ direction: 'BULL', pct: OUTLOOK.headlineCapPct });
    expect(parseHeadlineMove('CRUDEOIL', 'a', 'Gold, silver rebound as crude oil prices soften')).toMatchObject({ direction: 'BEAR', pct: null });
    expect(parseHeadlineMove('CRUDEOIL', 'a', 'Goldman raises oil price forecast for December')).toBeNull();
    expect(parseHeadlineMove('NIFTY', 'a', 'Oil falls 2%')).toBeNull();
    expect(headlineMedianPct([])).toBeNull();
  });

  it('session filter and theme window', () => {
    expect(inSession(Date.parse('2026-10-30T18:24:00Z'), 9 * 60, 23 * 60 + 55)).toBe(true); // 23:54 IST
    expect(inSession(Date.parse('2026-10-31T01:27:00Z'), 9 * 60, 23 * 60 + 55)).toBe(false); // Sat 06:57 IST stray print
    expect(preOpenWindowMin(AT_0830, new Date(MCX_CLOSE), 1440, 4320)).toBe(3395);
    expect(preOpenWindowMin(AT_0830, new Date(AT_0830.getTime() - 3_600_000), 1440, 4320)).toBe(1440);
    expect(preOpenWindowMin(AT_0830, null, 1440, 4320)).toBe(1440);
  });
});
