import { ENTRY_ENGINE, entryDecision, entryGuards, newsReading, oiLean, trendReading, volumeUsable, type Bar1m, type EntryInput, type ImpactRow, type NewsReading, type OiReading, type TrendReading } from './entry-decision';
import { chooseBars, wantFor } from './engine-inputs';

const AT = new Date('2026-10-29T04:35:00Z'); // 10:05 IST
const MIN = 60_000;

const impact = (o: Partial<ImpactRow> = {}): ImpactRow => ({
  clusterId: 'c1',
  analysedAt: new Date(AT.getTime() - 5 * MIN),
  firstSeen: new Date(AT.getTime() - 130 * MIN),
  direction: 'BEAR',
  magnitude: 'MED',
  confidence: 0.5,
  pricedIn: false,
  symbols: ['CRUDEOIL'],
  sectors: ['MCX ENERGY'],
  indexName: null,
  material: false,
  materialType: 'NEWS',
  headline: 'Crude oil dips to $113',
  ...o,
});

const news = (lean: NewsReading['lean'], material = true, score = lean === 'BEARISH' ? -0.3 : lean === 'BULLISH' ? 0.3 : 0): NewsReading => ({ lean, score, material, items: [], freshestAgeMin: 10, summary: `news ${lean}` });
const trend = (lean: TrendReading['lean']): TrendReading => ({
  lean, price: 9654, vwap: 9664, vwapSource: 'VWAP', vwapPct: lean === 'BULLISH' ? 0.002 : -0.002, ema15: 9660, ema15Slope: lean === 'BULLISH' ? 0.001 : -0.001, ema1h: 9670, ema1hSlope: -0.001, sessionBars: 60, summary: `trend ${lean}`,
});
const oi = (want: 'BULLISH' | 'BEARISH', verdict: OiReading['verdict'], futuresVerdict: OiReading['futuresVerdict'] = 'NO_DATA'): OiReading => ({ want, verdict, source: verdict === 'NO_DATA' ? 'NONE' : 'CHAIN', futuresVerdict, summary: `oi ${verdict}`, chainLeanAgo: -0.016, chainLeanOpen: -0.11 });
const input = (o: Partial<EntryInput>): EntryInput => ({ underlying: 'CRUDEOIL', at: AT, news: news('BEARISH'), trend: trend('BEARISH'), oi: oi('BEARISH', 'AGREES'), ...o });

describe('newsReading', () => {
  it('a fresh BEAR MED impact on the underlying leans bearish and is material', () => {
    const r = newsReading([impact()], 'CRUDEOIL', AT);
    expect(r).toMatchObject({ lean: 'BEARISH', score: -0.3, material: true });
    expect(r.items[0]).toMatchObject({ readAgoMin: 5, ageMin: 130 });
  });

  it('ignores impacts the model read after `at` (no look-ahead), older than the lookback, below min confidence, or on other names', () => {
    const r = newsReading(
      [
        impact({ clusterId: 'future', analysedAt: new Date(AT.getTime() + MIN) }),
        impact({ clusterId: 'old', magnitude: 'LOW', analysedAt: new Date(AT.getTime() - (ENTRY_ENGINE.newsLookbackMin + 1) * MIN) }),
        impact({ clusterId: 'weak', confidence: 0.3 }),
        impact({ clusterId: 'other', symbols: ['RELIANCE'], sectors: ['NIFTY ENERGY'] }),
      ],
      'CRUDEOIL',
      AT,
    );
    expect(r.lean).toBe('NO_DATA');
  });

  it('several LOW impacts can lean but are not material; priced-in counts half', () => {
    const low = newsReading([impact({ clusterId: 'a', magnitude: 'LOW', confidence: 1 }), impact({ clusterId: 'b', magnitude: 'LOW', confidence: 1 })], 'CRUDEOIL', AT);
    expect(low).toMatchObject({ lean: 'BEARISH', score: -0.5, material: false });
    const priced = newsReading([impact({ pricedIn: true })], 'CRUDEOIL', AT);
    expect(priced).toMatchObject({ lean: 'NEUTRAL', score: -0.15 });
  });

  it('broad-market (index NIFTY) news counts for NIFTY and SENSEX, NIFTY BANK sector for BANKNIFTY', () => {
    const idx = impact({ symbols: [], sectors: ['NIFTY BANK'], indexName: 'NIFTY', direction: 'BULL' });
    expect(newsReading([idx], 'NIFTY', AT).lean).toBe('BULLISH');
    expect(newsReading([idx], 'SENSEX', AT).lean).toBe('BULLISH');
    expect(newsReading([idx], 'BANKNIFTY', AT).lean).toBe('BULLISH');
    expect(newsReading([idx], 'CRUDEOIL', AT).lean).toBe('NO_DATA');
  });
});

describe('trendReading', () => {
  const sessionStart = new Date('2026-10-29T03:30:00Z');
  /** Bars every minute from `from` for `n` minutes, close = f(i). */
  const bars = (from: number, n: number, f: (i: number) => number, vol = (i: number) => 100 + ((i * 37) % 11)): Bar1m[] =>
    Array.from({ length: n }, (_, i) => ({ ts: from + i * MIN, open: f(i), high: f(i) + 1, low: f(i) - 1, close: f(i), volume: vol(i) }));

  it('a steady fall over two sessions reads BEARISH (below VWAP, 15m and 1h EMA down)', () => {
    const prev = bars(sessionStart.getTime() - 24 * 60 * MIN, 840, (i) => 10_000 - i * 0.2);
    const today = bars(sessionStart.getTime(), 65, (i) => 9_800 - i * 1);
    const r = trendReading([...prev, ...today], AT, sessionStart);
    expect(r.lean).toBe('BEARISH');
    expect(r.vwapSource).toBe('VWAP');
    expect(r.vwapPct!).toBeLessThan(0);
    expect(r.ema15Slope!).toBeLessThan(0);
    expect(r.ema1hSlope!).toBeLessThanOrEqual(0);
  });

  it('too few session bars, or not enough history for the 1h EMA, is NO_DATA', () => {
    expect(trendReading(bars(sessionStart.getTime(), 10, () => 100), AT, sessionStart).lean).toBe('NO_DATA');
    expect(trendReading(bars(sessionStart.getTime(), 65, (i) => 100 - i), AT, sessionStart).lean).toBe('NO_DATA');
  });

  it('a frozen line (newest bar closed > trendMaxStaleMin ago) is NO_DATA, not the stale trend', () => {
    const prev = bars(sessionStart.getTime() - 24 * 60 * MIN, 840, (i) => 10_000 - i * 0.2);
    const fresh = bars(sessionStart.getTime(), 65, (i) => 9_800 - i * 1); // last bar 10:04 → closed 10:05 = AT
    expect(trendReading([...prev, ...fresh], AT, sessionStart).lean).toBe('BEARISH');
    const stopped = fresh.slice(0, 65 - (ENTRY_ENGINE.trendMaxStaleMin + 2)); // feed stopped 5 min before AT
    const r = trendReading([...prev, ...stopped], AT, sessionStart);
    expect(r.lean).toBe('NO_DATA');
    expect(r.price).toBeNull();
    expect(r.summary).toMatch(/stale/);
    const justIn = fresh.slice(0, 65 - ENTRY_ENGINE.trendMaxStaleMin); // exactly the limit: still read
    expect(trendReading([...prev, ...justIn], AT, sessionStart).lean).toBe('BEARISH');
  });

  it('index volume (0) and a running-total volume fall back to TWAP', () => {
    expect(volumeUsable(bars(0, 20, () => 1, () => 0))).toBe(false);
    expect(volumeUsable(bars(0, 20, () => 1, (i) => 1000 + i * 10))).toBe(false);
    expect(volumeUsable(bars(0, 20, () => 1))).toBe(true);
    // Per-bar values that keep growing ~150× through the session (prod crude `candles`) are a running total.
    expect(volumeUsable(bars(0, 400, () => 1, (i) => 30_000 + i * 12_000 + ((i * 37) % 11) * (i % 2 ? 9_000 : -9_000)))).toBe(false);
  });

  it('chooseBars prefers candles_1m, else the candles table when the hub lacks the session', () => {
    const t = bars(sessionStart.getTime(), 30, () => 1);
    expect(chooseBars([], t, sessionStart, AT).source).toBe('candles');
    expect(chooseBars(t, [], sessionStart, AT).source).toBe('candles_1m');
  });
});

describe('entryDecision', () => {
  it('news, trend and OI all bearish → ENTER_PE; all bullish → ENTER_CE', () => {
    const pe = entryDecision(input({}));
    expect(pe.action).toBe('ENTER_PE');
    expect(pe.direction).toBe('BEARISH');
    expect(pe.reasons).toHaveLength(3);
    const ce = entryDecision(input({ news: news('BULLISH'), trend: trend('BULLISH'), oi: oi('BULLISH', 'AGREES', 'AGREES') }));
    expect(ce.action).toBe('ENTER_CE');
  });

  it('any disagreement is NO_TRADE', () => {
    expect(entryDecision(input({ trend: trend('BULLISH') })).action).toBe('NO_TRADE');
    expect(entryDecision(input({ trend: trend('NEUTRAL') })).action).toBe('NO_TRADE');
    expect(entryDecision(input({ oi: oi('BEARISH', 'AGAINST') })).action).toBe('NO_TRADE');
    expect(entryDecision(input({ oi: oi('BEARISH', 'MIXED') })).action).toBe('NO_TRADE');
    expect(entryDecision(input({ news: news('BULLISH') })).action).toBe('NO_TRADE');
    expect(entryDecision(input({ news: news('NEUTRAL') })).action).toBe('NO_TRADE');
    // An OI read for the other direction never confirms.
    expect(entryDecision(input({ oi: oi('BULLISH', 'AGAINST') })).action).toBe('NO_TRADE');
    // Chain agrees but the futures buildup is against.
    expect(entryDecision(input({ oi: oi('BEARISH', 'AGREES', 'AGAINST') })).action).toBe('NO_TRADE');
  });

  it('news that leans but is not material is NO_TRADE', () => {
    const d = entryDecision(input({ news: news('BEARISH', false) }));
    expect(d.action).toBe('NO_TRADE');
    expect(d.reasons[0]).toMatch(/not material/);
  });

  it('OI NO_DATA (or no OI read at all) is NO_TRADE, whatever news and trend say', () => {
    const d = entryDecision(input({ oi: oi('BEARISH', 'NO_DATA') }));
    expect(d.action).toBe('NO_TRADE');
    expect(d.reasons.find((r) => r.startsWith('oi:'))).toMatch(/^oi: NO_DATA/);
    expect(entryDecision(input({ oi: null })).action).toBe('NO_TRADE');
    expect(entryDecision(input({ trend: trend('NO_DATA') })).action).toBe('NO_TRADE');
  });

  it('records the scores and is deterministic', () => {
    const a = entryDecision(input({}));
    expect(entryDecision(input({}))).toEqual(a);
    expect(a.scores).toMatchObject({ news: -0.3, newsLean: 'BEARISH', newsMaterial: true, trendLean: 'BEARISH', oiVerdict: 'AGREES', oiLean: 'BEARISH', chainLeanOpen: -0.11 });
  });

  it('oiLean / wantFor', () => {
    expect(oiLean(oi('BULLISH', 'AGAINST'))).toBe('BEARISH');
    expect(oiLean(oi('BULLISH', 'MIXED'))).toBe('NEUTRAL');
    expect(oiLean(null)).toBe('NO_DATA');
    expect(wantFor({ lean: 'NEUTRAL' }, { lean: 'BEARISH' })).toBe('BEARISH');
    expect(wantFor({ lean: 'BULLISH' }, { lean: 'BEARISH' })).toBe('BULLISH');
    expect(wantFor({ lean: 'NO_DATA' }, { lean: 'NO_DATA' })).toBe('BULLISH');
  });
});

describe('entryGuards (cooldowns)', () => {
  it('passes with nothing open, under the daily cap, outside the last 30 min', () => {
    expect(entryGuards({ openForUnderlying: 0, tradesToday: 2, minutesToClose: 31 })).toEqual({ ok: true, reasons: [] });
  });
  it('max 1 open per underlying, max 3 a day, none in the last 30 min, fails closed on an unreadable clock', () => {
    expect(entryGuards({ openForUnderlying: 1, tradesToday: 0, minutesToClose: 200 }).ok).toBe(false);
    expect(entryGuards({ openForUnderlying: 0, tradesToday: 3, minutesToClose: 200 }).ok).toBe(false);
    expect(entryGuards({ openForUnderlying: 0, tradesToday: 0, minutesToClose: 29 }).ok).toBe(false);
    expect(entryGuards({ openForUnderlying: 0, tradesToday: 0, minutesToClose: null }).ok).toBe(false);
  });
});

describe('event-day news waiver (2026-11-04 CRUDEOIL after the US midterms)', () => {
  const EVENT = { status: 'present' as const, events: [{ name: 'US_MIDTERM_RESULTS', at: '2026-11-04 IST session', impact: 'high' as const, affects: ['CRUDEOIL'], expectMove: true }] };
  const NO_DATA_NEWS: NewsReading = { lean: 'NO_DATA', score: 0, material: false, items: [], freshestAgeMin: null, summary: 'no news read in the last 60 min' };
  it('19:35 shape: news NO_DATA, trend BEARISH, OI AGREES bearish, event day ⇒ ENTER_PE', () => {
    const d = entryDecision(input({ news: NO_DATA_NEWS, event: EVENT }));
    expect(d.action).toBe('ENTER_PE');
    expect(d.reasons[0]).toMatch(/^news: waived on an event day/);
  });
  it('the same without an event day stays NO_TRADE', () => {
    expect(entryDecision(input({ news: NO_DATA_NEWS })).action).toBe('NO_TRADE');
  });
  it('non-material news on the trend side is waived too', () => {
    expect(entryDecision(input({ news: news('BEARISH', false), event: EVENT })).action).toBe('ENTER_PE');
  });
  it('news pointing AGAINST the trend still blocks (evidence, not absence)', () => {
    expect(entryDecision(input({ news: news('BULLISH', false), event: EVENT })).action).toBe('NO_TRADE');
  });
  it('OI must still confirm; a neutral trend gets no waiver', () => {
    expect(entryDecision(input({ news: NO_DATA_NEWS, event: EVENT, oi: oi('BEARISH', 'MIXED') })).action).toBe('NO_TRADE');
    expect(entryDecision(input({ news: NO_DATA_NEWS, event: EVENT, trend: trend('NEUTRAL') })).action).toBe('NO_TRADE');
  });
  it('an absent calendar waives nothing', () => {
    expect(entryDecision(input({ news: NO_DATA_NEWS, event: { status: 'absent', reason: 'db down' } })).action).toBe('NO_TRADE');
  });
});

describe('strong news is remembered for the IST day (owner 2026-11-09: Iran talks read BEAR MED at 07:15, crude fell all evening)', () => {
  const evening = new Date('2026-11-09T14:30:00Z'); // 20:00 IST
  const morning = new Date('2026-11-09T01:45:00Z'); // 07:15 IST
  const row = (o: Partial<ImpactRow>) => impact({ analysedAt: morning, firstSeen: morning, ...o });

  it('a MED or HIGH story not priced in still counts in the evening', () => {
    const r = newsReading([row({ clusterId: 'a', confidence: 0.6 })], 'CRUDEOIL', evening);
    expect(r).toMatchObject({ lean: 'BEARISH', material: true });
    expect(newsReading([row({ clusterId: 'h', magnitude: 'HIGH' })], 'CRUDEOIL', evening).lean).toBe('BEARISH');
  });
  it('a LOW story or one already priced in stays on the 60 minute window', () => {
    expect(newsReading([row({ magnitude: 'LOW' })], 'CRUDEOIL', evening).lean).toBe('NO_DATA');
    expect(newsReading([row({ pricedIn: true })], 'CRUDEOIL', evening).lean).toBe('NO_DATA');
  });
  it('yesterday does not carry over', () => {
    const y = new Date('2026-11-08T18:29:00Z'); // 23:59 IST the day before
    expect(newsReading([row({ analysedAt: y, firstSeen: y })], 'CRUDEOIL', evening).lean).toBe('NO_DATA');
  });
  it('a later story the other way offsets it', () => {
    const late = new Date('2026-11-09T14:00:00Z');
    const r = newsReading([row({ clusterId: 'a' }), row({ clusterId: 'b', direction: 'BULL', analysedAt: late, firstSeen: late })], 'CRUDEOIL', evening);
    expect(r.lean).toBe('NEUTRAL');
  });
});

describe('INPUT_NOT_READY at the session open (self-review 2026-11-03..09: the 09:20 IST cycle decided before the trend / OI existed)', () => {
  const OPEN = new Date('2026-11-09T03:45:00Z'); // NSE 09:15 IST
  const FIRST = new Date('2026-11-09T03:50:00Z'); // the 09:20 IST cycle
  const EVENT = { status: 'present' as const, events: [{ name: 'US_MIDTERM_RESULTS', at: '2026-11-04 IST session', impact: 'high' as const, affects: ['CRUDEOIL'], expectMove: true }] };
  it('trend NO_DATA (4 session bars) at the first cycle ⇒ NO_TRADE marked INPUT_NOT_READY, never a plain NO_TRADE', () => {
    const d = entryDecision(input({ underlying: 'NIFTY', at: FIRST, sessionStart: OPEN, trend: trend('NO_DATA') }));
    expect(d.action).toBe('NO_TRADE');
    expect(d.direction).toBeNull();
    expect(d.inputNotReady).toEqual(['trend']);
    expect(d.reasons[0]).toMatch(/^INPUT_NOT_READY: trend not populated 5 min after the session open/);
  });
  it('no OI snapshot yet (or none read) at the first cycle ⇒ INPUT_NOT_READY, even on an event day', () => {
    for (const o of [oi('BEARISH', 'NO_DATA'), null]) {
      const d = entryDecision(input({ at: FIRST, sessionStart: OPEN, oi: o, event: EVENT }));
      expect(d.action).toBe('NO_TRADE');
      expect(d.inputNotReady).toEqual(['oi']);
    }
    const both = entryDecision(input({ at: FIRST, sessionStart: OPEN, trend: trend('NO_DATA'), oi: null }));
    expect(both.inputNotReady).toEqual(['trend', 'oi']);
  });
  it('inputs present at the first cycle decide normally; a NO_DATA after the warm-up is a plain NO_TRADE (a real gap)', () => {
    expect(entryDecision(input({ at: FIRST, sessionStart: OPEN })).action).toBe('ENTER_PE');
    const later = entryDecision(input({ at: new Date(OPEN.getTime() + ENTRY_ENGINE.inputWarmupMin * MIN), sessionStart: OPEN, oi: null }));
    expect(later.action).toBe('NO_TRADE');
    expect(later.inputNotReady).toBeUndefined();
    expect(later.reasons[0]).not.toMatch(/INPUT_NOT_READY/);
    // No session start given (the replay, older callers): unchanged.
    expect(entryDecision(input({ at: FIRST, trend: trend('NO_DATA') })).inputNotReady).toBeUndefined();
  });
});
