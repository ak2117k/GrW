import { ENGINE_UNIVERSE } from './engine-inputs';
import { entryDecision, eventReason, impactConcerns, newsReading, type EntryInput, type ImpactRow, type NewsReading, type OiReading, type TrendReading } from './entry-decision';
import { headlineAbout, themeMatch } from './news-theme';

/**
 * 2026-11-04 (US midterm results, GOLD ~3.5k points): GOLD and SILVER join the entry engine (paper),
 * with bullion news maps; the decision records the event day; EVENT_RISK stories read as "move
 * expected", never as a direction.
 */
const AT = new Date('2026-11-04T05:35:00Z'); // 11:05 IST
const MIN = 60_000;
const impact = (o: Partial<ImpactRow> = {}): ImpactRow => ({
  clusterId: 'g1',
  analysedAt: new Date(AT.getTime() - 5 * MIN),
  firstSeen: new Date(AT.getTime() - 30 * MIN),
  direction: 'NEUTRAL',
  magnitude: 'LOW',
  confidence: 0.6,
  pricedIn: false,
  symbols: [],
  sectors: [],
  indexName: null,
  material: false,
  materialType: 'NEWS',
  headline: 'Gold rises as dollar weakens ahead of US midterm election results',
  ...o,
});

describe('entry engine — GOLD / SILVER', () => {
  it('the universe contains GOLD and SILVER (and still not GOLDM)', () => {
    expect(ENGINE_UNIVERSE).toEqual(expect.arrayContaining(['GOLD', 'SILVER', 'CRUDEOIL', 'NIFTY']));
    expect(ENGINE_UNIVERSE as readonly string[]).not.toContain('GOLDM');
  });

  it('"Gold rises as dollar weakens" matches GOLD; "Muthoot gold loan NPAs" does not', () => {
    expect(headlineAbout('GOLD', 'Gold rises as dollar weakens')).toBe(true);
    expect(headlineAbout('GOLD', 'Muthoot gold loan NPAs')).toBe(false);
    expect(themeMatch('GOLD', impact({ headline: 'Gold rises as dollar weakens' }))).toBe('HEADLINE');
    expect(themeMatch('GOLD', impact({ headline: 'Muthoot gold loan NPAs' }))).toBeNull();
    // Bullion / yellow metal / Comex wording; a lender headline that names the price is rescued.
    expect(headlineAbout('GOLD', 'Yellow metal slips as Comex gold eases')).toBe(true);
    expect(headlineAbout('GOLD', 'Manappuram shares jump as gold prices hit a record')).toBe(true);
    expect(headlineAbout('GOLD', 'Golden Tobacco posts Q2 loss')).toBe(false);
    expect(headlineAbout('SILVER', 'Silver tanks Rs 2,000/kg on US jobs data')).toBe(true);
    expect(headlineAbout('SILVER', 'A silver lining for IT stocks')).toBe(false);
  });

  it('NEWS_MATCH: GOLD / GOLDM symbols and the MCX BULLION sector concern GOLD; GOLDM news is not SILVER', () => {
    expect(impactConcerns('GOLD', { symbols: ['GOLD'], sectors: [], indexName: null })).toBe(true);
    expect(impactConcerns('GOLD', { symbols: ['GOLDM'], sectors: [], indexName: null })).toBe(true);
    expect(impactConcerns('GOLD', { symbols: [], sectors: ['MCX BULLION'], indexName: null })).toBe(true);
    expect(impactConcerns('SILVER', { symbols: [], sectors: ['MCX BULLION'], indexName: null })).toBe(true);
    expect(impactConcerns('SILVER', { symbols: ['GOLDM'], sectors: [], indexName: null })).toBe(false);
    expect(themeMatch('GOLD', impact({ sectors: ['MCX BULLION'], headline: 'Precious metals extend gains' }))).toBe('DIRECT');
  });

  it('EVENT_RISK stories read as "move expected" and add no direction', () => {
    const r = newsReading(
      [impact({ symbols: ['GOLD'], eventRisk: true }), impact({ clusterId: 'g2', symbols: ['GOLD'], direction: 'NEUTRAL', eventRisk: null })],
      'GOLD',
      AT,
    );
    expect(r.lean).toBe('NEUTRAL');
    expect(r.score).toBe(0);
    expect(r.moveExpected).toBe(1);
    expect(r.items.find((i) => i.clusterId === 'g1')?.eventRisk).toBe(true);
    expect(r.summary).toMatch(/move expected \(1 EVENT_RISK story, no direction\)/);
    // Rows read before the tag existed: no moveExpected key at all.
    expect(newsReading([impact({ symbols: ['GOLD'] })], 'GOLD', AT).moveExpected).toBeUndefined();
  });

  describe('event day in the decision reasons', () => {
    const news: NewsReading = { lean: 'NEUTRAL', score: 0, material: false, items: [], freshestAgeMin: 5, summary: 'news NEUTRAL' };
    const trend: TrendReading = { lean: 'BULLISH', price: 140350, vwap: 139815, vwapSource: 'VWAP', vwapPct: 0.004, ema15: 140000, ema15Slope: 0.001, ema1h: 139500, ema1hSlope: 0.001, sessionBars: 120, summary: 'trend BULLISH' };
    const oi: OiReading = { want: 'BULLISH', verdict: 'AGREES', source: 'CHAIN', futuresVerdict: 'NO_DATA', summary: 'oi AGREES', chainLeanAgo: 0.03, chainLeanOpen: 0.05 };
    const input = (o: Partial<EntryInput>): EntryInput => ({ underlying: 'GOLD', at: AT, news, trend, oi, ...o });

    it('an event affecting GOLD is named in the reasons; it waives neutral news, and the TREND (not the event) sets the side', () => {
      const d = entryDecision(
        input({ event: { status: 'present', events: [{ name: 'US midterm election results', at: '2026-11-04 IST session', impact: 'high', affects: ['GOLD', 'NIFTY'], expectMove: true }] } }),
      );
      expect(d.reasons).toContain('event: US midterm election results (2026-11-04 IST session, high) — big move expected, direction unknown');
      // 2026-11-04 evening event-day news waiver: news NEUTRAL + trend BULLISH + OI AGREES ⇒ CE.
      expect(d.action).toBe('ENTER_CE');
      expect(d.reasons[0]).toMatch(/^news: waived on an event day/);
    });

    it('an absent calendar says absent with its reason, never "no event"', () => {
      expect(eventReason('GOLD', { status: 'absent', reason: 'the events calendar could not be read (db down)' })).toBe(
        'event: absent — the events calendar could not be read (db down)',
      );
      expect(eventReason('GOLD', { status: 'present', events: [] })).toBe('event: none scheduled affecting GOLD');
      expect(eventReason('GOLD', undefined)).toBeNull();
      // Not read (older callers / the replay): the reasons are exactly today's three.
      expect(entryDecision(input({})).reasons).toHaveLength(3);
    });
  });
});
