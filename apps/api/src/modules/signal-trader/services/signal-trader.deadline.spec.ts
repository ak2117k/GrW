jest.mock('../../../common/utils/ops-alert', () => ({ sendOpsAlert: jest.fn().mockResolvedValue(true) }));

import { setCoreKillSwitchReader } from '../../trade-core/risk-wall/kill-gate';
import { parseSignalTraderConfig, type SignalTraderConfig } from '../domain/signal-trader.config';
import type { SignalView } from '../domain/signal.types';
import { SignalContextService } from './signal-context.service';
import { SignalTraderService } from './signal-trader.service';

/**
 * 2026-11-25 signal speed: the judge's market-data collection is capped at SIGNAL_CONTEXT_DEADLINE_MS.
 * Each source that misses it reaches the judge as `unavailable` with its reason (per block, never the
 * whole packet); the noise units and a late call's room are raced against the same deadline.
 */
const NOW = new Date('2026-11-25T05:20:12Z');
const signal: SignalView = {
  id: 'sig1', channelId: 'ch1', receivedAt: new Date('2026-11-25T05:20:00Z'), underlying: 'NIFTY', instrumentKind: 'CE', strike: 25000, expiry: null,
  side: 'BUY', entryLow: 100, entryHigh: 100, entryType: 'ABOVE', sl: 90, targets: [160], qty: 2, confidence: 0.9, rawText: 'BUY NIFTY 25000 CE ABOVE 100 SL 90',
};
const masterRows = [
  { token: '111', symbol: 'NIFTY28OCT2625000CE', name: 'NIFTY', expiry: '28OCT2099', strike: '2500000', lotsize: '75', instrumenttype: 'OPTIDX', exch_seg: 'NFO', tick_size: '5' },
];
const takeVerdict = { verdict: 'TAKE', confidence: 80, reasons: ['OI supports'], entry: null, sl: null, targets: [], lots: null };
const hang = () => new Promise<never>(() => undefined);

function makeRepo() {
  const decisions: Array<Record<string, any>> = [];
  return {
    decisions,
    decisionsFor: jest.fn(async (id: string) => decisions.filter((d) => d.signalId === id)),
    signal: jest.fn(async (id: string) => ({ ...signal, id })),
    cluster: jest.fn(async () => null),
    channelTitle: jest.fn(async () => 'Chan One'),
    channelStats: jest.fn(async () => null),
    channelViews: jest.fn(async () => ({ status: 'unavailable', reason: 'none' })),
    claimDecision: jest.fn(async (c: Record<string, any>) => {
      const id = `d${decisions.length + 1}`;
      decisions.push({ ...c, id, status: 'PENDING', decision: null });
      return id;
    }),
    finishDecision: jest.fn(async (id: string, f: Record<string, any>) => {
      Object.assign(decisions.find((d) => d.id === id)!, f, { status: 'DONE' });
    }),
    armTrigger: jest.fn(async () => true),
    touchTrigger: jest.fn(async () => undefined),
    pendingTriggerCount: jest.fn(async () => 0),
    tradesToday: jest.fn(async () => 0),
    paperOnNoFunds: jest.fn(async () => true),
    signalLossToday: jest.fn(async () => 0),
    clusterTaken: jest.fn(async () => false),
    holding: jest.fn(async () => false),
    recordTrend: jest.fn(async () => undefined),
  };
}

type FakeContext = Record<string, jest.Mock>;

function build(over: { cfg?: Partial<SignalTraderConfig>; context?: Partial<FakeContext>; ltp?: number } = {}) {
  const cfg = { ...parseSignalTraderConfig({ HUB_OWNER_USER_ID: 'owner' }), mode: 'paper' as const, liveFromIstMin: 0, entryRetryMin: 0, ...over.cfg };
  const repo = makeRepo();
  const judge = { judge: jest.fn(async (_packet: any) => ({ ok: true, verdict: takeVerdict, latencyMs: 10 })) };
  const context: FakeContext = {
    build: jest.fn(async () => ({ chain: { status: 'present', source: 'x', value: {} } })),
    noise: jest.fn(async () => ({ status: 'unavailable', reason: 'none' })),
    trend: jest.fn(async () => ({ status: 'unavailable', reason: 'none' })),
    optionDelta: jest.fn(async () => 0.5),
    extremeSince: jest.fn(async () => null),
    ...over.context,
  };
  const executor = { place: jest.fn(), resume: jest.fn() };
  const risk = { validateTrade: jest.fn(async () => ({ allowed: true })) };
  const clock = { isOpen: () => true, minutesToClose: () => 200 };
  const master = { getInstrumentMaster: async () => masterRows };
  const quotes = { ltp: jest.fn(async () => over.ltp ?? 101) };
  const funds = { available: jest.fn(async () => 1_000_000) };
  const paper = { open: jest.fn(async () => ({ ok: true as const, tradeId: 'pt1', entryPrice: 101, duplicate: false })) };
  const svc = new SignalTraderService(cfg, {}, repo as never, judge as never, context as never, executor as never, risk as never, clock, master, quotes, funds, paper);
  return { svc, repo, judge, context };
}

const ev = { signalId: 'sig1', clusterId: 'cl1', agreeCount: 1, conflict: false };
const packetOf = (t: ReturnType<typeof build>) => t.judge.judge.mock.calls[0][0] as Record<string, any>;

describe('SignalTraderService — the judge\'s market-data collection has a deadline', () => {
  beforeEach(() => setCoreKillSwitchReader({ isOn: async () => false, isOnForPlatform: async () => false, invalidate: () => undefined }));
  afterAll(() => setCoreKillSwitchReader(null));

  it('passes the configured deadline to the context build', async () => {
    const dflt = build();
    await dflt.svc.evaluate(ev, NOW);
    expect(dflt.context.build).toHaveBeenCalledWith(expect.objectContaining({ deadlineMs: 6000 }));
    const set = build({ cfg: { contextDeadlineMs: 2500 } });
    await set.svc.evaluate(ev, NOW);
    expect(set.context.build).toHaveBeenCalledWith(expect.objectContaining({ deadlineMs: 2500 }));
  });

  it('a hanging structure block leaves chain and market present', async () => {
    // The real build, with a level book that never answers; chain + market-context answer at once.
    const chain = { latestChain: jest.fn(async () => ({ expiry: '2026-11-25', capturedAt: NOW, spot: 25010, fut: null, pcr: 1, maxPain: 25000, callWall: 25200, putWall: 24800 })) };
    const marketCtx = { snapshot: jest.fn(async () => ({ spot: 25010, vix: 12, vixRegime: 'LOW', pcr: 1, maxPain: 25000, adRatio: 1, capturedAt: NOW })) };
    const levels = { structureFor: jest.fn(hang), levelsFor: jest.fn(hang) };
    const real = new SignalContextService(chain as any, marketCtx as any, levels as any);
    const t = build({ cfg: { contextDeadlineMs: 40 }, context: { build: jest.fn((i: any) => real.build(i)) } });
    const started = Date.now();
    expect(await t.svc.evaluate(ev, NOW)).toMatchObject({ decision: 'PAPER' });
    expect(Date.now() - started).toBeLessThan(2_000);
    const market = packetOf(t).market;
    expect(market.structure).toEqual({ status: 'unavailable', reason: expect.stringContaining('timed out after 40 ms') });
    expect(market.chain.status).toBe('present');
    expect(market.market.status).toBe('present');
  });

  it('noise that hangs is unavailable after the deadline', async () => {
    const t = build({ cfg: { contextDeadlineMs: 30 }, context: { noise: jest.fn(hang) } });
    expect(await t.svc.evaluate(ev, NOW)).toMatchObject({ decision: 'PAPER' });
    expect(packetOf(t).market.noise).toEqual({ status: 'unavailable', reason: 'noise units: timed out after 30 ms' });
    expect(packetOf(t).market.chain.status).toBe('present');
  });

  it('noise that fails after the deadline raises no unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (r: unknown) => unhandled.push(r);
    process.on('unhandledRejection', onUnhandled);
    try {
      const late = () => new Promise<never>((_, reject) => setTimeout(() => reject(new Error('late failure')), 60));
      const t = build({ cfg: { contextDeadlineMs: 20 }, context: { noise: jest.fn(late) } });
      await t.svc.evaluate(ev, NOW);
      expect(packetOf(t).market.noise).toEqual({ status: 'unavailable', reason: 'noise units: timed out after 20 ms' });
      await new Promise((r) => setTimeout(r, 100));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('a late call whose room hangs is judged with a null room and the reason', async () => {
    const t = build({ cfg: { contextDeadlineMs: 30 }, context: { optionDelta: jest.fn(hang) }, ltp: 130 });
    await t.svc.evaluate(ev, NOW);
    expect(packetOf(t).plan.late).toMatchObject({ chasePct: 30, room: null, roomUnavailable: 'late room: timed out after 30 ms' });
  });

  it('a late call whose room answers in time is unchanged (no extra key)', async () => {
    const t = build({ ltp: 130 });
    await t.svc.evaluate(ev, NOW);
    const late = packetOf(t).plan.late;
    expect(late.room).toMatchObject({ needs: 'UP' });
    expect(late).not.toHaveProperty('roomUnavailable');
  });
});

describe('config — SIGNAL_CONTEXT_DEADLINE_MS', () => {
  it('default 6000', () => {
    const c = parseSignalTraderConfig({});
    expect(c.contextDeadlineMs).toBe(6000);
    expect(c.problems.join(' ')).not.toContain('SIGNAL_CONTEXT_DEADLINE_MS');
    expect(parseSignalTraderConfig({ SIGNAL_CONTEXT_DEADLINE_MS: '1000' }).contextDeadlineMs).toBe(1000);
    expect(parseSignalTraderConfig({ SIGNAL_CONTEXT_DEADLINE_MS: '30000' }).contextDeadlineMs).toBe(30000);
  });

  it('out of range falls back', () => {
    for (const raw of ['999', '30001', 'abc', '2500.5']) {
      const c = parseSignalTraderConfig({ SIGNAL_CONTEXT_DEADLINE_MS: raw });
      expect(c.contextDeadlineMs).toBe(6000);
      expect(c.problems).toContain(`SIGNAL_CONTEXT_DEADLINE_MS=${raw} is invalid — using 6000`);
    }
  });
});
