import { Logger } from '@nestjs/common';
import {
  DEFAULT_OVERNIGHT_CONCURRENCY,
  OVERNIGHT_FAILURE_LIMIT,
  overnightConcurrency,
  SentinelOvernightService,
  assembleOvernightSection,
  formatOvernightReason,
  type SectionInputs,
} from './sentinel-overnight.service';
import { AFTER_CLOSE_EQUITY, AFTER_CLOSE_MCX, PRE_OPEN, PRE_OPEN_CHECK } from '../overnight/overnight-calendar';
import type { CueRecord, MarketCuesSnapshot, PreOpenBook, UsQuote } from '../../market-cues/market-cues.types';
import { unavailableSnapshot } from '../../market-cues/market-cues.snapshot';
import type { RosterEntry } from './roster.service';
import type { TickReading } from './sentinel-cycle.service';
import type { RawCues, RawOiEvidence } from '../ports/overnight-evidence.port';
import type { NewsEvidence } from '../overnight/overnight-evidence';
import { SharedJobExpired } from './sentinel-cycle.service';
import type { ScorecardProvider } from '../ports/scorecard.port';
import type { Scorecard } from '../../overnight-scorecard/scorecard.types';
import { SCORECARD_BLOCK_MAX_CHARS } from '../overnight/scorecard-block';

const ist = (ymd: string, hhmm: string) => new Date(`${ymd}T${hhmm}:00+05:30`);
const MON_CLOSE = ist('2026-10-12', '15:45');

const entry = (id: string, over: Partial<RosterEntry> = {}): RosterEntry => ({
  userId: 'u1',
  trackerId: id,
  symbol: 'NIFTY13OCT2625000CE',
  exchange: 'NFO',
  kind: 'POSITION',
  ownership: 'SENTINEL',
  watched: true,
  reason: 'unowned position — sentinel claims it',
  ...over,
});

const optTick = (over: Partial<TickReading> = {}): TickReading => ({
  segment: 'OPT',
  side: 'LONG',
  entryPrice: 140,
  qty: 75,
  ltp: 120,
  ltpAt: ist('2026-10-12', '15:29').toISOString(),
  underlyingLtp: 25050,
  underlyingLtpAt: null,
  underlyingLtpSource: 'market-data (underlying spot — broker FULL-mode quote)',
  underlyingLtpReason: null,
  structureSymbol: 'NIFTY',
  nearestSupport: 25000,
  nearestResistance: 25200,
  structureReason: null,
  structureAt: null,
  structureSource: 'signal-generator.analyze (15m level book)',
  holdingHigh: 150,
  holdingLow: 112,
  entryTime: new Date('2026-10-12T04:00:00.000Z'),
  expiry: '2026-10-13',
  volumeRatio: null,
  freshNewsCount: null,
  factorValues: {},
  factorsReason: null,
  ...over,
});

const freshNews: NewsEvidence = {
  lastFetchAt: ist('2026-10-12', '15:40').toISOString(),
  items: [
    {
      title: 'Nifty slips as US futures fall',
      source: 'LiveMint',
      publishedAt: ist('2026-10-12', '15:38').toISOString(),
      sentiment: 'bearish',
      url: 'https://x/1',
      scope: 'index',
    },
  ],
};

const oiPresent: RawOiEvidence = {
  analysis: {
    available: true,
    source: 'options-chain.service',
    at: MON_CLOSE.toISOString(),
    expiry: '2026-10-13',
    spot: 25050,
    pcr: 0.82,
    maxPain: 25000,
    callWall: 25200,
    putWall: 24800,
    totalCeOi: 1_000_000,
    totalPeOi: 820_000,
    totalOiChange: 90_000,
    underlyingPriceChange: { value: -110, source: 'yahoo' },
    prevSession: null,
    contract: { strike: 25000, optionType: 'CE', ltp: 120, oi: 50_000, oiChange: 8_000, prev: null },
  },
  legGreeks: { delta: 0.52, gamma: 0.001, theta: -24, vega: 9.1, iv: 13.2, source: 'options-chain.service greeks', at: MON_CLOSE.toISOString() },
};

const rec = <T>(values: T, over: Partial<CueRecord<T>> = {}): CueRecord<T> => ({
  values,
  sourceTime: '2026-10-09T21:15:59.000Z',
  fetchedAt: '2026-10-12T02:55:00.000Z',
  basis: 'previous US session close',
  source: 'Yahoo Finance v8 chart',
  status: 'ok',
  ...over,
});
const usq = (last: number, change: number): UsQuote => ({ symbol: 'X', last, previousClose: last - change, change, changePercent: Math.round((change / (last - change)) * 10000) / 100 });

/** A market-cues snapshot as the service would hand it over on Monday evening. */
const market: MarketCuesSnapshot = {
  enabled: true,
  us: {
    nasdaq: rec(usq(27366.17, 172.83)),
    sp500: rec(usq(7811.54, 46.18)),
    dow: rec(usq(51654.95, 423.31)),
    nasdaqFutures: rec(usq(31108.75, -139.25), { sourceTime: ist('2026-10-12', '15:40').toISOString(), basis: 'quote time' }),
    sp500Futures: rec(usq(7866, -10), { sourceTime: ist('2026-10-12', '15:40').toISOString(), basis: 'quote time' }),
  },
  commodities: unavailableSnapshot('n/a').commodities,
  fiiDii: rec(
    { date: '2026-10-09', fii: { buy: 10373.99, sell: 13942.89, net: -3568.9 }, dii: { buy: 15626.53, sell: 10883.27, net: 4743.26 }, unit: '₹ crore' as const },
    { sourceTime: '2026-10-09', basis: 'session date', source: 'NSE fiidiiTradeReact' },
  ),
  fiiOi: rec(
    {
      date: '2026-10-09',
      indexFutures: { long: 34943, short: 328931 },
      indexCalls: { long: 600034, short: 946852 },
      indexPuts: { long: 1245164, short: 704672 },
      unit: 'contracts' as const,
      change: null,
    },
    { sourceTime: '2026-10-09', source: 'NSE participant OI' },
  ),
  gift: rec(
    {
      gift: { price: 22575.5, expiry: '2026-10-27', at: ist('2026-10-12', '23:30').toISOString(), dayChange: -27 },
      niftyFuture: { close: 22612.6, expiry: '2026-10-27', sessionDate: '2026-10-12', closedAt: null },
      gap: -37.1,
      gapPercent: -0.16,
      expiryMatches: true,
      comparison: 'futures-vs-futures gap: GIFT Nifty near-month future minus the NSE NIFTY current-month future close',
    },
    { sourceTime: ist('2026-10-12', '23:30').toISOString(), source: 'NSE IX market-rate' },
  ),
  preOpen: unavailableSnapshot('n/a').preOpen,
};

const cuesPresent: RawCues = {
  market,
  crudeOil: { reading: { value: 5600, change: -84, changePercent: -1.5, at: MON_CLOSE.toISOString(), basis: 'quote time' }, source: 'market-quote-resolver' },
  gold: { reading: { value: 121000, change: 300, changePercent: 0.25, at: MON_CLOSE.toISOString(), basis: 'quote time' }, source: 'market-quote-resolver' },
  indiaVix: { reading: { value: 13.4, change: 0.6, changePercent: 4.7, at: ist('2026-10-12', '15:30').toISOString(), basis: 'previous session close' }, source: 'market-context.service' },
  underlyingChange: { reading: { value: 25050, change: -110, changePercent: -0.44, at: ist('2026-10-12', '15:30').toISOString(), basis: 'previous session close' }, source: 'yahoo-finance.service' },
  sectorStrength: { value: null, reason: 'the underlying is an index — no single sector' },
};

const inputs = (over: Partial<SectionInputs> = {}): SectionInputs => ({
  entry: entry('t1'),
  tick: optTick(),
  window: AFTER_CLOSE_EQUITY,
  tag: 'window:OVERNIGHT_REVIEW:EQUITY:2026-10-12',
  now: MON_CLOSE,
  news: { ok: true, value: freshNews },
  oi: { ok: true, value: oiPresent },
  cues: { ok: true, value: cuesPresent },
  ...over,
});

describe('assembleOvernightSection — packet contents', () => {
  it('carries days to expiry and one night of decay for an option', () => {
    const s = assembleOvernightSection(inputs());
    expect(s.expiry).toEqual(
      expect.objectContaining({ available: true, value: { expiry: '2026-10-13', calendarDays: 1, tradingSessionsLeft: 1 } }),
    );
    expect(s.decay.available).toBe(true);
    if (s.decay.available) {
      expect(s.decay.value.thetaPerUnitPerDay).toBe(-24);
      expect(s.decay.value.rupeesForPosition).toBeLessThan(0);
    }
    expect(s.greeks).toEqual(expect.objectContaining({ available: true, value: { delta: 0.52, gamma: 0.001, theta: -24, vega: 9.1, iv: 13.2 } }));
    expect(s.review).toEqual(
      expect.objectContaining({
        kind: 'OVERNIGHT_REVIEW',
        lastCloseAt: ist('2026-10-12', '15:30').toISOString(),
        nextOpenAt: ist('2026-10-13', '09:15').toISOString(),
        hoursUntilOpen: 17.5,
        lastPriceAt: ist('2026-10-12', '15:29').toISOString(),
        lastPriceAtBasis: expect.stringMatching(/as of tracker update/),
      }),
    );
  });

  it('states the honest absence of a pre-open price at 08:50 — never yesterday’s close', () => {
    const s = assembleOvernightSection(
      inputs({ window: PRE_OPEN, now: ist('2026-10-13', '08:50'), tag: 'window:PRE_OPEN_REVIEW:ALL:2026-10-13' }),
    );
    expect(s.preOpenPrice.available).toBe(false);
    if (!s.preOpenPrice.available) expect(s.preOpenPrice.reason).toMatch(/no pre-open or indicative price exists yet/);
  });

  it('after the close, the pre-open block says the next pre-open has not happened', () => {
    const s = assembleOvernightSection(inputs());
    expect(s.preOpenPrice.available).toBe(false);
    if (!s.preOpenPrice.available) expect(s.preOpenPrice.reason).toMatch(/after-close review/);
  });

  it('a future carries no decay and no option greeks, each with a reason', () => {
    const s = assembleOvernightSection(
      inputs({
        entry: entry('f1', { symbol: 'BANKNIFTY27OCT26FUT' }),
        tick: optTick({ segment: 'FUT', expiry: '2026-10-27' }),
        oi: { ok: true, value: { ...oiPresent, legGreeks: null } },
      }),
    );
    expect(s.decay).toEqual({ available: false, reason: expect.stringMatching(/future/) });
    expect(s.greeks).toEqual({ available: false, reason: expect.stringMatching(/future/) });
  });

  describe('each source present, stale and unavailable', () => {
    it('news: present', () => {
      const s = assembleOvernightSection(inputs());
      expect(s.news.available && (s.news.value as { stale: boolean }).stale).toBe(false);
    });
    it('news: stale store is flagged', () => {
      const s = assembleOvernightSection(
        inputs({ news: { ok: true, value: { ...freshNews, lastFetchAt: ist('2026-10-12', '09:00').toISOString() } } }),
      );
      expect(s.news.available && (s.news.value as { stale: boolean }).stale).toBe(true);
    });
    it('news: a failing source is a stated absence naming it', () => {
      const s = assembleOvernightSection(inputs({ news: { ok: false, error: 'db down' } }));
      expect(s.news).toEqual({ available: false, reason: expect.stringMatching(/news-aggregator.*db down/) });
    });

    it('OI: present', () => {
      const s = assembleOvernightSection(inputs());
      expect(s.oi.available).toBe(true);
    });
    it('OI: unavailable for the exchange, with the reason', () => {
      const s = assembleOvernightSection(
        inputs({ oi: { ok: true, value: { analysis: { available: false, reason: 'no options chain for MCX GOLD' }, legGreeks: null } } }),
      );
      expect(s.oi).toEqual({ available: false, reason: 'no options chain for MCX GOLD' });
      // No chain theta, so decay falls back to the labelled estimate rather than vanishing.
      expect(s.decay.available && s.decay.value.method).toMatch(/ESTIMATE/);
      expect(s.greeks.available).toBe(false);
    });
    it('OI: a failing source is a stated absence naming it', () => {
      const s = assembleOvernightSection(inputs({ oi: { ok: false, error: 'chain timeout' } }));
      expect(s.oi).toEqual({ available: false, reason: expect.stringMatching(/options-chain.*chain timeout/) });
    });

    it('cues: present ones carry value, direction and freshness; missing ones say why', () => {
      const s = assembleOvernightSection(inputs());
      expect(s.marketCues.crudeOil).toEqual(
        expect.objectContaining({ available: true, value: expect.objectContaining({ value: 5600, direction: 'DOWN', ageMinutes: 0 }) }),
      );
      expect(s.marketCues.nasdaq).toEqual(
        expect.objectContaining({ available: true, at: '2026-10-09T21:15:59.000Z', value: expect.objectContaining({ value: 27366.17, basis: 'previous session close', status: 'ok' }) }),
      );
      expect(s.marketCues.sectorStrength).toEqual({ available: false, reason: expect.stringMatching(/index/) });
    });
    it('cues: a stale cue reports its age', () => {
      const s = assembleOvernightSection(
        inputs({
          cues: {
            ok: true,
            value: { ...cuesPresent, gold: { reading: { value: 1, change: 0, changePercent: 0, at: ist('2026-10-12', '11:45').toISOString(), basis: 'quote time' }, source: 'x' } },
          },
        }),
      );
      expect(s.marketCues.gold.available && s.marketCues.gold.value.ageMinutes).toBe(240);
    });
    it('cues: a failing source makes every cue a stated absence, never a zero', () => {
      const s = assembleOvernightSection(inputs({ cues: { ok: false, error: 'yahoo 503' } }));
      for (const cue of Object.values(s.marketCues)) {
        expect(cue).toEqual({ available: false, reason: expect.stringMatching(/yahoo 503/) });
      }
    });
  });
});

describe('assembleOvernightSection — market cues per window', () => {
  const TUE = '2026-10-13';
  it('15:45: previous US close and US futures; FII shown as the previous session’s, today’s not yet published; no GIFT', () => {
    const s = assembleOvernightSection(inputs());
    for (const k of ['nasdaq', 'sp500', 'dow', 'nasdaqFutures', 'sp500Futures'] as const) {
      expect({ k, available: s.marketCues[k].available }).toEqual({ k, available: true });
    }
    expect(s.marketCues.nasdaqFutures.available && s.marketCues.nasdaqFutures.value.basis).toBe('quote time');
    expect(s.marketCues.fiiFlows).toEqual(
      expect.objectContaining({
        available: true,
        at: '2026-10-09',
        value: expect.objectContaining({ session: '2026-10-09', todaysFigure: 'not yet published (NSE publishes ~18:00–20:00 IST)' }),
      }),
    );
    expect(s.marketCues.fiiDerivatives.available && (s.marketCues.fiiDerivatives.value as { todaysFile: string }).todaysFile).toMatch(/not yet published/);
    expect(s.marketCues.giftNifty).toEqual({ available: false, reason: expect.stringMatching(/23:45 and 08:30/) });
  });

  it('23:45 (MCX): US, FII/DII, FII OI and the GIFT futures-vs-futures gap', () => {
    const s = assembleOvernightSection(
      inputs({
        window: AFTER_CLOSE_MCX,
        now: ist('2026-10-12', '23:45'),
        tag: 'window:OVERNIGHT_REVIEW:MCX:2026-10-12',
        entry: entry('m', { exchange: 'MCX', symbol: 'CRUDEOIL16OCT265600CE' }),
      }),
    );
    expect(s.marketCues.giftNifty).toEqual(
      expect.objectContaining({
        available: true,
        value: expect.objectContaining({
          gap: -37.1,
          niftyFutureClose: 22612.6,
          comparison: expect.stringMatching(/futures-vs-futures/),
          giftAgeMinutes: 15,
        }),
      }),
    );
    expect(s.marketCues.fiiFlows.available && (s.marketCues.fiiFlows.value as Record<string, unknown>).todaysFigure).toBeUndefined();
    expect(s.marketCues.fiiDerivatives.available).toBe(true);
    expect(s.marketCues.sp500.available).toBe(true);
  });

  it('08:30: every cue group is read', () => {
    const s = assembleOvernightSection(inputs({ window: PRE_OPEN, now: ist(TUE, '08:30'), tag: 'window:PRE_OPEN_REVIEW:ALL:' + TUE }));
    for (const k of ['nasdaq', 'nasdaqFutures', 'giftNifty', 'fiiFlows', 'fiiDerivatives'] as const) {
      expect({ k, available: s.marketCues[k].available }).toEqual({ k, available: true });
    }
    expect(s.preOpenGap).toEqual({ available: false, reason: expect.stringMatching(/only the 09:10 pre-open check/) });
  });

  it('an unavailable cue is a stated absence — never a zero', () => {
    const off = unavailableSnapshot('market cues are switched off (MARKET_CUES_ENABLED is not true)');
    const s = assembleOvernightSection(inputs({ cues: { ok: true, value: { ...cuesPresent, market: off } } }));
    for (const k of ['nasdaq', 'sp500', 'dow', 'nasdaqFutures', 'sp500Futures', 'fiiFlows', 'fiiDerivatives'] as const) {
      expect(s.marketCues[k]).toEqual({ available: false, reason: expect.stringMatching(/MARKET_CUES_ENABLED/) });
    }
  });

  it('an intraday US index value is NOT labelled a session close', () => {
    const intraday = { ...market.us.nasdaq, values: { ...market.us.nasdaq.values!, phase: 'intraday' as const }, sourceTime: ist('2026-10-12', '23:40').toISOString() };
    const s = assembleOvernightSection(
      inputs({
        window: AFTER_CLOSE_MCX,
        now: ist('2026-10-12', '23:45'),
        tag: 'window:OVERNIGHT_REVIEW:MCX:2026-10-12',
        cues: { ok: true, value: { ...cuesPresent, market: { ...market, us: { ...market.us, nasdaq: intraday } } } },
      }),
    );
    expect(s.marketCues.nasdaq.available && s.marketCues.nasdaq.value).toEqual(
      expect.objectContaining({ basis: 'quote time', session: 'intraday', ageMinutes: 5 }),
    );
    const close = assembleOvernightSection(inputs());
    expect(close.marketCues.nasdaq.available && close.marketCues.nasdaq.value).toEqual(
      expect.objectContaining({ basis: 'previous session close', session: 'close' }),
    );
  });

  it('a stale cue is shown, marked stale with the reason', () => {
    const staleUs = { ...market.us, nasdaq: { ...market.us.nasdaq, status: 'stale' as const, reason: 'the close is from the 2026-10-09 US session' } };
    const s = assembleOvernightSection(inputs({ cues: { ok: true, value: { ...cuesPresent, market: { ...market, us: staleUs } } } }));
    expect(s.marketCues.nasdaq.available && s.marketCues.nasdaq.value).toEqual(
      expect.objectContaining({ status: 'stale', note: expect.stringMatching(/2026-10-09/) }),
    );
  });
});

describe('formatOvernightReason', () => {
  it('collapses a multi-line plan or risk onto its own labelled line, so nothing is truncated on read-back', () => {
    expect(
      formatOvernightReason('theta bleeds\n  and expiry is tomorrow', 'if it gaps below 24950, exit;\nif it opens above 25150, hold;\r\nstop at 25020'),
    ).toBe(
      'OVERNIGHT RISK: theta bleeds and expiry is tomorrow\nOPEN PLAN: if it gaps below 24950, exit; if it opens above 25150, hold; stop at 25020',
    );
  });

  it('stores the risk and the open plan as two labelled lines', () => {
    expect(formatOvernightReason('theta bleeds 1312', 'exit below 24950')).toBe(
      'OVERNIGHT RISK: theta bleeds 1312\nOPEN PLAN: exit below 24950',
    );
  });
});

// ─── The window runner ───────────────────────────────────────────────────────

const VERDICT = {
  verdict: 'TIGHTEN_AT_OPEN',
  confidence: 'medium',
  thesisStatus: 'WEAKENING',
  overnightRisk: 'one session to expiry and theta against a long call',
  changeMindLevel: 'an open above 25150',
  openPlan: 'if it gaps below 24950, exit; if it opens above 25150, hold with a stop at 25020',
  evidence: ['overnight.decay'],
};

function makeSvc(
  opts: {
    enabled?: boolean;
    done?: Set<string>;
    lateClose?: string;
    book?: RosterEntry[];
    preOpen?: CueRecord<PreOpenBook>;
    /** SENTINEL_SCORECARD's raw value; undefined = unset. */
    scorecardFlag?: string;
    /** The 11th constructor argument; undefined = not passed (the @Optional default). */
    scorecards?: ScorecardProvider;
    /** SENTINEL_OVERNIGHT_CONCURRENCY's raw value; undefined = unset. */
    concurrency?: string;
  } = {},
) {
  const book: RosterEntry[] = opts.book ?? [
    entry('nfo'),
    entry('mcx', { exchange: 'MCX', symbol: 'CRUDEOIL16OCT265600CE' }),
    entry('cash', { exchange: 'NSE', symbol: 'RELIANCE-EQ' }),
  ];
  const done = opts.done ?? new Set<string>();
  const build = jest.fn().mockResolvedValue(book);
  const buildPacket = jest.fn().mockImplementation(async (e: RosterEntry) => ({
    position: { symbol: e.symbol },
    money: { netPnl: -1590, greenFloorPrice: 142.4 },
    flow: { volumeRatio: { available: false, reason: 'x' }, oiWalls: { available: false, reason: 'no options chain for this symbol, so no OI walls' } },
  }));
  const find = jest.fn().mockResolvedValue(null);
  const judgeOvernight = jest.fn().mockResolvedValue(VERDICT);
  const record = jest.fn().mockImplementation(async (row: { trackerId: string; triggeredBy: string[] }) => {
    done.add(`${row.trackerId}|${row.triggeredBy[1]}`);
    return {};
  });
  const hasWindowVerdict = jest.fn().mockImplementation(async (id: string, tag: string) => done.has(`${id}|${tag}`));
  const recentForTracker = jest.fn().mockResolvedValue([]);
  // Honours `expired` the way the real cycle does.
  const runShared = jest.fn().mockImplementation(async (_id: string, work: () => Promise<unknown>, o?: { expired?: () => boolean }) => {
    if (o?.expired?.()) throw new SharedJobExpired();
    return work();
  });
  const tickFor = jest.fn().mockResolvedValue(optTick());
  const evidence = {
    news: jest.fn().mockResolvedValue(freshNews),
    oi: jest.fn().mockResolvedValue(oiPresent),
    cues: jest.fn().mockResolvedValue(cuesPresent),
    preOpen: jest.fn().mockResolvedValue(opts.preOpen ?? unavailableSnapshot('not fetched').preOpen),
  };
  const findMany = jest.fn().mockResolvedValue([
    { userId: 'u1', exchange: 'NFO' },
    { userId: 'u1', exchange: 'MCX' },
  ]);
  const config = {
    get: jest.fn().mockImplementation((key: string) =>
      key === 'hub.mcxLateClose'
        ? (opts.lateClose ?? '')
        : key === 'SENTINEL_SCORECARD'
          ? opts.scorecardFlag
          : key === 'SENTINEL_OVERNIGHT_CONCURRENCY'
            ? opts.concurrency
            : opts.enabled === false
            ? 'false'
            : 'true',
    ),
  };

  const svc = new SentinelOvernightService(
    { build } as never,
    { build: buildPacket } as never,
    { find } as never,
    { judgeOvernight, overnightPromptVersion: 'o1/t1' } as never,
    { record, hasWindowVerdict, recentForTracker } as never,
    { runShared } as never,
    { tickFor } as never,
    evidence as never,
    { tradeTracker: { findMany } } as never,
    config as never,
    opts.scorecards,
  );
  return { svc, build, buildPacket, judgeOvernight, record, hasWindowVerdict, runShared, tickFor, evidence, findMany, done };
}

describe('SentinelOvernightService.runWindow', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('does nothing at all when SENTINEL_SHADOW_ENABLED is off', async () => {
    const t = makeSvc({ enabled: false });
    const report = await t.svc.runWindow(AFTER_CLOSE_EQUITY, MON_CLOSE);
    expect(report).toEqual(expect.objectContaining({ disabled: true, judged: 0 }));
    expect(t.findMany).not.toHaveBeenCalled();
    expect(t.judgeOvernight).not.toHaveBeenCalled();
  });

  it('the 15:45 window judges the NFO position only; the 23:45 window the MCX one only', async () => {
    const t = makeSvc();
    await t.svc.runWindow(AFTER_CLOSE_EQUITY, MON_CLOSE);
    expect(t.record.mock.calls.map((c) => c[0].trackerId)).toEqual(['nfo']);
    await t.svc.runWindow(AFTER_CLOSE_MCX, ist('2026-10-12', '23:45'));
    expect(t.record.mock.calls.map((c) => c[0].trackerId)).toEqual(['nfo', 'mcx']);
  });

  it('the pre-open window judges every F&O position, never the cash one', async () => {
    const t = makeSvc();
    await t.svc.runWindow(PRE_OPEN, ist('2026-10-13', '08:50'));
    expect(t.record.mock.calls.map((c) => c[0].trackerId).sort()).toEqual(['mcx', 'nfo']);
  });

  it('skips weekends and exchange holidays without asking anyone anything', async () => {
    const t = makeSvc();
    await t.svc.runWindow(AFTER_CLOSE_EQUITY, ist('2026-10-10', '15:45'));
    await t.svc.runWindow(PRE_OPEN, ist('2026-10-20', '08:50'));
    expect(t.findMany).not.toHaveBeenCalled();
    expect(t.judgeOvernight).not.toHaveBeenCalled();
  });

  it('records the verdict in sentinel_verdicts with the window kind and tag, the plan and the overnight prompt version', async () => {
    const t = makeSvc();
    await t.svc.runWindow(AFTER_CLOSE_EQUITY, MON_CLOSE);
    expect(t.record).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        trackerId: 'nfo',
        verdict: 'TIGHTEN_AT_OPEN',
        confidence: 'medium',
        thesisStatus: 'WEAKENING',
        reason: formatOvernightReason(VERDICT.overnightRisk, VERDICT.openPlan),
        invalidationPoint: VERDICT.changeMindLevel,
        evidence: ['overnight.decay'],
        promptVersion: 'o1/t1',
        triggeredBy: ['OVERNIGHT_REVIEW', 'window:OVERNIGHT_REVIEW:EQUITY:2026-10-12'],
        netPnl: -1590,
        greenFloor: 142.4,
        // Until the next open, 09:15 Tuesday: 17.5 h.
        reviewInSec: 17.5 * 3600,
      }),
    );
  });

  it('reads the closed session, and builds the packet with the overnight section and an honest trigger', async () => {
    const t = makeSvc();
    await t.svc.runWindow(AFTER_CLOSE_EQUITY, MON_CLOSE);
    expect(t.tickFor).toHaveBeenCalledWith('nfo', { closedSession: true });
    expect(t.buildPacket.mock.calls[0][3]).toEqual([
      { name: 'OVERNIGHT_REVIEW', detail: expect.stringMatching(/after-close/) },
    ]);
    const packet = t.judgeOvernight.mock.calls[0][0];
    expect(packet.overnight.review.window).toBe('window:OVERNIGHT_REVIEW:EQUITY:2026-10-12');
    // The live walls were not captured for this review; the packet must not claim "no chain".
    expect(packet.flow.oiWalls.reason).toMatch(/overnight\.oi/);
  });

  it('judges each position once per window: a second fire the same day judges nothing', async () => {
    const t = makeSvc();
    await t.svc.runWindow(AFTER_CLOSE_EQUITY, MON_CLOSE);
    const again = await t.svc.runWindow(AFTER_CLOSE_EQUITY, ist('2026-10-12', '15:50'));
    expect(t.judgeOvernight).toHaveBeenCalledTimes(1);
    expect(again).toEqual(expect.objectContaining({ judged: 0, alreadyDone: 1 }));
  });

  it('two fires overlapping in one process judge each position once', async () => {
    const t = makeSvc();
    await Promise.all([
      t.svc.runWindow(AFTER_CLOSE_EQUITY, MON_CLOSE),
      t.svc.runWindow(AFTER_CLOSE_EQUITY, ist('2026-10-12', '15:50')),
    ]);
    expect(t.judgeOvernight).toHaveBeenCalledTimes(1);
  });

  it('a restarted process finds the stored row and does not judge again', async () => {
    const done = new Set<string>();
    const first = makeSvc({ done });
    await first.svc.runWindow(AFTER_CLOSE_EQUITY, MON_CLOSE);
    const restarted = makeSvc({ done });
    await restarted.svc.runWindow(AFTER_CLOSE_EQUITY, ist('2026-10-12', '15:55'));
    expect(restarted.judgeOvernight).not.toHaveBeenCalled();
  });

  it('a new day is a new window', async () => {
    const t = makeSvc();
    await t.svc.runWindow(AFTER_CLOSE_EQUITY, MON_CLOSE);
    await t.svc.runWindow(AFTER_CLOSE_EQUITY, ist('2026-10-13', '15:45'));
    expect(t.judgeOvernight).toHaveBeenCalledTimes(2);
  });

  it('every judgement goes through the cycle’s shared cap, keyed by position', async () => {
    const t = makeSvc();
    await t.svc.runWindow(PRE_OPEN, ist('2026-10-13', '08:50'));
    expect(t.runShared.mock.calls.map((c) => c[0]).sort()).toEqual(['mcx', 'nfo']);
  });

  it('a failed judgement writes nothing, backs off from the failure, and is retried by a later fire', async () => {
    const t = makeSvc();
    t.judgeOvernight.mockRejectedValueOnce(new Error('claude CLI timed out'));
    const first = await t.svc.runWindow(AFTER_CLOSE_EQUITY, MON_CLOSE);
    expect(first).toEqual(expect.objectContaining({ failed: 1, judged: 0 }));
    expect(t.record).not.toHaveBeenCalled();
    // Ten seconds later: still inside the backoff opened at the failure.
    await t.svc.runWindow(AFTER_CLOSE_EQUITY, new Date(MON_CLOSE.getTime() + 10_000));
    expect(t.judgeOvernight).toHaveBeenCalledTimes(1);
    // The next scheduled fire: retried, recorded once.
    await t.svc.runWindow(AFTER_CLOSE_EQUITY, ist('2026-10-12', '15:50'));
    expect(t.judgeOvernight).toHaveBeenCalledTimes(2);
    expect(t.record).toHaveBeenCalledTimes(1);
  });

  it('gives up on a position for the window after repeated failures — bounded cost', async () => {
    const t = makeSvc();
    t.judgeOvernight.mockRejectedValue(new Error('down'));
    for (let i = 0; i < OVERNIGHT_FAILURE_LIMIT + 2; i++) {
      await t.svc.runWindow(AFTER_CLOSE_EQUITY, new Date(MON_CLOSE.getTime() + i * 30 * 60_000));
    }
    expect(t.judgeOvernight).toHaveBeenCalledTimes(OVERNIGHT_FAILURE_LIMIT);
  });

  it('one position failing does not stop the others in the window', async () => {
    const t = makeSvc();
    t.judgeOvernight.mockRejectedValueOnce(new Error('bad reply'));
    await t.svc.runWindow(PRE_OPEN, ist('2026-10-13', '08:50'));
    expect(t.record).toHaveBeenCalledTimes(1);
  });
});

describe('overnightConcurrency (SENTINEL_OVERNIGHT_CONCURRENCY)', () => {
  it('defaults to 3 when unset or not a number, and clamps to 1..4', () => {
    expect(overnightConcurrency(undefined)).toBe(DEFAULT_OVERNIGHT_CONCURRENCY);
    expect(DEFAULT_OVERNIGHT_CONCURRENCY).toBe(3);
    expect(overnightConcurrency('')).toBe(3);
    expect(overnightConcurrency('lots')).toBe(3);
    expect(overnightConcurrency('0')).toBe(1);
    expect(overnightConcurrency('-2')).toBe(1);
    expect(overnightConcurrency('2')).toBe(2);
    expect(overnightConcurrency(' 4 ')).toBe(4);
    expect(overnightConcurrency('9')).toBe(4);
    expect(overnightConcurrency('2.7')).toBe(2);
  });
});

describe('SentinelOvernightService — bounded concurrency within a window', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  const PRE = ist('2026-10-13', '08:50');
  const six = () => ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'].map((id) => entry(id));

  /** A judge that takes a few ms and records the most calls ever in flight at once. */
  function slowJudge(t: ReturnType<typeof makeSvc>, failFor: string[] = []) {
    const seen = { inFlight: 0, max: 0, order: [] as string[] };
    t.judgeOvernight.mockImplementation(async (packet: { position: { symbol: string } }) => {
      seen.inFlight += 1;
      seen.max = Math.max(seen.max, seen.inFlight);
      await new Promise((r) => setTimeout(r, 5));
      seen.inFlight -= 1;
      seen.order.push(packet.position.symbol);
      if (failFor.includes(packet.position.symbol)) throw new Error('claude CLI: timed out');
      return VERDICT;
    });
    return seen;
  }

  it.each([
    [undefined, 3],
    ['1', 1],
    ['2', 2],
    ['9', 4],
  ])('SENTINEL_OVERNIGHT_CONCURRENCY=%s runs up to %i judgements at once, and judges every position', async (raw, cap) => {
    const t = makeSvc({ book: six(), concurrency: raw });
    const seen = slowJudge(t);
    const report = await t.svc.runWindow(PRE_OPEN, PRE);
    expect(seen.max).toBe(cap);
    expect(report).toEqual(expect.objectContaining({ picked: 6, judged: 6, failed: 0, alreadyDone: 0 }));
    expect(t.record).toHaveBeenCalledTimes(6);
  });

  it('one failure does not stop the rest; picked / judged / failed / alreadyDone / deferred and the tag stay exact', async () => {
    const book = six().map((e) => ({ ...e, symbol: e.trackerId }));
    const done = new Set<string>(['p4|window:PRE_OPEN_REVIEW:ALL:2026-10-13']);
    const t = makeSvc({ book, done });
    const seen = slowJudge(t, ['p2']);
    const first = await t.svc.runWindow(PRE_OPEN, PRE);
    expect(first).toEqual({
      window: 'window:PRE_OPEN_REVIEW:ALL:2026-10-13',
      picked: 6,
      judged: 4,
      alreadyDone: 1,
      failed: 1,
      deferred: 0,
      droppedAtOpen: 0,
      skippedNoInput: 0,
    });
    expect(seen.max).toBe(3);
    expect(t.record.mock.calls.map((c) => c[0].trackerId).sort()).toEqual(['p1', 'p3', 'p5', 'p6']);
    expect(t.record.mock.calls.every((c) => c[0].triggeredBy[1] === first.window)).toBe(true);

    // Ten seconds later: the failed one is in backoff, the rest are claimed.
    const again = await t.svc.runWindow(PRE_OPEN, new Date(PRE.getTime() + 10_000));
    expect(again).toEqual(expect.objectContaining({ picked: 6, judged: 0, alreadyDone: 5, deferred: 1, failed: 0 }));
    expect(t.judgeOvernight).toHaveBeenCalledTimes(5);
  });

  it('jobs still waiting for a pool slot at the open are dropped and counted, never judged', async () => {
    const t = makeSvc({ book: six(), concurrency: '1' });
    t.svc.clockNow = () => ist('2026-10-13', '09:01');
    const report = await t.svc.runWindow(PRE_OPEN, ist('2026-10-13', '08:56'));
    expect(report).toEqual(expect.objectContaining({ picked: 6, droppedAtOpen: 6, judged: 0, failed: 0 }));
    expect(t.judgeOvernight).not.toHaveBeenCalled();
  });

  it('a job that waited in the pool has the wait counted by its open check', async () => {
    // 08:56:00 start, MCX opens 09:00 and a job needs CLI_TIMEOUT_MS (3 min) before
    // it: the last start is 08:57:00. With one slot and a 40 s judge, the later
    // jobs reach their turn past 08:57 and are dropped rather than started.
    jest.useFakeTimers({ now: ist('2026-10-13', '08:56') });
    try {
      const book = ['m1', 'm2', 'm3'].map((id) => entry(id, { exchange: 'MCX', symbol: 'CRUDEOIL16OCT265600CE' }));
      const t = makeSvc({ book, concurrency: '1' });
      t.judgeOvernight.mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 40_000));
        return VERDICT;
      });
      const run = t.svc.runWindow(PRE_OPEN, ist('2026-10-13', '08:56'));
      await jest.advanceTimersByTimeAsync(200_000);
      const report = await run;
      expect(report).toEqual(expect.objectContaining({ picked: 3, judged: 2, droppedAtOpen: 1 }));
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('SentinelOvernightService — venue clock gates (late close, open)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('normal season: the 23:45 MCX fire reviews', async () => {
    const t = makeSvc({ lateClose: '2026-11-02:2027-03-08' });
    await t.svc.runWindow(AFTER_CLOSE_MCX, ist('2026-10-12', '23:45'));
    expect(t.record.mock.calls.map((c) => c[0].trackerId)).toEqual(['mcx']);
  });

  it('late season (HUB_MCX_LATE_CLOSE): 23:45 reviews nothing; 23:58 reviews; 00:03 finds it done', async () => {
    const t = makeSvc({ lateClose: '2026-11-02:2027-03-08' });
    await t.svc.runWindow(AFTER_CLOSE_MCX, ist('2026-11-04', '23:45'));
    expect(t.judgeOvernight).not.toHaveBeenCalled();
    await t.svc.runWindow(AFTER_CLOSE_MCX, ist('2026-11-04', '23:58'));
    expect(t.record.mock.calls.map((c) => c[0].triggeredBy[1])).toEqual(['window:OVERNIGHT_REVIEW:MCX:2026-11-04']);
    const after = await t.svc.runWindow(AFTER_CLOSE_MCX, ist('2026-11-05', '00:03'));
    expect(after).toEqual(expect.objectContaining({ judged: 0, alreadyDone: 1 }));
    expect(t.judgeOvernight).toHaveBeenCalledTimes(1);
  });

  it('a pre-open job still queued when its venue opens is dropped, recorded as skipped, and never judged', async () => {
    const t = makeSvc();
    // The window starts at 08:56; by the time the jobs get a slot it is 09:01.
    t.svc.clockNow = () => ist('2026-10-13', '09:01');
    const report = await t.svc.runWindow(PRE_OPEN, ist('2026-10-13', '08:56'));
    expect(report).toEqual(expect.objectContaining({ droppedAtOpen: 2, judged: 0, failed: 0 }));
    expect(t.judgeOvernight).not.toHaveBeenCalled();
    expect(t.record).not.toHaveBeenCalled();
  });
});

describe('SentinelOvernightService — no judge job starts within CLI_TIMEOUT_MS of the venue open', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());
  const at = (hhmmss: string) => new Date(`2026-10-13T${hhmmss}+05:30`);

  it('the 08:30 review: a job reaching its slot at 08:57:01 (MCX opens 09:00) is dropped, not started', async () => {
    const t = makeSvc();
    t.svc.clockNow = () => at('08:57:01');
    const report = await t.svc.runWindow(PRE_OPEN, at('08:40:00'));
    expect(report).toEqual(expect.objectContaining({ droppedAtOpen: 2, judged: 0 }));
    expect(t.judgeOvernight).not.toHaveBeenCalled();
  });

  it('the 08:30 review: at 08:56:59 there is still a full timeout before 09:00, so it starts', async () => {
    const t = makeSvc();
    t.svc.clockNow = () => at('08:56:59');
    const report = await t.svc.runWindow(PRE_OPEN, at('08:40:00'));
    expect(report).toEqual(expect.objectContaining({ judged: 2, droppedAtOpen: 0 }));
  });

  describe('the 09:10 check (open 09:15, so the last start is 09:12:00)', () => {
    const book: CueRecord<PreOpenBook> = {
      values: {
        date: '2026-10-13',
        entries: { RELIANCE: { symbol: 'RELIANCE', instrument: 'CASH', iep: 1420, previousClose: 1400, change: 20, changePercent: 1.43, at: at('09:08:00').toISOString() } },
      },
      sourceTime: '2026-10-13',
      fetchedAt: at('09:10:00').toISOString(),
      basis: 'x',
      source: 'x',
      status: 'ok',
    };
    const BOOK = [entry('rel-fut', { symbol: 'RELIANCE27OCT26FUT' })];

    it('a job reaching its slot at 09:12:01 is dropped, never started', async () => {
      const t = makeSvc({ book: BOOK, preOpen: book });
      t.svc.clockNow = () => at('09:12:01');
      const report = await t.svc.runWindow(PRE_OPEN_CHECK, at('09:10:00'));
      expect(report).toEqual(expect.objectContaining({ droppedAtOpen: 1, judged: 0 }));
      expect(t.judgeOvernight).not.toHaveBeenCalled();
    });

    it('starts at 09:11:59', async () => {
      const t = makeSvc({ book: BOOK, preOpen: book });
      t.svc.clockNow = () => at('09:11:59');
      expect(await t.svc.runWindow(PRE_OPEN_CHECK, at('09:10:00'))).toEqual(expect.objectContaining({ judged: 1 }));
    });

    it('always reserves a live slot, even when no held venue is open', async () => {
      const t = makeSvc({ book: BOOK, preOpen: book });
      t.svc.clockNow = () => at('09:10:00');
      t.findMany.mockResolvedValue([{ userId: 'u1', exchange: 'NFO' }]); // nothing held is trading at 09:10
      await t.svc.runWindow(PRE_OPEN_CHECK, at('09:10:00'));
      expect(t.runShared.mock.calls[0][2].reserveLive()).toBe(true);
    });
  });
});

describe('SentinelOvernightService — the live reservation follows the held venues', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it('at 08:30 every held venue is shut, so reviews may use every slot', async () => {
    const t = makeSvc();
    t.svc.clockNow = () => ist('2026-10-13', '08:30');
    await t.svc.runWindow(PRE_OPEN, ist('2026-10-13', '08:30'));
    const opts = t.runShared.mock.calls.map((c) => c[2]);
    expect(opts.length).toBe(2);
    for (const o of opts) expect(o.reserveLive()).toBe(false);
  });

  it('at 15:45 MCX (held) is trading, so the live slot stays reserved', async () => {
    const t = makeSvc();
    t.svc.clockNow = () => ist('2026-10-12', '15:45');
    await t.svc.runWindow(AFTER_CLOSE_EQUITY, MON_CLOSE);
    expect(t.runShared.mock.calls[0][2].reserveLive()).toBe(true);
  });

  it('the pre-open trigger names 08:30', async () => {
    const t = makeSvc();
    await t.svc.runWindow(PRE_OPEN, ist('2026-10-13', '08:30'));
    expect(t.buildPacket.mock.calls[0][3][0].detail).toMatch(/08:30/);
  });
});

describe('SentinelOvernightService — the 09:10 pre-open check', () => {
  const TUE = '2026-10-13';
  const AT_0912 = ist(TUE, '09:10');
  const TAG = `window:PRE_OPEN_CHECK:EQUITY:${TUE}`;
  const BOOK: RosterEntry[] = [
    entry('nifty-opt'),
    entry('nifty-fut', { symbol: 'NIFTY27OCT26FUT' }),
    entry('rel-fut', { symbol: 'RELIANCE27OCT26FUT' }),
    entry('rel-opt', { symbol: 'RELIANCE27OCT261400CE' }),
    entry('sbin-opt', { symbol: 'SBIN27OCT26800PE' }),
    entry('mcx-fut', { exchange: 'MCX', symbol: 'GOLD05DEC26FUT' }),
    entry('cash', { exchange: 'NSE', symbol: 'RELIANCE-EQ' }),
  ];
  const preOpenBook: CueRecord<PreOpenBook> = {
    values: {
      date: TUE,
      entries: {
        RELIANCE: { symbol: 'RELIANCE', instrument: 'CASH', iep: 1420, previousClose: 1400, change: 20, changePercent: 1.43, at: ist(TUE, '09:08').toISOString() },
      },
    },
    sourceTime: TUE,
    fetchedAt: AT_0912.toISOString(),
    basis: 'pre-open session date',
    source: 'NSE market-data-pre-open',
    status: 'ok',
  };

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('judges only NSE F&O positions with a pre-open IEP; the rest are recorded skipped — never MCX or cash', async () => {
    const t = makeSvc({ book: BOOK, preOpen: preOpenBook });
    const report = await t.svc.runWindow(PRE_OPEN_CHECK, AT_0912);
    expect(t.evidence.preOpen).toHaveBeenCalledWith(AT_0912);
    expect(t.record.mock.calls.map((c) => c[0].trackerId).sort()).toEqual(['rel-fut', 'rel-opt']);
    expect(report).toEqual(expect.objectContaining({ window: TAG, judged: 2, skippedNoInput: 3, picked: 5 }));
    expect(t.record.mock.calls[0][0].triggeredBy).toEqual(['PRE_OPEN_CHECK', TAG]);
  });

  it('labels an option’s figure as the underlying gap estimate, not the option’s price', async () => {
    const t = makeSvc({ book: [entry('rel-opt', { symbol: 'RELIANCE27OCT261400CE' })], preOpen: preOpenBook });
    await t.svc.runWindow(PRE_OPEN_CHECK, AT_0912);
    const packet = t.judgeOvernight.mock.calls[0][0];
    expect(packet.overnight.review.kind).toBe('PRE_OPEN_CHECK');
    expect(packet.overnight.preOpenGap).toEqual(
      expect.objectContaining({
        available: true,
        at: ist(TUE, '09:08').toISOString(),
        value: expect.objectContaining({
          label: expect.stringMatching(/^underlying cash pre-open IEP gap estimate.*NOT the option's price/),
          iep: 1420,
          previousClose: 1400,
          gap: 20,
          gapPercent: 1.43,
        }),
      }),
    );
    expect(t.buildPacket.mock.calls[0][3][0]).toEqual({ name: 'PRE_OPEN_CHECK', detail: expect.stringMatching(/09:10/) });
  });

  it('an index future with no IEP costs no judge call: recorded skipped with the reason, nothing written', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const t = makeSvc({ book: [entry('nifty-fut', { symbol: 'NIFTY27OCT26FUT' })], preOpen: preOpenBook });
    const report = await t.svc.runWindow(PRE_OPEN_CHECK, AT_0912);
    expect(t.judgeOvernight).not.toHaveBeenCalled();
    expect(t.runShared).not.toHaveBeenCalled();
    expect(t.record).not.toHaveBeenCalled();
    expect(report).toEqual(expect.objectContaining({ picked: 1, skippedNoInput: 1, judged: 0 }));
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/NIFTY27OCT26FUT.*skipped.*no pre-open IEP for NIFTY/);
  });

  it('skips are counted and logged once per position per window, not on every fire', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const stale = { ...preOpenBook, status: 'stale' as const, reason: 'the pre-open book is from 2026-10-12' };
    const t = makeSvc({ book: BOOK, preOpen: stale });
    const first = await t.svc.runWindow(PRE_OPEN_CHECK, AT_0912);
    const second = await t.svc.runWindow(PRE_OPEN_CHECK, ist(TUE, '09:11'));
    expect(first.skippedNoInput).toBe(5);
    expect(second.skippedNoInput).toBe(0);
    expect(warn.mock.calls.filter((c) => /pre-open check .* skipped/.test(String(c[0])))).toHaveLength(5);
    // The next day is a new window.
    const nextDay = await t.svc.runWindow(PRE_OPEN_CHECK, ist('2026-10-14', '09:10'));
    expect(nextDay.skippedNoInput).toBe(5);
  });

  it('a book that arrives by the 09:11 fire gets the skipped positions checked', async () => {
    const stale = { ...preOpenBook, status: 'stale' as const, reason: 'old' };
    const t = makeSvc({ book: BOOK, preOpen: stale });
    await t.svc.runWindow(PRE_OPEN_CHECK, AT_0912);
    t.evidence.preOpen.mockResolvedValue(preOpenBook);
    await t.svc.runWindow(PRE_OPEN_CHECK, ist(TUE, '09:11'));
    expect(t.record.mock.calls.map((c) => c[0].trackerId).sort()).toEqual(['rel-fut', 'rel-opt']);
  });

  it('a stale book is no book: nothing is judged, each position skipped with the reason', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const stale = { ...preOpenBook, status: 'stale' as const, reason: 'the pre-open book is from 2026-10-12' };
    const t = makeSvc({ book: BOOK, preOpen: stale });
    const report = await t.svc.runWindow(PRE_OPEN_CHECK, AT_0912);
    expect(t.judgeOvernight).not.toHaveBeenCalled();
    expect(report.skippedNoInput).toBe(5);
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/stale/);
  });

  it('anything still queued at 09:15 is dropped, never judged', async () => {
    const t = makeSvc({ book: BOOK, preOpen: preOpenBook });
    t.svc.clockNow = () => ist(TUE, '09:15');
    const report = await t.svc.runWindow(PRE_OPEN_CHECK, ist(TUE, '09:14'));
    expect(report).toEqual(expect.objectContaining({ droppedAtOpen: 2, judged: 0 }));
    expect(t.judgeOvernight).not.toHaveBeenCalled();
  });

  it('once per position per day: the 09:11 repeat judges nothing, a restart finds the rows', async () => {
    const done = new Set<string>();
    const t = makeSvc({ book: BOOK, preOpen: preOpenBook, done });
    await t.svc.runWindow(PRE_OPEN_CHECK, AT_0912);
    const again = await t.svc.runWindow(PRE_OPEN_CHECK, ist(TUE, '09:11'));
    expect(again).toEqual(expect.objectContaining({ judged: 0, alreadyDone: 2 }));
    const restarted = makeSvc({ book: BOOK, preOpen: preOpenBook, done });
    await restarted.svc.runWindow(PRE_OPEN_CHECK, ist(TUE, '09:11'));
    expect(restarted.judgeOvernight).not.toHaveBeenCalled();
    expect(t.judgeOvernight).toHaveBeenCalledTimes(2);
  });

  it('goes through the shared judge cap, under its own tag, apart from the 08:30 review', async () => {
    const t = makeSvc({ book: BOOK, preOpen: preOpenBook });
    await t.svc.runWindow(PRE_OPEN, ist(TUE, '08:30'));
    await t.svc.runWindow(PRE_OPEN_CHECK, AT_0912);
    const kinds = t.record.mock.calls.map((c) => c[0].triggeredBy[0]);
    expect(kinds.filter((k) => k === 'PRE_OPEN_CHECK')).toHaveLength(2);
    expect(kinds.filter((k) => k === 'PRE_OPEN_REVIEW').length).toBeGreaterThan(0);
    expect(t.runShared).toHaveBeenCalledTimes(t.record.mock.calls.length);
  });

  it('with the pre-open source switched off (never fetched), the check judges nothing — no paid call without its input', async () => {
    const t = makeSvc({ book: BOOK, preOpen: unavailableSnapshot('market cues are switched off (MARKET_CUES_ENABLED is not true)').preOpen });
    const report = await t.svc.runWindow(PRE_OPEN_CHECK, AT_0912);
    expect(report).toEqual(expect.objectContaining({ picked: 0, judged: 0 }));
    expect(t.judgeOvernight).not.toHaveBeenCalled();
    expect(t.findMany).not.toHaveBeenCalled();
  });

  it('a fetch that FAILED judges nothing; every position is skipped naming the failure', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const failed = { ...unavailableSnapshot('x').preOpen, fetchedAt: AT_0912.toISOString(), reason: 'NSE pre-open: HTTP 503' };
    const t = makeSvc({ book: BOOK, preOpen: failed });
    const report = await t.svc.runWindow(PRE_OPEN_CHECK, AT_0912);
    expect(t.judgeOvernight).not.toHaveBeenCalled();
    expect(report.skippedNoInput).toBe(5);
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/HTTP 503/);
  });

  it('does nothing outside 09:08–09:15 or on a holiday — does not even read the book', async () => {
    const t = makeSvc({ book: BOOK, preOpen: preOpenBook });
    await t.svc.runWindow(PRE_OPEN_CHECK, ist(TUE, '09:05'));
    await t.svc.runWindow(PRE_OPEN_CHECK, ist('2026-10-20', '09:10'));
    expect(t.evidence.preOpen).not.toHaveBeenCalled();
    expect(t.findMany).not.toHaveBeenCalled();
  });
});

// ─── SENTINEL_SCORECARD: the scorecard block in the overnight packet ─────────

const SCORECARD: Scorecard = {
  id: 'sc1',
  userId: 'u1',
  symbol: 'NIFTY13OCT2625000CE',
  exchange: 'NFO',
  underlying: 'NIFTY',
  side: 'BULLISH',
  window: 'OVERNIGHT',
  computedAt: '2026-10-12T10:10:00.000Z',
  factors: [
    { name: 'oi', points: 2, value: 'PCR 2.1 (5d med 1.3), put build +18% @25000', reason: 'heavy put writing', available: true },
    { name: 'fii_dii', points: 0, value: 'FII cash -120cr, idx fut L/S 0.42', reason: 'flat', available: true },
    { name: 'vix', points: -1, value: '13.4 vs 20d 12.1', reason: 'rising VIX', available: true },
    { name: 'expiry', points: -2, value: '1 session left', reason: 'theta', available: true },
    { name: 'news', points: 0, value: '', reason: 'no news store rows', available: false },
    { name: 'indicators', points: 1, value: 'D: EMA9>EMA20, MACD+, RSI 58', reason: 'trend up', available: true },
    { name: 'mood', points: 0, value: 'ACTIVE', reason: 'context only', available: true },
  ],
  total: 0,
  band: 'NEUTRAL',
};

describe('SentinelOvernightService — the scorecard block (SENTINEL_SCORECARD)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  const provider = (sc: Scorecard | null | Error) => ({
    latest: jest.fn().mockImplementation(async () => {
      if (sc instanceof Error) throw sc;
      return sc;
    }),
  });

  /** The packet and stamp for the NFO position at the 15:45 window. */
  async function judged(opts: Parameters<typeof makeSvc>[0]) {
    const t = makeSvc(opts);
    await t.svc.runWindow(AFTER_CLOSE_EQUITY, MON_CLOSE);
    return { t, packet: t.judgeOvernight.mock.calls[0][0], row: t.record.mock.calls[0][0] };
  }

  it('flag unset, "off" or anything but "on": the provider is never asked and the packet is byte-identical to no provider at all', async () => {
    const baseline = await judged({});
    for (const scorecardFlag of [undefined, 'off', 'true', 'ON-ish', '']) {
      const p = provider(SCORECARD);
      const r = await judged({ scorecardFlag, scorecards: p });
      expect(p.latest).not.toHaveBeenCalled();
      expect(JSON.stringify(r.packet)).toBe(JSON.stringify(baseline.packet));
      expect('scorecard' in r.packet.overnight).toBe(false);
      expect(r.row.promptVersion).toBe('o1/t1');
    }
  });

  it('flag on but no scorecard (or no provider bound, or a failed read): no key, same packet, same stamp', async () => {
    const baseline = await judged({});
    for (const scorecards of [provider(null), undefined, provider(new Error('db down'))]) {
      const r = await judged({ scorecardFlag: 'on', scorecards });
      expect(JSON.stringify(r.packet)).toBe(JSON.stringify(baseline.packet));
      expect(r.row.promptVersion).toBe('o1/t1');
    }
  });

  it('flag on with a scorecard: overnight.scorecard is a compact present block, asked by user and tracker, and the row is stamped o5', async () => {
    const p = provider(SCORECARD);
    const r = await judged({ scorecardFlag: ' On ', scorecards: p });
    expect(p.latest).toHaveBeenCalledWith('u1', 'nfo');
    const block = r.packet.overnight.scorecard;
    expect(block).toEqual(
      expect.objectContaining({
        available: true,
        at: SCORECARD.computedAt,
        value: expect.objectContaining({ side: 'BULLISH', total: 0, band: 'NEUTRAL', window: 'OVERNIGHT' }),
      }),
    );
    expect(block.value.factors).toMatch(/^oi:\+2 PCR 2\.1/);
    expect(block.value.factors).toContain('news:n/a');
    expect(block.value.factors).toContain('expiry:-2 1 session left');
    expect(JSON.stringify(block.value).length).toBeLessThanOrEqual(SCORECARD_BLOCK_MAX_CHARS);
    expect(r.row.promptVersion).toBe('o5/t1');
    // Stored with the packet, so the verdict row shows what the judge saw.
    expect(r.row.packet.overnight.scorecard).toEqual(block);
  });

  it('reaches the pre-open review and the 09:10 check too', async () => {
    const t = makeSvc({ scorecardFlag: 'on', scorecards: provider(SCORECARD) });
    await t.svc.runWindow(PRE_OPEN, ist('2026-10-13', '08:50'));
    expect(t.judgeOvernight.mock.calls.every((c) => c[0].overnight.scorecard?.available === true)).toBe(true);

    const at = (hms: string) => new Date(`2026-10-13T${hms}+05:30`);
    const book: CueRecord<PreOpenBook> = {
      values: {
        date: '2026-10-13',
        entries: { RELIANCE: { symbol: 'RELIANCE', instrument: 'CASH', iep: 1420, previousClose: 1400, change: 20, changePercent: 1.43, at: at('09:08:00').toISOString() } },
      },
      sourceTime: '2026-10-13',
      fetchedAt: at('09:10:00').toISOString(),
      basis: 'x',
      source: 'x',
      status: 'ok',
    };
    const c = makeSvc({
      scorecardFlag: 'on',
      scorecards: provider(SCORECARD),
      book: [entry('rel-fut', { symbol: 'RELIANCE27OCT26FUT' })],
      preOpen: book,
    });
    c.svc.clockNow = () => at('09:10:30');
    await c.svc.runWindow(PRE_OPEN_CHECK, at('09:10:00'));
    expect(c.judgeOvernight).toHaveBeenCalledTimes(1);
    expect(c.judgeOvernight.mock.calls[0][0].overnight.scorecard.available).toBe(true);
    expect(c.record.mock.calls[0][0].promptVersion).toBe('o5/t1');
  });
});
