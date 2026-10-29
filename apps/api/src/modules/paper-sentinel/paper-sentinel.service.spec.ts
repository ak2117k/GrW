import { parseExitDisciplineConfig } from '../exit-discipline/config';
import type { TickReading } from '../trade-sentinel/services/sentinel-cycle.service';
import { PaperSentinelService, type PaperPosition } from './paper-sentinel.service';

const OWNER = 'owner-1';
// Thu 29 Oct 2026 11:30 IST — NFO open.
const NOW = new Date('2026-10-29T06:00:00.000Z');

const reading = (over: Partial<TickReading> = {}): TickReading => ({
  segment: 'OPT',
  side: 'LONG',
  entryPrice: 100,
  qty: 75,
  ltp: 100,
  underlyingLtp: 24000,
  underlyingLtpAt: null,
  underlyingLtpSource: 'hub',
  underlyingLtpReason: null,
  structureSymbol: 'NIFTY',
  nearestSupport: null,
  nearestResistance: null,
  structureReason: null,
  structureAt: null,
  structureSource: 'test',
  holdingHigh: null,
  holdingLow: null,
  entryTime: new Date('2026-10-29T04:00:00.000Z'),
  expiry: null,
  volumeRatio: null,
  freshNewsCount: null,
  factorValues: {},
  factorsReason: null,
  ...over,
});

const pos = (over: Partial<PaperPosition> = {}): PaperPosition => ({
  tradeId: 'T1',
  userId: OWNER,
  symbol: 'NIFTY04NOV2524000CE',
  exchange: 'NFO',
  token: '111',
  side: 'BUY',
  quantity: 75,
  entryPrice: 100,
  entryTime: new Date('2026-10-29T04:00:00.000Z'),
  product: 'INTRADAY',
  decisionId: 'D1',
  ltp: 100,
  ltpAt: NOW,
  ...over,
});

const verdict = (over: Record<string, unknown> = {}) => ({
  verdict: 'HOLD',
  confidence: 'high',
  thesisStatus: 'INTACT',
  recoveryAvailable: true,
  reason: 'ok',
  evidence: ['money.netPnl'],
  invalidationPoint: 'x',
  reviewIn: 300,
  ...over,
});

function make(opts: { judge?: Record<string, unknown>; env?: Record<string, string> } = {}) {
  for (const [k, v] of Object.entries(opts.env ?? {})) process.env[k] = v;
  let n = 0;
  const looks: Array<Record<string, unknown>> = [];
  const record = jest.fn(async (input: Record<string, unknown>) => {
    const row = { ...input, id: `L${++n}`, tradeId: String(input.trackerId).slice('paper:'.length), createdAt: new Date() };
    looks.unshift(row);
    return row;
  });
  const recentForTracker = jest.fn(async (trackerId: string, limit: number) => looks.filter((l) => l.trackerId === trackerId).slice(0, limit));
  const history = jest.fn().mockResolvedValue([]);
  const upsert = jest.fn().mockResolvedValue({});
  const tickForRow = jest.fn(async (_id: string, row: { lastLtp: number }) => reading({ ltp: row.lastLtp }));
  const judge = jest.fn().mockResolvedValue(verdict(opts.judge));
  const prisma = {
    paperExitShadow: { findMany: jest.fn().mockResolvedValue([]), upsert },
    coreRiskLimit: { findFirst: jest.fn().mockResolvedValue(null) },
    coreJournal: { findUnique: jest.fn().mockResolvedValue(null) },
  };
  const svc = new PaperSentinelService(
    { evaluate: jest.fn().mockReturnValue({ fires: [], heartbeat: true, shouldEvaluate: true, trigger: 'FIRE' }) } as never,
    { build: jest.fn(async () => ({ position: {}, money: { netPnl: 0, greenFloorPrice: null, greenFloorArmed: false } })) } as never,
    { ensureFor: jest.fn().mockResolvedValue({ direction: 'LONG', reason: 'r', levelPrice: null, targetPrice: null, invalidation: null, source: 'INFERRED' }) } as never,
    { judge, promptVersion: 'sentinel-test' } as never,
    { captureAndCompare: jest.fn().mockResolvedValue({ now: null, prev: null }) } as never,
    { record, recentForTracker, history } as never,
    prisma as never,
    { get: () => undefined } as never,
    { tickForRow } as never,
    // Discipline off: the live gate BYPASSes (DISABLED) and the executor exits — the simplest live path.
    parseExitDisciplineConfig({ EXIT_DISCIPLINE_ENABLED: 'false' }),
  );
  return { svc, record, judge, upsert, tickForRow };
}

describe('PaperSentinelService — the live sentinel cycle on paper trades', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('roster: F&O only, oldest first, capped at PAPER_SENTINEL_MAX, every left-out trade with its reason', async () => {
    const t = make({ env: { PAPER_SENTINEL_MAX: '1' } });
    t.svc.observe(
      [
        pos({ tradeId: 'NEW', entryTime: new Date('2026-10-29T05:00:00.000Z') }),
        pos({ tradeId: 'OLD', entryTime: new Date('2026-10-29T03:50:00.000Z') }),
        pos({ tradeId: 'EQ', exchange: 'NSE', symbol: 'RELIANCE-EQ' }),
      ],
      NOW,
    );
    await t.svc.idle();
    const roster = await (t.svc as unknown as { roster(u: string): Array<{ trackerId: string; watched: boolean; reason: string }> }).roster(OWNER);
    expect(roster.find((e) => e.trackerId === 'paper:OLD')).toMatchObject({ watched: true });
    expect(roster.find((e) => e.trackerId === 'paper:NEW')).toMatchObject({ watched: false, reason: expect.stringContaining('PAPER_SENTINEL_MAX') });
    expect(roster.find((e) => e.trackerId === 'paper:EQ')).toMatchObject({ watched: false, reason: expect.stringContaining('F&O only') });
    // Only the watched one was priced and judged.
    expect(t.tickForRow.mock.calls.map((c) => c[0])).toEqual(['paper:OLD']);
  });

  it('reads the position through the live tick source, as a signed, uncounted row with its running high/low', async () => {
    const t = make();
    t.svc.observe([pos({ side: 'SELL', ltp: 104 })], NOW);
    await t.svc.idle();
    const [trackerId, row, opts] = t.tickForRow.mock.calls[0] as unknown as [string, Record<string, unknown>, Record<string, unknown>];
    expect(trackerId).toBe('paper:T1');
    expect(row).toMatchObject({ qty: -75, entryPrice: 100, lastLtp: 104, holdingHigh: 104, holdingLow: 100, kind: 'POSITION', exchange: 'NFO', token: '111' });
    expect(opts).toEqual({ uncounted: true });
  });

  it('every look goes to the paper look table, keyed paper:<tradeId>', async () => {
    const t = make();
    t.svc.observe([pos()], NOW);
    await t.svc.idle();
    expect(t.record).toHaveBeenCalledTimes(1);
    expect(t.record.mock.calls[0][0]).toMatchObject({ trackerId: 'paper:T1', userId: OWNER, verdict: 'HOLD', promptVersion: 'sentinel-test' });
    expect(t.upsert).not.toHaveBeenCalled();
  });

  it('an EXIT_NOW the live gate lets through is the AI_EXIT, at the LTP; the trade is then off the roster', async () => {
    const t = make({ judge: { verdict: 'EXIT_NOW', thesisStatus: 'BROKEN' } });
    t.svc.observe([pos({ ltp: 92 })], NOW);
    await t.svc.idle();
    expect(t.upsert).toHaveBeenCalledTimes(1);
    const arg = t.upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ tradeId_rule: { tradeId: 'T1', rule: 'AI_EXIT' } });
    expect(arg.create).toMatchObject({ tradeId: 'T1', decisionId: 'D1', rule: 'AI_EXIT', price: 92 });
    expect(arg.create.detail.gate.outcome).toBe('BYPASS');
    expect(arg.update).toEqual({});

    // The live position would be flat now: no more looks.
    t.svc.observe([pos({ ltp: 90 })], new Date(NOW.getTime() + 30_000));
    await t.svc.idle();
    expect(t.record).toHaveBeenCalledTimes(1);
  });

  it('a HOLD with a protective exitTrigger is armed on the next fresh price and fires as AI_TRIGGER', async () => {
    const t = make({ judge: { exitTrigger: { instrument: 'PREMIUM', op: 'BELOW', price: 95 } } });
    // The cycle persists the trigger exactly as live (exitTriggerRecord); make the look carry a stored one.
    t.record.mockImplementation(async (input: Record<string, unknown>) => ({
      ...input,
      id: 'L1',
      tradeId: 'T1',
      createdAt: new Date(),
      exitTrigger: { v: 1, instrument: 'PREMIUM', op: 'BELOW', price: 95, watch: null },
    }));
    const at = (s: number) => new Date(Date.now() + s * 1000);
    t.svc.observe([pos({ ltp: 100, ltpAt: at(0) })], at(0));
    await t.svc.idle();
    t.svc.observe([pos({ ltp: 99, ltpAt: at(30) })], at(30));
    await t.svc.idle();
    expect(t.upsert).not.toHaveBeenCalled();
    t.svc.observe([pos({ ltp: 94, ltpAt: at(60) })], at(60));
    await t.svc.idle();
    expect(t.upsert).toHaveBeenCalledTimes(1);
    expect(t.upsert.mock.calls[0][0].create).toMatchObject({ rule: 'AI_TRIGGER', price: 94 });
    expect(t.upsert.mock.calls[0][0].create.detail.trigger).toMatchObject({ instrument: 'PREMIUM', op: 'BELOW', price: 95, refPrice: 99 });
  });

  it('a trade still open whose quote missed this sweep stays on the roster with its last LTP; a closed one leaves', async () => {
    const t = make();
    t.svc.observe([pos({ tradeId: 'A', ltp: 101 }), pos({ tradeId: 'B', ltp: 102 })], NOW);
    await t.svc.idle();
    // Next sweep: A's quote failed (not priced) but A is open; B is gone (closed).
    t.svc.observe([], new Date(NOW.getTime() + 30_000), new Set(['A']));
    await t.svc.idle();
    const roster = (t.svc as unknown as { roster(u: string): Array<{ trackerId: string }> }).roster(OWNER);
    expect(roster.map((e) => e.trackerId)).toEqual(['paper:A']);
    const lastRowForA = t.tickForRow.mock.calls.filter((c) => c[0] === 'paper:A').pop() as unknown as [string, { lastLtp: number; updatedAt: Date }];
    expect(lastRowForA[1]).toMatchObject({ lastLtp: 101, updatedAt: NOW });
  });

  it('an AI exit is handed to the close handler (the paper watch closes the trade); PAPER_SENTINEL_CLOSES=off records only', async () => {
    const t = make({ judge: { verdict: 'EXIT_NOW', thesisStatus: 'BROKEN' } });
    const handler = jest.fn().mockResolvedValue(undefined);
    t.svc.onExit(handler);
    t.svc.observe([pos({ ltp: 92 })], NOW);
    await t.svc.idle();
    expect(t.upsert).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ tradeId: 'T1', rule: 'AI_EXIT', price: 92 }));

    const off = make({ judge: { verdict: 'EXIT_NOW' }, env: { PAPER_SENTINEL_CLOSES: 'off' } });
    const h2 = jest.fn();
    off.svc.onExit(h2);
    off.svc.observe([pos({ ltp: 92 })], NOW);
    await off.svc.idle();
    expect(off.upsert).toHaveBeenCalledTimes(1);
    expect(h2).not.toHaveBeenCalled();
  });

  it('an AI exit recorded while the trade stayed open is closed late, at the recorded price', async () => {
    const t = make();
    const at = new Date('2026-10-29T06:04:05.000Z');
    (t as unknown as { svc: { prisma: { paperExitShadow: { findMany: jest.Mock } } } }).svc.prisma.paperExitShadow.findMany.mockResolvedValue([
      { tradeId: 'T1', rule: 'AI_EXIT', price: 124, reason: 'AI EXIT_NOW (PASS)', wouldExitAt: at },
    ]);
    const handler = jest.fn().mockResolvedValue(undefined);
    t.svc.onExit(handler);
    t.svc.observe([pos({ ltp: 120 })], NOW);
    await t.svc.idle();
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ tradeId: 'T1', rule: 'AI_EXIT', price: 124, at, reason: expect.stringContaining('closed late') }));
    // Already exited: no further looks.
    expect(t.record).not.toHaveBeenCalled();
  });

  it('PAPER_SENTINEL=off (or PAPER_EXIT_SHADOW=off) stops it entirely', async () => {
    for (const env of [{ PAPER_SENTINEL: 'off' }, { PAPER_EXIT_SHADOW: 'off' }] as Array<Record<string, string>>) {
      const t = make({ env });
      t.svc.observe([pos()], NOW);
      await t.svc.idle();
      expect(t.tickForRow).not.toHaveBeenCalled();
      expect(t.record).not.toHaveBeenCalled();
      process.env = { ...saved };
    }
  });
});
