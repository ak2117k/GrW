import { Logger } from '@nestjs/common';
import {
  OVERNIGHT_FAILURE_LIMIT,
  SentinelOvernightService,
  assembleOvernightSection,
  formatOvernightReason,
  type SectionInputs,
} from './sentinel-overnight.service';
import { AFTER_CLOSE_EQUITY, AFTER_CLOSE_MCX, PRE_OPEN } from '../overnight/overnight-calendar';
import type { RosterEntry } from './roster.service';
import type { TickReading } from './sentinel-cycle.service';
import type { RawCues, RawOiEvidence } from '../ports/overnight-evidence.port';
import type { NewsEvidence } from '../overnight/overnight-evidence';

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

const cuesPresent: RawCues = {
  nasdaq: { reading: null, reason: 'nasdaq.factor is a stub and no US-close source is wired' },
  crudeOil: { reading: { value: 5600, change: -84, changePercent: -1.5, at: MON_CLOSE.toISOString() }, source: 'commodities-snapshot.service' },
  gold: { reading: { value: 121000, change: 300, changePercent: 0.25, at: MON_CLOSE.toISOString() }, source: 'commodities-snapshot.service' },
  fiiFlows: { reading: null, reason: 'fii.factor is a stub' },
  indiaVix: { reading: { value: 13.4, change: 0.6, changePercent: 4.7, at: null }, source: 'market-context.service' },
  underlyingChange: { reading: { value: 25050, change: -110, changePercent: -0.44, at: null }, source: 'yahoo-finance.service' },
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
      expect(s.marketCues.nasdaq).toEqual({ available: false, reason: expect.stringMatching(/stub/) });
      expect(s.marketCues.fiiFlows.available).toBe(false);
      expect(s.marketCues.sectorStrength).toEqual({ available: false, reason: expect.stringMatching(/index/) });
    });
    it('cues: a stale cue reports its age', () => {
      const s = assembleOvernightSection(
        inputs({
          cues: {
            ok: true,
            value: { ...cuesPresent, gold: { reading: { value: 1, change: 0, changePercent: 0, at: ist('2026-10-12', '11:45').toISOString() }, source: 'x' } },
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

describe('formatOvernightReason', () => {
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

function makeSvc(opts: { enabled?: boolean; done?: Set<string> } = {}) {
  const book: RosterEntry[] = [
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
  const runShared = jest.fn().mockImplementation((_id: string, work: () => Promise<unknown>) => work());
  const tickFor = jest.fn().mockResolvedValue(optTick());
  const evidence = {
    news: jest.fn().mockResolvedValue(freshNews),
    oi: jest.fn().mockResolvedValue(oiPresent),
    cues: jest.fn().mockResolvedValue(cuesPresent),
  };
  const findMany = jest.fn().mockResolvedValue([
    { userId: 'u1', exchange: 'NFO' },
    { userId: 'u1', exchange: 'MCX' },
  ]);
  const config = { get: jest.fn().mockReturnValue(opts.enabled === false ? 'false' : 'true') };

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
