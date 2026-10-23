import { expectedPoints, mbmHeadline, normLine, relLabelFor, relativeCallCorrect } from './relative-reading';

describe('relative reading', () => {
  it('labels match the Python bands', () => {
    expect([0.5, 0.79, 0.8, 1.25, 1.26, 1.75, 1.76].map(relLabelFor)).toEqual([
      'QUIETER', 'QUIETER', 'NORMAL', 'NORMAL', 'BUSIER', 'BUSIER', 'MUCH_BUSIER',
    ]);
    expect([null, undefined, 0, -1, NaN].map(relLabelFor)).toEqual([null, null, null, null, null]);
  });

  it('points: the service’s own, else bp × spot / 1e4, else null', () => {
    expect(expectedPoints({ p: 1, regime: 'A', rangePts: [60.4, 80, 105] }, null)).toEqual([60, 80, 105]);
    expect(expectedPoints({ p: 1, regime: 'A', q25Bp: 24, q50Bp: 32, q75Bp: 42 }, 25_000)).toEqual([60, 80, 105]);
    expect(expectedPoints({ p: 1, regime: 'A', q25Bp: 24, q50Bp: 32, q75Bp: 42 }, null)).toBeNull();
    expect(expectedPoints({ p: 1, regime: 'A', rangePts: [null, 80, 105] }, null)).toBeNull();
  });

  it('headline: points + phrase, bp without a spot, range only without a relative reading', () => {
    const h = { p: 0.97, regime: 'ACTIVE', q25Bp: 24, q50Bp: 32, q75Bp: 42, relLabel: 'BUSIER' };
    expect(mbmHeadline('30m', h, 25_000)).toBe('Next 30 min: ~80 pts (60–105) · busier than recent days');
    expect(mbmHeadline('60m', { ...h, relLabel: null, relRatio: 0.5 }, 25_000)).toBe('Next 60 min: ~80 pts (60–105) · quieter than recent days');
    expect(mbmHeadline('30m', h, null)).toBe('Next 30 min: ~32 bp (24–42 bp) · busier than recent days');
    expect(mbmHeadline('30m', { ...h, relLabel: null }, 25_000)).toBe('Next 30 min: ~80 pts (60–105)');
    expect(mbmHeadline('30m', { p: 0.9, regime: 'ACTIVE' }, 25_000)).toBeNull();
    expect(normLine(h)).toBe('vs 60-day norm: BIG / ACTIVE p=0.97');
    expect(normLine({ p: 0.2, regime: 'QUIET' })).toBe('vs 60-day norm: small / QUIET p=0.20');
  });

  it('relative call verification rule', () => {
    expect(relativeCallCorrect('QUIETER', 15, 21)).toBe(true);
    expect(relativeCallCorrect('QUIETER', 22, 21)).toBe(false);
    expect(relativeCallCorrect('NORMAL', 21, 21)).toBe(true);
    expect(relativeCallCorrect('NORMAL', 27, 21)).toBe(false);
    expect(relativeCallCorrect('BUSIER', 22, 21)).toBe(true);
    expect(relativeCallCorrect('MUCH_BUSIER', 20, 21)).toBe(false);
    expect(relativeCallCorrect('WILD', 20, 21)).toBeNull();
    expect(relativeCallCorrect('BUSIER', null, 21)).toBeNull();
    expect(relativeCallCorrect('BUSIER', 20, 0)).toBeNull();
  });
});
