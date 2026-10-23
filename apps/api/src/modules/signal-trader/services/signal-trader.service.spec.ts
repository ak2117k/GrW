jest.mock('../../../common/utils/ops-alert', () => ({ sendOpsAlert: jest.fn().mockResolvedValue(true) }));

import { sendOpsAlert } from '../../../common/utils/ops-alert';
import { setCoreKillSwitchReader } from '../../trade-core/risk-wall/kill-gate';
import { parseSignalTraderConfig, type SignalTraderConfig } from '../domain/signal-trader.config';
import type { SignalView } from '../domain/signal.types';
import { SignalTraderService } from './signal-trader.service';

const signal: SignalView = {
  id: 'sig1', channelId: 'ch1', receivedAt: null, underlying: 'NIFTY', instrumentKind: 'CE', strike: 25000, expiry: null,
  side: 'BUY', entryLow: 100, entryHigh: 100, entryType: 'ABOVE', sl: 90, targets: [120], qty: 2, confidence: 0.9, rawText: 'BUY NIFTY 25000 CE ABOVE 100 SL 90',
};
const masterRows = [
  { token: '111', symbol: 'NIFTY28OCT2625000CE', name: 'NIFTY', expiry: '28OCT2099', strike: '2500000', lotsize: '75', instrumenttype: 'OPTIDX', exch_seg: 'NFO', tick_size: '5' },
];
const LIVE_ENV = { SENTINEL_TRIGGERS_ENABLED: 'true', AI_AUTO_EXIT_ENABLED: 'true', AI_AUTO_EXIT_MODE: 'live', AI_AUTO_EXIT_USER_IDS: 'owner' };

function makeRepo() {
  const decisions: Array<Record<string, any>> = [];
  return {
    decisions,
    decisionsFor: jest.fn(async (id: string) => decisions.filter((d) => d.signalId === id)),
    signal: jest.fn(async () => signal),
    cluster: jest.fn(async () => null),
    channelTitle: jest.fn(async () => 'Chan One'),
    channelStats: jest.fn(async () => ({ hitRate: 0.4, n: 20 })),
    claimDecision: jest.fn(async (c: Record<string, any>) => {
      if (decisions.some((d) => d.signalId === c.signalId && d.evaluation === c.evaluation)) return null;
      const id = `d${decisions.length + 1}`;
      decisions.push({ ...c, id, status: 'PENDING' });
      return id;
    }),
    finishDecision: jest.fn(async (id: string, f: Record<string, any>) => {
      Object.assign(decisions.find((d) => d.id === id)!, f, { status: 'DONE' });
    }),
    tradesToday: jest.fn(async () => 0),
    signalLossToday: jest.fn(async () => 0),
    clusterTaken: jest.fn(async () => false),
    holding: jest.fn(async () => false),
    orderForSignal: jest.fn(async () => null),
    appendThesisNote: jest.fn(async () => true),
    pendingOrders: jest.fn(async () => []),
  };
}

const takeVerdict = { verdict: 'TAKE', confidence: 80, reasons: ['OI supports'], entry: null, sl: null, targets: [], lots: null };

function build(over: { cfg?: Partial<SignalTraderConfig>; env?: Record<string, string>; judge?: any; ltp?: number | null } = {}) {
  const cfg = { ...parseSignalTraderConfig({ HUB_OWNER_USER_ID: 'owner' }), ...over.cfg };
  const repo = makeRepo();
  const judge = { judge: jest.fn(over.judge ?? (async () => ({ ok: true, verdict: takeVerdict, latencyMs: 10 }))) };
  const context = { build: jest.fn(async () => ({})), nearestLevels: jest.fn(async () => null) };
  const executor = { place: jest.fn(async () => ({ kind: 'PLACED', orderRowId: 'o1', brokerOrderId: 'b1' })), resume: jest.fn() };
  const risk = { validateTrade: jest.fn(async () => ({ allowed: true })) };
  const clock = { isOpen: () => true, minutesToClose: () => 200 };
  const master = { getInstrumentMaster: async () => masterRows };
  const ltp = over.ltp === undefined ? 101 : over.ltp;
  const quotes = { ltp: jest.fn(async () => ltp) };
  const svc = new SignalTraderService(cfg, over.env ?? LIVE_ENV, repo as never, judge as never, context as never, executor as never, risk as never, clock, master, quotes);
  return { svc, repo, judge, executor, risk, quotes };
}

const ev = { signalId: 'sig1', clusterId: 'cl1', agreeCount: 1, conflict: false };

describe('SignalTraderService', () => {
  const OLD = process.env.LIVE_TRADING_ENABLED;
  let killOn = false;
  beforeEach(() => {
    killOn = false;
    process.env.LIVE_TRADING_ENABLED = 'true';
    setCoreKillSwitchReader({ isOn: async () => killOn, isOnForPlatform: async () => killOn, invalidate: () => undefined });
    (sendOpsAlert as jest.Mock).mockClear();
  });
  afterAll(() => {
    process.env.LIVE_TRADING_ENABLED = OLD;
    setCoreKillSwitchReader(null);
  });

  it('shadow: identical pipeline, TAKE recorded and alerted, NO order', async () => {
    const t = build({ cfg: { mode: 'shadow' } });
    const r = await t.svc.evaluate(ev);
    expect(r).toMatchObject({ decision: 'TAKE' });
    expect(t.judge.judge).toHaveBeenCalledTimes(1);
    expect(t.executor.place).not.toHaveBeenCalled();
    expect(t.repo.decisions[0]).toMatchObject({ decision: 'TAKE', mode: 'shadow' });
    expect((sendOpsAlert as jest.Mock).mock.calls[0][1]).toMatch(/\[SHADOW\] Signal TAKE/);
  });

  it('live: TAKE places exactly one LIMIT through the executor with the capped plan', async () => {
    const t = build({ cfg: { mode: 'live' } });
    const r = await t.svc.evaluate(ev);
    expect(r).toMatchObject({ decision: 'TAKE', placed: 'PLACED' });
    expect(t.executor.place).toHaveBeenCalledTimes(1);
    const arg = (t.executor.place.mock.calls[0] as any[])[0];
    expect(arg.plan).toMatchObject({ lots: 2, qty: 150, limitPrice: 101.5, sl: 90 });
    expect(arg.qtyUnit).toBe('units');
    expect((sendOpsAlert as jest.Mock).mock.calls[0][1]).toMatch(/qty 150.*LIMIT 101.5/s);
  });

  it('a duplicate event evaluates (and orders) once', async () => {
    const t = build({ cfg: { mode: 'live' } });
    await Promise.all([t.svc.onReady(ev), t.svc.onReady(ev), t.svc.onReady(ev)]);
    await t.svc.evaluate(ev);
    expect(t.repo.decisions).toHaveLength(1);
    expect(t.executor.place).toHaveBeenCalledTimes(1);
  });

  it('judge timeout → SKIP judge_unavailable, no order', async () => {
    const t = build({ cfg: { mode: 'live' }, judge: async () => ({ ok: false, reason: 'judge_unavailable', detail: 'no verdict within 120 s', latencyMs: 120000 }) });
    const r = await t.svc.evaluate(ev);
    expect(r).toMatchObject({ decision: 'SKIP', skipReason: 'judge_unavailable' });
    expect(t.executor.place).not.toHaveBeenCalled();
  });

  it('kill switch on → SKIP before the judge is asked', async () => {
    killOn = true;
    const t = build({ cfg: { mode: 'live' } });
    const r = await t.svc.evaluate(ev);
    expect(r?.skipReason).toBe('kill_switch');
    expect(t.judge.judge).not.toHaveBeenCalled();
    expect(t.executor.place).not.toHaveBeenCalled();
  });

  it('daily counters come from the DB', async () => {
    const t = build({ cfg: { mode: 'live' } });
    t.repo.tradesToday.mockResolvedValue(3);
    expect((await t.svc.evaluate(ev))?.skipReason).toBe('trades_today');
    const t2 = build({ cfg: { mode: 'live' } });
    t2.repo.signalLossToday.mockResolvedValue(12_000);
    expect((await t2.svc.evaluate(ev))?.skipReason).toBe('daily_signal_loss');
    expect(t2.repo.tradesToday).toHaveBeenCalledWith('live', expect.any(Date));
  });

  it('live without LIVE_TRADING_ENABLED or an enforceable SL → SKIP', async () => {
    process.env.LIVE_TRADING_ENABLED = 'false';
    const t = build({ cfg: { mode: 'live' } });
    expect((await t.svc.evaluate(ev))?.skipReason).toBe('live_trading_enabled');
    process.env.LIVE_TRADING_ENABLED = 'true';
    const t2 = build({ cfg: { mode: 'live' }, env: {} });
    expect((await t2.svc.evaluate(ev))?.skipReason).toBe('sl_enforceable');
  });

  it('conflict cluster: the judge decides with no confidence boost', async () => {
    const weak = async () => ({ ok: true, verdict: { ...takeVerdict, confidence: 55 }, latencyMs: 1 });
    const strong = build({ cfg: { mode: 'shadow' }, judge: weak });
    expect((await strong.svc.evaluate({ ...ev, agreeCount: 3, conflict: false }))?.decision).toBe('TAKE');
    const conflict = build({ cfg: { mode: 'shadow' }, judge: weak });
    expect(await conflict.svc.evaluate({ ...ev, agreeCount: 3, conflict: true })).toMatchObject({ decision: 'SKIP', skipReason: 'low_confidence' });
    const packet = (conflict.judge.judge.mock.calls[0] as any[])[0];
    expect(packet.cluster).toMatchObject({ conflict: true, strong: false });
  });

  it('a low-confidence SKIP may be upgraded once corroborated; a TAKE is never re-evaluated', async () => {
    let conf = 50;
    const t = build({ cfg: { mode: 'shadow' }, judge: async () => ({ ok: true, verdict: { ...takeVerdict, confidence: conf }, latencyMs: 1 }) });
    expect((await t.svc.evaluate(ev))?.skipReason).toBe('low_confidence');
    expect(await t.svc.evaluate(ev)).toBeNull(); // same agreeCount: not corroborated
    conf = 70;
    expect((await t.svc.evaluate({ ...ev, agreeCount: 2 }))?.decision).toBe('TAKE');
    expect(await t.svc.evaluate({ ...ev, agreeCount: 3 })).toBeNull();
    expect(t.repo.decisions.map((d) => d.evaluation)).toEqual([1, 2]);
  });

  it('price moved out of the band while the judge thought → SKIP price_moved, no order', async () => {
    const t = build({ cfg: { mode: 'live' } });
    t.quotes.ltp.mockResolvedValueOnce(101).mockResolvedValueOnce(105);
    expect((await t.svc.evaluate(ev))?.skipReason).toBe('price_moved');
    expect(t.executor.place).not.toHaveBeenCalled();
  });

  it('mode off ignores events', async () => {
    const t = build({ cfg: { mode: 'off' } });
    expect(await t.svc.onReady(ev)).toBeNull();
    expect(t.repo.claimDecision).not.toHaveBeenCalled();
  });

  it('a channel update is information for the sentinel, never an order', async () => {
    const t = build({ cfg: { mode: 'live' } });
    t.repo.orderForSignal.mockResolvedValue({ id: 'o1', trackerId: 'tr1', userId: 'owner', tradingsymbol: 'NIFTY28OCT2625000CE' } as never);
    await t.svc.onUpdate({ signalId: 'sig1', kind: 'EXIT_NOW', text: 'exit now guys' });
    expect(t.repo.appendThesisNote).toHaveBeenCalledWith('tr1', 'owner', expect.stringMatching(/EXIT_NOW.*information only/));
    expect(t.executor.place).not.toHaveBeenCalled();
  });
});
