import { newsImpactSummary, scoreNewsImpact, type NewsImpactVerifyRow } from './news-impact-scorer';

const row = (o: Partial<NewsImpactVerifyRow> = {}): NewsImpactVerifyRow => ({
  id: 'r1', clusterId: 'c1', symbol: 'TCS', direction: 'BEAR', magnitude: 'HIGH', horizon: 'INTRADAY', judgeSession: '2026-10-23', atr: 60,
  p0: 3000, p15: 2990, p60: 2970, pClose: 2960, pNextClose: 2950, materialType: 'GUIDANCE_UPDATE', firstSource: 'Economic Times',
  sources: ['Economic Times', 'LiveMint'], headline: 'TCS cuts guidance', oneLine: 'Guidance cut.', ...o,
});

describe('NEWS_IMPACT scorer', () => {
  it('right when the +60 m move is beyond the band in the called direction', () => {
    const d = scoreNewsImpact(row())!;
    expect(d).toMatchObject({ kind: 'NEWS_IMPACT', refId: 'r1', subject: 'GUIDANCE_UPDATE', symbol: 'TCS', correct: true, score: 1, sessionDate: '2026-10-23' });
    expect(d.details).toMatchObject({ status: 'RIGHT', magnitude: 'HIGH', firstSource: 'Economic Times' });
  });

  it('wrong the other way, null inside the band / without a judge session', () => {
    expect(scoreNewsImpact(row({ direction: 'BULL' }))!.correct).toBe(false);
    expect(scoreNewsImpact(row({ p60: 2995 }))!.correct).toBeNull();
    expect(scoreNewsImpact(row({ judgeSession: null }))).toBeNull();
    expect(scoreNewsImpact(row({ horizon: 'WEEKS' }))!.actual).toMatch(/not judged/);
  });

  it('summary: hit rate by source and material type; magnitude sanity', () => {
    const drafts = [
      scoreNewsImpact(row())!,
      scoreNewsImpact(row({ id: 'r2', direction: 'BULL', firstSource: 'NSE Announcements', materialType: 'RESULTS' }))!,
      scoreNewsImpact(row({ id: 'r3', magnitude: 'LOW', p60: 2999 }))!,
    ];
    const s = newsImpactSummary(drafts);
    expect(s.bySource['Economic Times']).toEqual({ n: 2, right: 1, wrong: 0, hitRate: 1 });
    expect(s.byMaterialType.RESULTS).toEqual({ n: 1, right: 0, wrong: 1, hitRate: 0 });
    expect(s.magnitudeSanity.HIGH.meanAbsMovePct).toBe(1);
    expect(s.magnitudeSanity.LOW.meanAbsMovePct).toBe(0.03);
    expect(s.magnitudeOrdered).toBe(true);
  });
});
