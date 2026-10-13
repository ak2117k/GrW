import { SentinelOvernightEvidenceAdapter } from './overnight-evidence.adapter';
import type { OvernightEvidenceQuery } from '../ports/overnight-evidence.port';

const ist = (ymd: string, hhmm: string) => new Date(`${ymd}T${hhmm}:00+05:30`);
const NOW = ist('2026-10-12', '15:45');
const SINCE = ist('2026-10-12', '15:30');

const q = (over: Partial<OvernightEvidenceQuery> = {}): OvernightEvidenceQuery => ({
  userId: 'u1',
  symbol: 'NIFTY13OCT2625000CE',
  exchange: 'NFO',
  segment: 'OPT',
  underlying: 'NIFTY',
  expiry: '2026-10-13',
  option: { underlying: 'NIFTY', strike: 25000, optionType: 'CE' },
  underlyingLtp: 25050,
  since: SINCE,
  now: NOW,
  ...over,
});

const leg = (over = {}) => ({ ltp: 120, oi: 50_000, oiChange: 8_000, volume: 1, iv: 13.2, delta: 0.52, gamma: 0.001, theta: -24, vega: 9.1, bidPrice: 0, askPrice: 0, ...over });
const chain = [
  { strikePrice: 24800, expiryDate: '2026-10-13', ceData: leg({ oi: 10_000, oiChange: 100 }), peData: leg({ oi: 90_000, oiChange: 2_000 }) },
  { strikePrice: 25000, expiryDate: '2026-10-13', ceData: leg(), peData: leg({ oi: 40_000, oiChange: -500 }) },
  { strikePrice: 25200, expiryDate: '2026-10-13', ceData: leg({ oi: 120_000, oiChange: 9_000 }), peData: leg({ oi: 5_000, oiChange: 0 }) },
];

const cueSnapshot = { enabled: true, marker: 'from-market-cues' };

function make(opts: { chainService?: boolean; commodities?: boolean; breadth?: boolean; cues?: boolean } = {}) {
  const article = (title: string, hhmm: string, over = {}) => ({
    title,
    source: 'LiveMint',
    url: `https://x/${title}`,
    sentiment: 'bearish',
    publishedAt: ist('2026-10-12', hhmm),
    fetchedAt: ist('2026-10-12', '15:40'),
    ...over,
  });
  const news = {
    getNewsForSymbol: jest.fn().mockResolvedValue([article('symbol story', '15:35')]),
    getNews: jest.fn().mockImplementation(async (f: { category?: string; search?: string; limit?: number }) => {
      if (f.limit === 1 && !f.category && !f.search) return { data: [article('latest', '15:39')] };
      if (f.category === 'sector') return { data: [article('sector story', '15:36')] };
      if (f.search) return { data: [article(`index story ${f.search}`, '15:37')] };
      return { data: [article(`macro ${f.category}`, '15:38')] };
    }),
  };
  const chainService = {
    getExpiries: jest.fn().mockResolvedValue(['2026-10-13', '2026-10-20']),
    getOptionsChainWithSpot: jest.fn().mockResolvedValue({ chain, spotPrice: 25050 }),
    getPCR: jest.fn().mockReturnValue(0.82),
    getMaxPain: jest.fn().mockReturnValue(25000),
  };
  const roll = {
    resolveFrontMonthTokens: jest.fn().mockResolvedValue([
      { symbol: 'CRUDEOIL', token: 'c1', exchange: 'MCX', contractSymbol: 'CRUDEOIL19OCT26FUT', expiry: '2026-10-19' },
      { symbol: 'GOLD', token: 'g1', exchange: 'MCX', contractSymbol: 'GOLD05DEC26FUT', expiry: '2026-12-05' },
    ]),
  };
  const resolver = {
    // GOLD is not quotable over this user's session.
    resolveQuotes: jest.fn().mockResolvedValue(
      new Map([['c1', { token: 'c1', ltp: 5600, change: -84, changePercent: -1.5, timestamp: ist('2026-10-12', '15:44') }]]),
    ),
  };
  const commodities = { roll, resolver };
  const breadth = {
    getSectorPerformance: jest.fn().mockResolvedValue([{ sector: 'IT', symbol: 'NIFTY IT', token: '99926013', changePercent: -1.2, ltp: 35000 }]),
  };
  const moduleRef = {
    get: jest.fn().mockImplementation((cls: { name: string }) => {
      if (cls.name === 'OptionsChainService' && opts.chainService !== false) return chainService;
      if (cls.name === 'CommodityRollService' && opts.commodities !== false) return roll;
      if (cls.name === 'MarketQuoteResolver' && opts.commodities !== false) return resolver;
      if (cls.name === 'BreadthSectorService' && opts.breadth !== false) return breadth;
      if (cls.name === 'MarketCuesService' && opts.cues !== false) return marketCues;
      throw new Error(`no provider ${cls.name}`);
    }),
  };
  const marketCues = {
    ensure: jest.fn().mockImplementation(async (groups: string[]) =>
      groups.includes('preOpen') ? { preOpen: { status: 'ok', values: { date: '2026-10-13', entries: {} } } } : cueSnapshot,
    ),
  };
  const marketContext = { getVixHistory: jest.fn().mockResolvedValue({ today: 13.4, yesterday: 12.8 }) };
  const yahoo = {
    getQuoteChange: jest.fn().mockResolvedValue({ previousClose: 25160, regularMarketPrice: 25050, regularMarketChange: -110, regularMarketChangePercent: -0.44 }),
  };
  const sectors = { getSectorIndexForSymbol: jest.fn().mockResolvedValue('99926013') };
  const findFirst = jest.fn().mockResolvedValue({
    capturedAt: ist('2026-10-09', '15:20'),
    spotPrice: 25160,
    chainJson: [
      { strikePrice: 24800, ceData: leg({ oi: 9_000 }), peData: leg({ oi: 80_000 }) },
      { strikePrice: 25000, ceData: leg({ ltp: 160, oi: 42_000 }), peData: leg({ oi: 41_000 }) },
      { strikePrice: 25200, ceData: leg({ oi: 100_000 }), peData: leg({ oi: 6_000 }) },
    ],
  });
  const adapter = new SentinelOvernightEvidenceAdapter(
    news as never,
    marketContext as never,
    yahoo as never,
    sectors as never,
    { optionChainSnapshot: { findFirst } } as never,
    moduleRef as never,
  );
  return { adapter, news, chainService, commodities, breadth, marketContext, yahoo, sectors, findFirst, marketCues };
}

describe('SentinelOvernightEvidenceAdapter.news — stored news since the close, four scopes', () => {
  it('asks for the symbol, its sector, its index and macro news, tagging each with its scope', async () => {
    const t = make();
    const ev = await t.adapter.news(q({ underlying: 'INFY', symbol: 'INFY27OCT261500CE' }));
    expect(t.news.getNewsForSymbol).toHaveBeenCalledWith('INFY');
    expect(ev.items.map((i) => i.scope)).toEqual(expect.arrayContaining(['symbol', 'sector', 'index', 'macro']));
    expect(ev.items.find((i) => i.scope === 'symbol')).toEqual(
      expect.objectContaining({ title: 'symbol story', source: 'LiveMint', sentiment: 'bearish', publishedAt: ist('2026-10-12', '15:35').toISOString() }),
    );
    // Only articles since the last close are requested from the store.
    for (const call of t.news.getNews.mock.calls) {
      if (call[0].limit !== 1) expect(call[0].from).toBe(SINCE.toISOString());
    }
  });

  it('reports when the store last took an article in, so staleness can be judged', async () => {
    const t = make();
    const ev = await t.adapter.news(q());
    expect(ev.lastFetchAt).toBe(ist('2026-10-12', '15:40').toISOString());
  });

  it('an index underlying has no single sector, so no sector query is made', async () => {
    const t = make();
    await t.adapter.news(q());
    expect(t.news.getNews.mock.calls.some((c) => c[0].category === 'sector')).toBe(false);
  });
});

describe('SentinelOvernightEvidenceAdapter.oi — the end-of-day chain read', () => {
  it('reads PCR and max pain through the chain service, and the walls from OI', async () => {
    const t = make();
    const { analysis } = await t.adapter.oi(q());
    expect(t.chainService.getOptionsChainWithSpot).toHaveBeenCalledWith('NIFTY', '2026-10-13');
    expect(analysis).toEqual(
      expect.objectContaining({ available: true, pcr: 0.82, maxPain: 25000, callWall: 25200, putWall: 24800, expiry: '2026-10-13' }),
    );
  });

  it('pairs the position’s own strike with the previous session’s stored chain', async () => {
    const t = make();
    const { analysis, legGreeks } = await t.adapter.oi(q());
    if (!analysis.available) throw new Error('expected a chain');
    expect(analysis.contract).toEqual(
      expect.objectContaining({ strike: 25000, optionType: 'CE', ltp: 120, oi: 50_000, oiChange: 8_000, prev: { ltp: 160, oi: 42_000 } }),
    );
    expect(analysis.prevSession).toEqual(expect.objectContaining({ spot: 25160, totalCeOi: 151_000, totalPeOi: 127_000 }));
    expect(analysis.totalOiChange).toBe(100 + 2_000 + 8_000 - 500 + 9_000 + 0);
    expect(analysis.underlyingPriceChange).toEqual({ value: -110, source: expect.stringMatching(/yahoo/) });
    expect(legGreeks).toEqual(expect.objectContaining({ delta: 0.52, theta: -24, vega: 9.1, iv: 13.2 }));
    // The snapshot looked up is from BEFORE the session this review looks back on.
    expect(t.findFirst.mock.calls[0][0].where.capturedAt.lt.toISOString()).toBe(ist('2026-10-12', '00:00').toISOString());
  });

  it('uses the same chain path for an MCX underlying', async () => {
    const t = make();
    await t.adapter.oi(q({ exchange: 'MCX', underlying: 'CRUDEOIL', symbol: 'CRUDEOIL16OCT265600CE', expiry: '2026-10-13', option: { underlying: 'CRUDEOIL', strike: 25000, optionType: 'CE' } }));
    expect(t.chainService.getOptionsChainWithSpot).toHaveBeenCalledWith('CRUDEOIL', '2026-10-13');
  });

  it('is unavailable, with the reason, when no chain service is wired, no underlying resolved, or the chain is empty', async () => {
    expect((await make({ chainService: false }).adapter.oi(q())).analysis).toEqual({ available: false, reason: expect.stringMatching(/not wired/) });
    expect((await make().adapter.oi(q({ underlying: null }))).analysis).toEqual({ available: false, reason: expect.stringMatching(/underlying/) });
    const t = make();
    t.chainService.getOptionsChainWithSpot.mockResolvedValue({ chain: [], spotPrice: 0 });
    expect((await t.adapter.oi(q())).analysis).toEqual({ available: false, reason: expect.stringMatching(/empty/) });
  });

  it('never reports volume-derived walls as OI walls when the chain has no OI', async () => {
    const t = make();
    t.chainService.getOptionsChainWithSpot.mockResolvedValue({
      chain: chain.map((e) => ({ ...e, ceData: leg({ oi: 0, oiChange: 0 }), peData: leg({ oi: 0, oiChange: 0 }) })),
      spotPrice: 25050,
    });
    t.chainService.getPCR.mockReturnValue(0);
    t.chainService.getMaxPain.mockReturnValue(0);
    const { analysis } = await t.adapter.oi(q());
    expect(analysis).toEqual(expect.objectContaining({ callWall: null, putWall: null, pcr: null, maxPain: null }));
  });
});

describe('SentinelOvernightEvidenceAdapter.cues — the market context', () => {
  it('takes US, FII/DII, FII OI and GIFT from the market-cues service, asking for exactly those groups', async () => {
    const t = make();
    const c = await t.adapter.cues(q());
    expect(c.market).toBe(cueSnapshot);
    expect(t.marketCues.ensure).toHaveBeenCalledWith(['us', 'fiiDii', 'fiiOi', 'gift'], NOW);
  });

  it('without the market-cues service, every cue is unavailable and says it is not wired — never zero', async () => {
    const c = await make({ cues: false }).adapter.cues(q());
    expect(c.market.enabled).toBe(false);
    expect(c.market.us.nasdaq).toEqual(expect.objectContaining({ values: null, status: 'unavailable', reason: expect.stringMatching(/not wired/) }));
    expect(c.market.fiiDii.values).toBeNull();
  });

  it('a market-cues failure is an unavailable snapshot naming the error', async () => {
    const t = make();
    t.marketCues.ensure.mockRejectedValueOnce(new Error('boom'));
    const c = await t.adapter.cues(q());
    expect(c.market.gift.reason).toMatch(/market-cues.service failed: boom/);
  });

  it('preOpen asks the service for today’s pre-open book', async () => {
    const t = make();
    const rec = await t.adapter.preOpen(ist('2026-10-13', '09:10'));
    expect(t.marketCues.ensure).toHaveBeenCalledWith(['preOpen'], ist('2026-10-13', '09:10'));
    expect(rec.status).toBe('ok');
  });

  it('reads crude and gold off the MCX snapshot, and an unquotable one as unavailable — not zero', async () => {
    const c = await make().adapter.cues(q());
    // MCX is OPEN at 15:45: the quote's own timestamp, never the review time.
    expect(c.crudeOil).toEqual({
      reading: expect.objectContaining({ value: 5600, change: -84, changePercent: -1.5, at: ist('2026-10-12', '15:44').toISOString(), basis: 'quote time' }),
      source: expect.stringMatching(/MCX CRUDEOIL/),
    });
    expect(c.gold).toEqual({ reading: null, reason: expect.stringMatching(/GOLD/) });
  });

  it('reads India VIX with its day-on-day change', async () => {
    const c = await make().adapter.cues(q());
    expect(c.indiaVix).toEqual({ reading: expect.objectContaining({ value: 13.4, change: 0.6 }), source: expect.stringMatching(/market-context/) });
  });

  it('reads the underlying’s change vs its previous close for an index', async () => {
    const t = make();
    const c = await t.adapter.cues(q());
    expect(t.yahoo.getQuoteChange).toHaveBeenCalledWith('NIFTY', 'NSE', '99926000');
    expect(c.underlyingChange).toEqual({ reading: expect.objectContaining({ value: 25050, change: -110, changePercent: -0.44 }), source: expect.stringMatching(/yahoo/) });
  });

  it('reads sector strength for a stock underlying, and says why there is none for an index', async () => {
    const stock = await make().adapter.cues(q({ underlying: 'INFY', symbol: 'INFY27OCT261500CE' }));
    expect(stock.sectorStrength).toEqual(expect.objectContaining({ value: expect.objectContaining({ sector: 'IT', changePercent: -1.2 }) }));
    const index = await make().adapter.cues(q());
    expect(index.sectorStrength).toEqual({ value: null, reason: expect.stringMatching(/index/) });
  });

  it('a missing or failing service degrades one cue to a stated absence, not the whole set', async () => {
    const t = make({ commodities: false });
    t.marketContext.getVixHistory.mockRejectedValue(new Error('yahoo 503'));
    const c = await t.adapter.cues(q());
    expect(c.crudeOil).toEqual({ reading: null, reason: expect.stringMatching(/not wired/) });
    expect(c.indiaVix).toEqual({ reading: null, reason: expect.stringMatching(/yahoo 503/) });
    expect(c.underlyingChange.reading).not.toBeNull();
  });
});

describe('SentinelOvernightEvidenceAdapter — the position’s own expiry, or nothing', () => {
  it('an option whose expiry has no chain gets no OI and no greeks — never another expiry’s', async () => {
    const t = make();
    const r = await t.adapter.oi(q({ expiry: '2026-10-27' }));
    expect(r.analysis).toEqual({ available: false, reason: 'no chain snapshot for 2026-10-27 (NIFTY) — another expiry’s OI and greeks are not this contract’s' });
    expect(r.legGreeks).toBeNull();
    expect(t.chainService.getOptionsChainWithSpot).not.toHaveBeenCalled();
  });

  it('a future reads the nearest option expiry for the underlying, and says so', async () => {
    const t = make();
    const r = await t.adapter.oi(q({ segment: 'FUT', symbol: 'NIFTY27OCT26FUT', expiry: '2026-10-27', option: null }));
    expect(r.analysis).toEqual(expect.objectContaining({ available: true, expiry: '2026-10-13', source: expect.stringMatching(/nearest option expiry.*future expires 2026-10-27/) }));
  });
});

describe('SentinelOvernightEvidenceAdapter — cue ages at 08:50 come from the sources, not the review clock', () => {
  const PRE = ist('2026-10-12', '08:50');
  const FRI_NSE_CLOSE = ist('2026-10-09', '15:30').toISOString();
  const FRI_MCX_CLOSE = ist('2026-10-09', '23:30').toISOString();

  it('VIX, the underlying change and sector strength are dated to the previous NSE close', async () => {
    const t = make();
    const idx = await t.adapter.cues(q({ now: PRE, since: ist('2026-10-09', '15:30') }));
    expect(idx.indiaVix.reading).toEqual(expect.objectContaining({ at: FRI_NSE_CLOSE, basis: 'previous session close' }));
    expect(idx.underlyingChange.reading).toEqual(expect.objectContaining({ at: FRI_NSE_CLOSE, basis: 'previous session close' }));
    const stock = await make().adapter.cues(q({ now: PRE, since: ist('2026-10-09', '15:30'), underlying: 'INFY', symbol: 'INFY27OCT261500CE' }));
    expect(stock.sectorStrength).toEqual(expect.objectContaining({ at: FRI_NSE_CLOSE }));
  });

  it('MCX crude, with MCX closed at 08:50, is dated to MCX’s previous close — not the stale quote stamp, not now', async () => {
    const t = make();
    const c = await t.adapter.cues(q({ now: PRE, since: ist('2026-10-09', '15:30') }));
    expect(c.crudeOil.reading).toEqual(expect.objectContaining({ at: FRI_MCX_CLOSE, basis: 'previous session close' }));
  });
});

describe('SentinelOvernightEvidenceAdapter.news — the symbol scope uses the news tagger’s key', () => {
  it('an MCX mini reads its parent’s headlines: GOLDM is tagged as GOLD', async () => {
    const t = make();
    await t.adapter.news(q({ underlying: 'GOLDM', symbol: 'GOLDM05DEC26FUT', exchange: 'MCX', segment: 'FUT', option: null as never }));
    expect(t.news.getNewsForSymbol).toHaveBeenCalledWith('GOLD');
    expect(t.news.getNewsForSymbol).not.toHaveBeenCalledWith('GOLDM');
  });

  it('CRUDEOILM reads CRUDEOIL headlines', async () => {
    const t = make();
    await t.adapter.news(q({ underlying: 'CRUDEOILM', symbol: 'CRUDEOILM19OCT26FUT', exchange: 'MCX', segment: 'FUT', option: null as never }));
    expect(t.news.getNewsForSymbol).toHaveBeenCalledWith('CRUDEOIL');
  });

  it('an MCX underlying no article can ever be tagged with is not looked up by symbol at all', async () => {
    const t = make();
    const ev = await t.adapter.news(q({ underlying: 'ZINC', symbol: 'ZINC30OCT26FUT', exchange: 'MCX', segment: 'FUT', option: null as never }));
    expect(t.news.getNewsForSymbol).not.toHaveBeenCalled();
    expect(ev.items.some((i) => i.scope === 'symbol')).toBe(false);
  });
});

describe('SentinelOvernightEvidenceAdapter.cues — MCX crude/gold dated by the late-close-aware clock', () => {
  const saved = process.env.HUB_MCX_LATE_CLOSE;
  beforeEach(() => {
    process.env.HUB_MCX_LATE_CLOSE = '2026-11-02:2027-03-08';
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.HUB_MCX_LATE_CLOSE;
    else process.env.HUB_MCX_LATE_CLOSE = saved;
  });

  it('at 23:40 IST in the late-close season MCX is still OPEN: the quote’s own time, not the 23:30 close', async () => {
    const t = make();
    t.commodities.resolver.resolveQuotes.mockResolvedValue(
      new Map([['c1', { token: 'c1', ltp: 5600, change: -84, changePercent: -1.5, timestamp: ist('2026-11-04', '23:39') }]]),
    );
    const c = await t.adapter.cues(q({ now: ist('2026-11-04', '23:40'), since: ist('2026-11-04', '15:30') }));
    expect(c.crudeOil.reading).toEqual(
      expect.objectContaining({ at: ist('2026-11-04', '23:39').toISOString(), basis: 'quote time' }),
    );
  });

  it('after the late close the price is dated by the 23:55 close, not 23:30', async () => {
    const t = make();
    const c = await t.adapter.cues(q({ now: ist('2026-11-05', '00:03'), since: ist('2026-11-04', '15:30') }));
    expect(c.crudeOil.reading).toEqual(
      expect.objectContaining({ at: ist('2026-11-04', '23:55').toISOString(), basis: 'previous session close' }),
    );
  });
});
