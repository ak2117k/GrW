jest.mock('../../../common/utils/ops-alert', () => ({ sendOpsAlert: jest.fn().mockResolvedValue(true) }));

import { performance } from 'node:perf_hooks';
import { setCoreKillSwitchReader } from '../../trade-core/risk-wall/kill-gate';
import { parseSignalTraderConfig, type SignalTraderConfig } from '../domain/signal-trader.config';
import type { SignalView } from '../domain/signal.types';
import { SignalTraderService, Stopwatch } from './signal-trader.service';

/**
 * 2026-11-25 signal speed: every decision that writes the judge carries `judge.timings` — where the
 * ~60 s from post to order goes. Record only: no decision may change because of it.
 */
const RECEIVED = new Date('2026-11-25T05:20:00Z');
const NOW = new Date('2026-11-25T05:20:12Z');
const signal: SignalView = {
  id: 'sig1', channelId: 'ch1', receivedAt: RECEIVED, underlying: 'NIFTY', instrumentKind: 'CE', strike: 25000, expiry: null,
  side: 'BUY', entryLow: 100, entryHigh: 100, entryType: 'ABOVE', sl: 90, targets: [120], qty: 2, confidence: 0.9, rawText: 'BUY NIFTY 25000 CE ABOVE 100 SL 90',
};
const masterRows = [
  { token: '111', symbol: 'NIFTY28OCT2625000CE', name: 'NIFTY', expiry: '28OCT2099', strike: '2500000', lotsize: '75', instrumenttype: 'OPTIDX', exch_seg: 'NFO', tick_size: '5' },
];
const LIVE_ENV = { SENTINEL_TRIGGERS_ENABLED: 'true', AI_AUTO_EXIT_ENABLED: 'true', AI_AUTO_EXIT_MODE: 'live', AI_AUTO_EXIT_USER_IDS: 'owner' };
const takeVerdict = { verdict: 'TAKE', confidence: 80, reasons: ['OI supports'], entry: null, sl: null, targets: [], lots: null };

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
    armTrigger: jest.fn(async (id: string, f: Record<string, any>) => {
      Object.assign(decisions.find((d) => d.id === id)!, f, { decision: 'PENDING' });
      return true;
    }),
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

function build(over: { cfg?: Partial<SignalTraderConfig>; ltps?: Array<number | null>; ltpFn?: () => number | null } = {}) {
  const cfg = { ...parseSignalTraderConfig({ HUB_OWNER_USER_ID: 'owner' }), liveFromIstMin: 0, entryRetryMin: 0, ...over.cfg };
  const repo = makeRepo();
  const judge = { judge: jest.fn(async () => ({ ok: true, verdict: takeVerdict, latencyMs: 10 })) };
  const context = {
    // The real build reports each block's ms through onBlock; this fake does the same for two blocks.
    build: jest.fn(async (i: { onBlock?: (key: string, ms: number) => void }) => {
      i.onBlock?.('chain', 12);
      i.onBlock?.('mbm', 3);
      return { chain: { status: 'present', source: 'x', value: {} }, mbm: { status: 'not_applicable', reason: 'not MBM' } };
    }),
    noise: jest.fn(async () => ({ status: 'unavailable', reason: 'none' })),
    trend: jest.fn(async () => ({ status: 'unavailable', reason: 'none' })),
    optionDelta: jest.fn(async () => null),
    extremeSince: jest.fn(async () => null),
  };
  const executor = { place: jest.fn(async () => ({ kind: 'PLACED', orderRowId: 'o1', brokerOrderId: 'b1' })), resume: jest.fn() };
  const risk = { validateTrade: jest.fn(async () => ({ allowed: true })) };
  const clock = { isOpen: () => true, minutesToClose: () => 200 };
  const master = { getInstrumentMaster: async () => masterRows };
  const ltps = [...(over.ltps ?? [])];
  const quotes = { ltp: jest.fn(async () => (over.ltpFn ? over.ltpFn() : ltps.length ? (ltps.shift() as number | null) : 101)) };
  const funds = { available: jest.fn(async () => 1_000_000) };
  const paper = { open: jest.fn(async () => ({ ok: true as const, tradeId: 'pt1', entryPrice: 101, duplicate: false })) };
  const svc = new SignalTraderService(cfg, LIVE_ENV, repo as never, judge as never, context as never, executor as never, risk as never, clock, master, quotes, funds, paper);
  return { svc, repo, executor };
}

const ev = { signalId: 'sig1', clusterId: 'cl1', agreeCount: 1, conflict: false };
const ms = expect.any(Number);

describe('SignalTraderService — per-step timings (judge.timings)', () => {
  const OLD = process.env.LIVE_TRADING_ENABLED;
  beforeEach(() => {
    process.env.LIVE_TRADING_ENABLED = 'true';
    setCoreKillSwitchReader({ isOn: async () => false, isOnForPlatform: async () => false, invalidate: () => undefined });
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(() => {
    process.env.LIVE_TRADING_ENABLED = OLD;
    setCoreKillSwitchReader(null);
  });

  it('records model, context and pre-send timings on a live TAKE', async () => {
    const t = build({ cfg: { mode: 'live' } });
    expect(await t.svc.evaluate(ev, NOW)).toMatchObject({ decision: 'TAKE', placed: 'PLACED' });
    const timings = t.repo.decisions[0].judge.timings;
    expect(timings).toEqual({
      receivedToStartMs: 12_000,
      contextMs: ms,
      contextBlocks: { chain: { status: 'present', ms: 12 }, mbm: { status: 'not_applicable', ms: 3 }, trend: { status: 'unavailable', ms } },
      noiseMs: ms,
      lateRoomMs: null, // not a late call
      modelMs: ms,
      oiCheckMs: null, // the OI check does not run on this path
      delayedCheckMs: ms,
      preSendQuoteMs: ms,
      totalToSendMs: ms,
    });
    for (const k of ['contextMs', 'noiseMs', 'modelMs', 'delayedCheckMs', 'preSendQuoteMs', 'totalToSendMs']) expect(timings[k]).toBeGreaterThanOrEqual(0);
    expect(timings.totalToSendMs).toBeGreaterThanOrEqual(timings.modelMs);
  });

  it('records timings on a price_moved SKIP', async () => {
    const t = build({ cfg: { mode: 'live' }, ltps: [101, 105] });
    expect(await t.svc.evaluate(ev, NOW)).toMatchObject({ decision: 'SKIP', skipReason: 'price_moved' });
    expect(t.executor.place).not.toHaveBeenCalled();
    expect(t.repo.decisions[0].judge.timings).toMatchObject({ receivedToStartMs: 12_000, modelMs: ms, preSendQuoteMs: ms, totalToSendMs: ms });
  });

  it('records timings on a PENDING arm (BUY ABOVE not reached)', async () => {
    const t = build({ cfg: { mode: 'live' }, ltps: [95] });
    expect(await t.svc.evaluate(ev, NOW)).toMatchObject({ decision: 'PENDING' });
    expect(t.repo.decisions[0].judge.timings).toMatchObject({ modelMs: ms, contextMs: ms, preSendQuoteMs: null });
    t.svc.onModuleDestroy();
  });

  it('records timings on a PAPER decision', async () => {
    const t = build({ cfg: { mode: 'paper' } });
    expect(await t.svc.evaluate(ev, NOW)).toMatchObject({ decision: 'PAPER' });
    expect(t.repo.decisions[0].judge.timings).toMatchObject({ modelMs: ms, preSendQuoteMs: null });
  });

  it('a timing helper that throws never changes the decision', async () => {
    const t = build({ cfg: { mode: 'live' } });
    jest.spyOn(performance, 'now').mockImplementation(() => {
      throw new Error('clock broke');
    });
    const r = await t.svc.evaluate(ev, NOW);
    expect(r).toMatchObject({ decision: 'TAKE', placed: 'PLACED' });
    expect(t.executor.place).toHaveBeenCalledTimes(1);
    // The steps could not be timed: recorded as null, never invented.
    expect(t.repo.decisions[0].judge.timings).toMatchObject({ contextMs: null, modelMs: null, preSendQuoteMs: null, totalToSendMs: null, receivedToStartMs: 12_000 });
  });

  it('Stopwatch: a throwing clock gives nulls; the timed work still returns or throws as before', async () => {
    const sw = new Stopwatch(() => {
      throw new Error('x');
    });
    await expect(sw.time('modelMs', async () => 7)).resolves.toBe(7);
    await expect(sw.time('noiseMs', async () => { throw new Error('work failed'); })).rejects.toThrow('work failed');
    expect(sw.snapshot()).toMatchObject({ modelMs: null, noiseMs: null, totalToSendMs: null });
  });

  /**
   * The watch timer is a REAL interval here (poll 1 s): a timer created inside an evaluation must not carry that
   * evaluation's stopwatch into later ticks, so an expiry SKIP keeps exactly the timings stored at arm time.
   */
  describe('expiry SKIPs keep the arm-time timings', () => {
    const WAIT_MS = 30 * 60_000;
    const armNow = (expiresInMs: number) => new Date(Date.now() - WAIT_MS + expiresInMs);
    const settled = async (d: Record<string, any>, maxMs = 4_000) => {
      const end = Date.now() + maxMs;
      while (d.status !== 'DONE' && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    };

    it('arm a trigger, let it expire: the stored judge.timings equal the arm-time timings', async () => {
      const t = build({ cfg: { mode: 'live', triggerWaitMin: 30, triggerPollSec: 1 } as never, ltpFn: () => 95 });
      expect(await t.svc.evaluate(ev, armNow(200))).toMatchObject({ decision: 'PENDING' });
      const armed = JSON.parse(JSON.stringify(t.repo.decisions[0].judge.timings));
      expect(armed.modelMs).toEqual(expect.any(Number));
      await new Promise((r) => setTimeout(r, 1_100)); // a stale stopwatch would now add > 1 s to totalToSendMs
      await settled(t.repo.decisions[0]);
      t.svc.onModuleDestroy();
      expect(t.repo.decisions[0]).toMatchObject({ decision: 'SKIP', skipReason: 'trigger_expired' });
      expect(t.repo.decisions[0].judge.timings).toEqual(armed);
    }, 10_000);

    it('two decisions armed by different evaluations: the one that expires keeps its own timings', async () => {
      const t = build({ cfg: { mode: 'live', triggerWaitMin: 30, triggerPollSec: 1 } as never, ltpFn: () => 95 });
      // B is armed first (its evaluation starts the watch timer) and waits 30 min; A expires almost at once.
      expect(await t.svc.evaluate({ ...ev, signalId: 'sigB', clusterId: 'clB' }, new Date())).toMatchObject({ decision: 'PENDING' });
      await new Promise((r) => setTimeout(r, 300));
      expect(await t.svc.evaluate(ev, armNow(200))).toMatchObject({ decision: 'PENDING' });
      const a = t.repo.decisions.find((d) => d.signalId === 'sig1')!;
      const armedA = JSON.parse(JSON.stringify(a.judge.timings));
      await new Promise((r) => setTimeout(r, 1_100));
      await settled(a);
      t.svc.onModuleDestroy();
      expect(a).toMatchObject({ decision: 'SKIP', skipReason: 'trigger_expired' });
      expect(a.judge.timings).toEqual(armedA);
      expect(t.repo.decisions.find((d) => d.signalId === 'sigB')).toMatchObject({ decision: 'PENDING' });
    }, 10_000);
  });
});
