import { buildEvidence, buildupKind, classifyMomentum, classifyNews, classifyTrend, evidenceChips, materialNews, oiClassOf, oiEvidence, OI_NOT_FNO, type RawNews } from './evidence';
import { atr, trendFromBars } from './holdings';
import { okTrend } from './review.fixtures';

const NOW = new Date('2026-11-02T08:00:00.000Z');

describe('classifyTrend', () => {
  const strong = okTrend({ dma20: 140, dma50: 130, dma200: 110, high52w: 155, ret6m: 25 });
  it('STRONG_UP: above 20/50/200, 50 > 200, 6m > 0, within 15% of the 52w high', () => {
    expect(classifyTrend(strong, 145)).toBe('STRONG_UP');
  });
  it('more than 15% under the 52w high is only UP', () => {
    expect(classifyTrend({ ...strong, high52w: 200 }, 145)).toBe('UP');
  });
  it('below the 20-DMA is not STRONG_UP', () => {
    expect(classifyTrend(strong, 135)).toBe('UP');
  });
  it('below the 200-DMA is DOWN; between 200 and 50 is WEAK', () => {
    expect(classifyTrend(strong, 100)).toBe('DOWN');
    expect(classifyTrend(strong, 120)).toBe('WEAK');
  });
  it('without a 200-DMA: below the 50-DMA and a negative 6m return is DOWN', () => {
    expect(classifyTrend(okTrend({ dma50: 100, dma200: null, ret6m: -5 }), 90)).toBe('DOWN');
    expect(classifyTrend(okTrend({ dma50: 100, dma200: null, ret6m: 5 }), 90)).toBe('WEAK');
  });
  it('NO_DATA without candles or price', () => {
    expect(classifyTrend({ ...strong, status: 'NO_DATA' }, 145)).toBe('NO_DATA');
    expect(classifyTrend({ ...strong, lastClose: null }, null)).toBe('NO_DATA');
  });
});

describe('classifyMomentum', () => {
  it('±2% band on the 1-month return', () => {
    expect(classifyMomentum(okTrend({ ret1m: 3 }))).toBe('POSITIVE');
    expect(classifyMomentum(okTrend({ ret1m: -2.5 }))).toBe('NEGATIVE');
    expect(classifyMomentum(okTrend({ ret1m: 1 }))).toBe('FLAT');
    expect(classifyMomentum(okTrend({}))).toBe('NO_DATA');
  });
});

describe('trendFromBars extras', () => {
  it('adds 20-DMA, 1-month return, ATR(14) and the last close', () => {
    const bars = Array.from({ length: 60 }, (_, i) => ({ close: 100 + i, high: 101 + i, low: 99 + i }));
    const t = trendFromBars(bars);
    expect(t.lastClose).toBe(159);
    expect(t.dma20).toBeCloseTo(149.5, 2);
    expect(t.ret1m).toBeCloseTo(((159 - 139) / 139) * 100, 1);
    expect(t.atr14).toBe(2); // high − low = 2 each day, gap to prev close = 2
    expect(atr(bars.slice(0, 10), 14)).toBeNull();
  });
});

describe('news', () => {
  const n = (over: Partial<RawNews>): RawNews => ({ at: new Date('2026-11-01T05:00:00Z'), headline: 'Acme wins ₹500 crore order', direction: 'BULL', magnitude: 'MED', oneLine: 'order win', ...over });
  it('keeps MED/HIGH, non-recap, non-boilerplate items of the last 7 days, newest first', () => {
    const items = materialNews(
      [
        n({}),
        n({ magnitude: 'LOW' }),
        n({ headline: 'Sensex falls 600 pts as banks drag' }),
        n({ headline: 'Top gainers and losers today' }),
        n({ oneLine: '[recap] already moved' }),
        n({ boilerplate: true }),
        n({ at: new Date('2026-10-20T05:00:00Z') }),
        n({ at: new Date('2026-11-02T06:00:00Z'), headline: 'Acme Q2 miss', direction: 'BEAR', magnitude: 'HIGH' }),
      ],
      NOW,
    );
    expect(items.map((i) => i.headline)).toEqual(['Acme Q2 miss', 'Acme wins ₹500 crore order']);
  });
  it('classifies by bull vs bear count', () => {
    const it2 = (d: string) => ({ at: '', headline: '', direction: d, magnitude: 'MED', oneLine: '' });
    expect(classifyNews([])).toBe('NONE');
    expect(classifyNews([it2('BULL'), it2('BULL'), it2('BEAR')])).toBe('POSITIVE');
    expect(classifyNews([it2('BEAR')])).toBe('NEGATIVE');
    expect(classifyNews([it2('BULL'), it2('BEAR')])).toBe('MIXED');
    expect(classifyNews([it2('NEUTRAL')])).toBe('NONE');
  });
});

describe('futures OI', () => {
  it('build-up kinds and their class', () => {
    expect(buildupKind(3, 8)).toBe('LONG_BUILDUP');
    expect(buildupKind(-3, 8)).toBe('SHORT_BUILDUP');
    expect(buildupKind(3, -8)).toBe('SHORT_COVERING');
    expect(buildupKind(-3, -8)).toBe('LONG_UNWINDING');
    expect(buildupKind(3, 1)).toBe('FLAT');
    expect(buildupKind(0.2, 9)).toBe('FLAT');
    expect(oiClassOf('LONG_BUILDUP')).toBe('SUPPORTIVE');
    expect(oiClassOf('SHORT_BUILDUP')).toBe('ADVERSE');
    expect(oiClassOf('LONG_UNWINDING')).toBe('ADVERSE');
    expect(oiClassOf('SHORT_COVERING')).toBe('NEUTRAL');
  });
  it('uses the last 5 sessions (6 points) of the series', () => {
    const pts = Array.from({ length: 10 }, (_, i) => ({ date: `2026-10-${String(20 + i).padStart(2, '0')}`, close: 100 + i, oi: i < 4 ? 1000 : 1000 + (i - 3) * 50 }));
    const e = oiEvidence(pts, 'BROKER');
    expect(e.sessions).toBe(5);
    expect(e.days).toHaveLength(5);
    expect(e.pricePct).toBeCloseTo(((109 - 104) / 104) * 100, 1);
    expect(e.oiPct).toBeCloseTo(((1300 - 1050) / 1050) * 100, 1);
    expect(e.buildup).toBe('LONG_BUILDUP');
    expect(e.status).toBe('SUPPORTIVE');
  });
  it('fewer than 3 sessions is NO_DATA', () => {
    expect(oiEvidence([{ date: '2026-11-01', close: 1, oi: 1 }], 'SNAPSHOTS').status).toBe('NO_DATA');
  });
});

describe('buildEvidence + chips', () => {
  it('derives distances from the 52w range and chips in a fixed order', () => {
    const e = buildEvidence({ trend: okTrend({ dma20: 140, dma50: 130, dma200: 110, high52w: 150, low52w: 100, ret6m: 25, ret1m: 4 }), price: 145, news: [], oi: OI_NOT_FNO, events: [{ kind: 'results', title: 'Q2', at: '2026-11-10T03:45:00.000Z' }], sector: 'IT' });
    expect(e.fromHigh52wPct).toBe(3.3);
    expect(e.fromLow52wPct).toBe(45);
    expect(e.trend).toBe('STRONG_UP');
    expect(evidenceChips(e).map((c) => c.label)).toEqual(['Strong uptrend', '6m +25%', '1m +4%', '3.3% below 52w high', 'results 2026-11-10']);
  });
});
