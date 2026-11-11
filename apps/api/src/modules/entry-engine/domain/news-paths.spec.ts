import { entryDecision, type NewsReading, type OiReading, type TrendReading } from './entry-decision';
import { isNseBseUnderlying, PRE_OPEN_BIAS, preOpenUsable, withNewsPaths, type PreOpenBiasInput } from './news-paths';
import type { NewsTheme } from './news-theme';

const AT_0920 = new Date('2026-11-02T03:50:00Z'); // 09:20 IST
const AT_1035 = new Date('2026-11-02T05:05:00Z'); // 10:35 IST

const neutralNews: NewsReading = { lean: 'NEUTRAL', score: -0.1, material: false, items: [], freshestAgeMin: 20, summary: 'neutral score -0.1 from 1 story' };
const bullNews: NewsReading = { ...neutralNews, lean: 'BULLISH', score: 0.3, summary: 'bullish score 0.3' };
const storyMaterial: NewsReading = { ...neutralNews, lean: 'BULLISH', score: 0.6, material: true, materialPath: 'STORY', summary: 'bullish (material)' };

const theme = (material: boolean, side: NewsTheme['side'] = 'BEARISH'): NewsTheme => ({
  side,
  material,
  stories: 4,
  against: 0,
  neutral: 2,
  sources: 5,
  net: -0.31,
  sideShare: 1,
  windowMin: 180,
  items: [],
  summary: `theme bearish net -0.31${material ? ' (material)' : ''}`,
});

const pre = (o: Partial<PreOpenBiasInput> = {}): PreOpenBiasInput => ({
  underlying: 'CRUDEOIL',
  sessionDate: '2026-11-02',
  bias: 'BEARISH',
  confidence: 0.75,
  at: '2026-11-02T03:00:00.000Z',
  summary: 'CRUDEOIL BEARISH: CL=F -3.21% since the last close',
  ...o,
});

const trend = (lean: TrendReading['lean']): TrendReading => ({ lean, price: 9558, vwap: 9565, vwapSource: 'TWAP', vwapPct: -0.001, ema15: 9560, ema15Slope: -0.014, ema1h: 9600, ema1hSlope: -0.006, sessionBars: 60, summary: `${lean.toLowerCase()}: test` });
const oi = (want: 'BULLISH' | 'BEARISH', verdict: OiReading['verdict']): OiReading => ({ want, verdict, source: 'CHAIN', futuresVerdict: 'NO_DATA', summary: `${verdict} test`, chainLeanAgo: -0.03, chainLeanOpen: -0.2 });

describe('news paths (THEME / PRE_OPEN)', () => {
  it('the original STORY rule wins and is recorded', () => {
    const n = withNewsPaths(storyMaterial, theme(true), pre(), AT_0920);
    expect(n).toMatchObject({ lean: 'BULLISH', material: true, materialPath: 'STORY' });
  });

  it('a material theme makes neutral news material on its side', () => {
    const n = withNewsPaths(neutralNews, theme(true), null, AT_1035);
    expect(n).toMatchObject({ lean: 'BEARISH', material: true, materialPath: 'THEME' });
    expect(n.summary).toContain('60-min read');
  });

  it('a theme never overrides a 60-min read leaning the other way; a non-material theme does nothing', () => {
    expect(withNewsPaths(bullNews, theme(true), null, AT_1035)).toMatchObject({ lean: 'BULLISH', material: false, materialPath: null });
    expect(withNewsPaths(neutralNews, theme(false), null, AT_1035)).toMatchObject({ lean: 'NEUTRAL', material: false });
  });

  it('pre-open bias: only today, only ≥ min confidence, only in the opening window', () => {
    expect(preOpenUsable(pre(), AT_0920).ok).toBe(true);
    expect(preOpenUsable(pre({ confidence: PRE_OPEN_BIAS.minConfidence - 0.01 }), AT_0920).ok).toBe(false);
    expect(preOpenUsable(pre({ sessionDate: '2026-10-30' }), AT_0920).ok).toBe(false);
    expect(preOpenUsable(pre({ bias: 'NEUTRAL' }), AT_0920).ok).toBe(false);
    expect(preOpenUsable(pre(), AT_1035).ok).toBe(false); // 10:35 > 09:20 + 45 min
    expect(preOpenUsable(null, AT_0920).ok).toBe(false);
    expect(withNewsPaths(neutralNews, null, pre(), AT_0920)).toMatchObject({ lean: 'BEARISH', material: true, materialPath: 'PRE_OPEN' });
    expect(withNewsPaths(neutralNews, null, pre(), AT_1035)).toMatchObject({ lean: 'NEUTRAL', material: false });
  });

  it('2026-11-11: on NSE / BSE underlyings the pre-open (GIFT gap) bias expires at 09:30 IST; MCX keeps the opening window', () => {
    const at = (hhmm: string) => new Date(`2026-11-02T${hhmm}:00+05:30`);
    const nifty = pre({ underlying: 'NIFTY', bias: 'BULLISH' });
    expect(preOpenUsable(nifty, at('09:20')).ok).toBe(true);
    expect(preOpenUsable(nifty, at('09:30')).ok).toBe(true);
    const late = preOpenUsable(nifty, at('09:50'));
    expect(late).toEqual({ ok: false, why: expect.stringContaining('expired at 09:30 IST') });
    expect(preOpenUsable(pre({ underlying: 'BANKNIFTY', bias: 'BULLISH' }), at('09:35')).ok).toBe(false);
    expect(preOpenUsable(pre({ underlying: 'SENSEX', bias: 'BULLISH' }), at('09:35')).ok).toBe(false);
    expect(withNewsPaths(neutralNews, null, pre({ underlying: 'BANKNIFTY', bias: 'BULLISH' }), at('09:50'))).toMatchObject({ lean: 'NEUTRAL', material: false, materialPath: null });
    // MCX: unchanged (09:20 + 45 min).
    expect(preOpenUsable(pre(), at('09:50')).ok).toBe(true);
    expect(preOpenUsable(pre(), at('10:05')).ok).toBe(true);
    expect(preOpenUsable(pre({ underlying: 'GOLD' }), at('09:50')).ok).toBe(true);
    expect(isNseBseUnderlying('NIFTY')).toBe(true);
    expect(isNseBseUnderlying('crudeoil')).toBe(false);
  });

  it('the engine uses the pre-open bias ONLY when trend and OI agree (all-agree rule stays)', () => {
    const news = withNewsPaths(neutralNews, null, pre(), AT_0920);
    const enter = entryDecision({ underlying: 'CRUDEOIL', at: AT_0920, news, trend: trend('BEARISH'), oi: oi('BEARISH', 'AGREES') });
    expect(enter.action).toBe('ENTER_PE');
    expect(enter.reasons[0]).toContain('material via PRE_OPEN');
    expect(enter.scores.newsMaterialPath).toBe('PRE_OPEN');

    expect(entryDecision({ underlying: 'CRUDEOIL', at: AT_0920, news, trend: trend('NEUTRAL'), oi: oi('BEARISH', 'AGREES') }).action).toBe('NO_TRADE');
    expect(entryDecision({ underlying: 'CRUDEOIL', at: AT_0920, news, trend: trend('NO_DATA'), oi: oi('BEARISH', 'AGREES') }).action).toBe('NO_TRADE');
    expect(entryDecision({ underlying: 'CRUDEOIL', at: AT_0920, news, trend: trend('BEARISH'), oi: oi('BEARISH', 'MIXED') }).action).toBe('NO_TRADE');
    expect(entryDecision({ underlying: 'CRUDEOIL', at: AT_0920, news, trend: trend('BULLISH'), oi: oi('BEARISH', 'AGREES') }).action).toBe('NO_TRADE');
    expect(entryDecision({ underlying: 'CRUDEOIL', at: AT_0920, news, trend: trend('BEARISH'), oi: null }).action).toBe('NO_TRADE');
  });
});
