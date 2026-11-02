import type { ImpactRow } from './entry-decision';
import { headlineAbout, NEWS_THEME, newsTheme, themeMatch } from './news-theme';

const at = (iso: string) => new Date(iso);
let n = 0;
function impact(o: Partial<ImpactRow> & Pick<ImpactRow, 'headline' | 'direction' | 'analysedAt' | 'firstSeen'>): ImpactRow {
  n++;
  return {
    clusterId: `c${n}`,
    magnitude: 'LOW',
    confidence: 0.4,
    pricedIn: false,
    symbols: [],
    sectors: [],
    indexName: null,
    material: false,
    materialType: 'NEWS',
    sources: [`src${n}`],
    instruments: [],
    ...o,
  };
}

/** Prod news_impacts of Mon 2 Nov 2026 (analysed 09:00–09:45 IST), as read — every one LOW. */
function crude2Nov(): ImpactRow[] {
  return [
    impact({ headline: 'Oil prices fall over 1% as Iran-Qatar talks raise hopes of diplomatic progress', direction: 'BEAR', symbols: ['CRUDEOIL'], sectors: ['MCX ENERGY'], instruments: ['CRUDEOIL'], analysedAt: at('2026-11-02T03:30:00Z'), firstSeen: at('2026-11-02T01:27:00Z'), sources: ['Hindu BusinessLine Commodities', 'Business Standard Markets', 'Economic Times'] }),
    impact({ headline: 'Oil slips more than 1% as talks continue on ending Iran war', direction: 'BEAR', sectors: ['MCX ENERGY'], analysedAt: at('2026-11-02T03:45:00Z'), firstSeen: at('2026-11-02T02:30:00Z'), sources: ['Investing.com Commodities'] }),
    impact({ headline: 'Oil falls as Trump favours Iran diplomacy before midterm elections', direction: 'BEAR', sectors: ['MCX ENERGY'], analysedAt: at('2026-11-02T03:45:00Z'), firstSeen: at('2026-11-02T02:30:00Z'), sources: ['Investing.com Commodities'] }),
    impact({ headline: 'Stock selloff eases in Asian trade, oil declines: Markets wrap', direction: 'BEAR', confidence: 0.5, sectors: ['MCX ENERGY'], instruments: ['ASIAN', 'CRUDEOIL'], analysedAt: at('2026-11-02T03:45:00Z'), firstSeen: at('2026-11-02T03:09:00Z'), sources: ['Hindu BusinessLine Markets'] }),
    // A BULL read aimed at the INDEX (GIFT Nifty up) and one at OMC stocks: not crude calls.
    impact({ headline: 'Stock Market LIVE: GIFT Nifty rises over 100 pts; Asia markets mixed; Brent crude drops 2%', direction: 'BULL', confidence: 0.5, pricedIn: true, sectors: ['MCX ENERGY'], indexName: 'NIFTY', instruments: ['NIFTY', 'SENSEX', 'CRUDEOIL'], analysedAt: at('2026-11-02T03:30:00Z'), firstSeen: at('2026-11-02T02:22:00Z') }),
    impact({ headline: 'Goldman raises oil price forecast for December and 2027', direction: 'BULL', magnitude: 'MED', confidence: 0.5, symbols: ['IOC', 'BPCL', 'HINDPETRO'], sectors: ['MCX ENERGY', 'NIFTY ENERGY'], instruments: ['CRUDEOIL'], analysedAt: at('2026-11-02T04:15:00Z'), firstSeen: at('2026-11-02T01:35:00Z') }),
    impact({ headline: 'OPEC+ keeps December oil output targets steady ahead of tougher call for 2027', direction: 'NEUTRAL', confidence: 0.6, pricedIn: true, sectors: ['MCX ENERGY'], instruments: ['CRUDEOIL'], analysedAt: at('2026-11-02T03:45:00Z'), firstSeen: at('2026-11-02T02:30:00Z') }),
    impact({ headline: "India's record crude imports signal strong refinery runs", direction: 'BULL', sectors: ['MCX ENERGY'], instruments: ['ASIAN', 'CRUDEOIL'], analysedAt: at('2026-11-02T03:45:00Z'), firstSeen: at('2026-11-01T05:22:00Z') }),
  ];
}

describe('news theme score', () => {
  it('CRUDEOIL 2 Nov 10:35 IST: five outlets, all BEAR LOW → a MATERIAL bearish theme (the per-story rule saw none)', () => {
    const t = newsTheme(crude2Nov(), 'CRUDEOIL', at('2026-11-02T05:05:00Z'), NEWS_THEME.intraday);
    expect(t.side).toBe('BEARISH');
    expect(t.material).toBe(true);
    expect(t.stories).toBe(4);
    expect(t.sources).toBeGreaterThanOrEqual(5);
    expect(t.net).toBeLessThanOrEqual(-NEWS_THEME.minNet);
    expect(t.summary).toContain('(material)');
    // The index-aimed GIFT story and the OMC-aimed Goldman story are not read as crude calls.
    expect(t.items.map((i) => i.headline)).not.toContain('Goldman raises oil price forecast for December and 2027');
    expect(t.items.some((i) => i.headline.startsWith('Stock Market LIVE'))).toBe(false);
  });

  it('no look-ahead: at 09:00 IST (before the model read them) there is no theme', () => {
    const t = newsTheme(crude2Nov(), 'CRUDEOIL', at('2026-11-02T03:29:00Z'), NEWS_THEME.intraday);
    expect(t.items).toHaveLength(0);
    expect(t.material).toBe(false);
    expect(t.side).toBeNull();
  });

  it('a MIXED set (3 bear, 3 bull, several outlets) is not material', () => {
    const a = at('2026-11-02T05:00:00Z');
    const f = at('2026-11-02T04:30:00Z');
    const rows = [
      ...['Oil falls on talks', 'Crude slips 1%', 'Brent eases as supply returns'].map((h) => impact({ headline: h, direction: 'BEAR', symbols: ['CRUDEOIL'], analysedAt: a, firstSeen: f })),
      ...['Oil rises on Hormuz attack', 'Crude jumps 2%', 'Brent climbs on OPEC cut'].map((h) => impact({ headline: h, direction: 'BULL', symbols: ['CRUDEOIL'], analysedAt: a, firstSeen: f })),
    ];
    const t = newsTheme(rows, 'CRUDEOIL', at('2026-11-02T05:05:00Z'));
    expect(t.material).toBe(false);
  });

  it('four same-side stories from ONE source are not material; a lean that is too small is not either', () => {
    const a = at('2026-11-02T05:00:00Z');
    const f = at('2026-11-02T04:50:00Z');
    const one = ['Oil falls', 'Oil slips', 'Crude drops', 'Brent eases'].map((h) => impact({ headline: h, direction: 'BEAR', symbols: ['CRUDEOIL'], analysedAt: a, firstSeen: f, sources: ['Investing.com Commodities'] }));
    const t1 = newsTheme(one, 'CRUDEOIL', at('2026-11-02T05:05:00Z'));
    expect(t1.side).toBe('BEARISH');
    expect(t1.material).toBe(false);
    expect(t1.summary).toContain('source(s)');
    const stale = ['Oil falls', 'Oil slips', 'Crude drops', 'Brent eases'].map((h) => impact({ headline: h, direction: 'BEAR', symbols: ['CRUDEOIL'], analysedAt: a, firstSeen: at('2026-11-01T05:00:00Z') }));
    expect(newsTheme(stale, 'CRUDEOIL', at('2026-11-02T05:05:00Z')).material).toBe(false);
  });

  it('matching: company names are not crude; an impact aimed at another target is not ours', () => {
    expect(headlineAbout('CRUDEOIL', 'Indian Oil net profit triples YoY')).toBe(false);
    expect(headlineAbout('CRUDEOIL', 'Oil prices fall amid diplomacy')).toBe(true);
    expect(headlineAbout('CRUDEOIL', 'Indian Oil shares fall as crude jumps')).toBe(true);
    const base = { sectors: [] as string[], indexName: null, headline: 'Oil falls 2%' };
    expect(themeMatch('CRUDEOIL', { ...base, symbols: ['CRUDEOIL'] })).toBe('DIRECT');
    expect(themeMatch('CRUDEOIL', { ...base, symbols: [] })).toBe('HEADLINE');
    expect(themeMatch('CRUDEOIL', { ...base, symbols: ['BPCL'] })).toBeNull();
    expect(themeMatch('CRUDEOIL', { ...base, symbols: [], indexName: 'NIFTY' })).toBeNull();
    expect(themeMatch('CRUDEOIL', { ...base, symbols: [], sectors: ['MCX ENERGY'], headline: 'Supply update' })).toBe('SECTOR');
  });
});
