jest.mock('../../../common/utils/ops-alert', () => ({ sendOpsAlert: jest.fn().mockResolvedValue(true) }));

import { sendOpsAlert } from '../../../common/utils/ops-alert';
import { setCoreKillSwitchReader } from '../../trade-core/risk-wall/kill-gate';
import { parseSignalTraderConfig, type SignalTraderConfig } from '../domain/signal-trader.config';
import type { SignalView } from '../domain/signal.types';
import { SignalTraderService } from './signal-trader.service';

/**
 * Pending triggers (BUY ABOVE x not reached → wait), engine SL when the channel hides it, and the
 * broker margin calculator in the live funds check.
 */
const base: SignalView = {
  id: 'sig1', channelId: 'ch1', receivedAt: null, underlying: 'NIFTY', instrumentKind: 'CE', strike: 25000, expiry: null,
  side: 'BUY', entryLow: 100, entryHigh: 100, entryType: 'ABOVE', sl: 90, targets: [120], qty: 2, confidence: 0.9, rawText: 'BUY NIFTY 25000 CE ABOVE 100 SL 90',
};
const masterRows = [
  { token: '111', symbol: 'NIFTY28OCT2625000CE', name: 'NIFTY', expiry: '28OCT2099', strike: '2500000', lotsize: '75', instrumenttype: 'OPTIDX', exch_seg: 'NFO', tick_size: '5' },
  { token: '222', symbol: 'NIFTY28OCT99FUT', name: 'NIFTY', expiry: '28OCT2099', strike: '-1', lotsize: '75', instrumenttype: 'FUTIDX', exch_seg: 'NFO', tick_size: '10' },
  { token: '333', symbol: 'SENSEX99OCT8000CE', name: 'SENSEX', expiry: '29OCT2099', strike: '8000000', lotsize: '20', instrumenttype: 'OPTIDX', exch_seg: 'BFO', tick_size: '5' },
];
const LIVE_ENV = { SENTINEL_TRIGGERS_ENABLED: 'true', AI_AUTO_EXIT_ENABLED: 'true', AI_AUTO_EXIT_MODE: 'live', AI_AUTO_EXIT_USER_IDS: 'owner' };
const takeVerdict = { verdict: 'TAKE', confidence: 80, reasons: ['OI supports'], entry: null, sl: null, targets: [], lots: null };
const T0 = new Date('2026-10-26T05:00:00Z'); // 10:30 IST

function makeRepo(signal: SignalView) {
  const decisions: Array<Record<string, any>> = [];
  const repo = {
    decisions,
    decisionsFor: jest.fn(async (id: string) => decisions.filter((d) => d.signalId === id)),
    signal: jest.fn(async () => signal),
    cluster: jest.fn(async () => null),
    channelTitle: jest.fn(async () => 'Chan One'),
    channelStats: jest.fn(async () => null),
    channelViews: jest.fn(async () => ({ status: 'unavailable', reason: 'none' })),
    claimDecision: jest.fn(async (c: Record<string, any>) => {
      if (decisions.some((d) => d.signalId === c.signalId && d.evaluation === c.evaluation)) return null;
      const id = `d${decisions.length + 1}`;
      decisions.push({ ...c, id, status: 'PENDING', decision: null, createdAt: new Date() });
      return id;
    }),
    finishDecision: jest.fn(async (id: string, f: Record<string, any>) => {
      Object.assign(decisions.find((d) => d.id === id)!, f, { status: 'DONE' });
    }),
    armTrigger: jest.fn(async (id: string, f: Record<string, any>) => {
      const d = decisions.find((x) => x.id === id);
      if (!d || d.status !== 'PENDING' || d.decision !== null) return false;
      Object.assign(d, f, { decision: 'PENDING' });
      return true;
    }),
    touchTrigger: jest.fn(async () => undefined),
    pendingTriggers: jest.fn(async () => decisions.filter((d) => d.status === 'PENDING' && d.decision === 'PENDING')),
    pendingTriggerCount: jest.fn(async () => decisions.filter((d) => d.status === 'PENDING' && d.decision === 'PENDING').length),
    tradesToday: jest.fn(async () => decisions.filter((d) => d.decision === 'TAKE').length),
    paperOnNoFunds: jest.fn(async () => true),
    claimPaperFallback: jest.fn(async () => false),
    signalLossToday: jest.fn(async () => 0),
    clusterTaken: jest.fn(async () => false),
    holding: jest.fn(async () => false),
    orderForSignal: jest.fn(async () => null),
    appendThesisNote: jest.fn(async () => true),
    pendingOrders: jest.fn(async () => []),
  };
  return repo;
}

function build(over: { signal?: Partial<SignalView>; cfg?: Partial<SignalTraderConfig>; ltp?: () => number | null; engineSl?: any; margin?: any; funds?: number } = {}) {
  const signal = { ...base, ...over.signal };
  const cfg = { ...parseSignalTraderConfig({ HUB_OWNER_USER_ID: 'owner' }), ...over.cfg };
  const repo = makeRepo(signal);
  const judge = { judge: jest.fn(async () => ({ ok: true, verdict: takeVerdict, latencyMs: 10 })) };
  const context = {
    build: jest.fn(async () => ({})),
    nearestLevels: jest.fn(async () => null),
    engineSl: jest.fn(over.engineSl ?? (async () => ({ sl: null, method: null, detail: 'nothing' }))),
  };
  const executor = { place: jest.fn(async () => ({ kind: 'PLACED', orderRowId: 'o1', brokerOrderId: 'b1' })), resume: jest.fn() };
  const risk = { validateTrade: jest.fn(async () => ({ allowed: true })) };
  const clock = { isOpen: () => true, minutesToClose: () => 300 };
  const master = { getInstrumentMaster: async () => masterRows };
  const ltpFn = over.ltp ?? (() => 101);
  const quotes = { ltp: jest.fn(async () => ltpFn()) };
  const funds = { available: jest.fn(async () => over.funds ?? 1_000_000), ...(over.margin ? { margin: jest.fn(over.margin) } : {}) };
  const paper = { open: jest.fn(async () => ({ ok: true as const, tradeId: 'pt1', entryPrice: 101, duplicate: false })) };
  const svc = new SignalTraderService(cfg, LIVE_ENV, repo as never, judge as never, context as never, executor as never, risk as never, clock, master, quotes, funds as never, paper);
  return { svc, repo, judge, context, executor, quotes, funds, paper, cfg };
}

const ev = { signalId: 'sig1', clusterId: 'cl1', agreeCount: 1, conflict: false };
const alerts = () => (sendOpsAlert as jest.Mock).mock.calls.map((c) => String(c[1]));

describe('SignalTraderService — pending triggers', () => {
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

  it('ABOVE not reached → PENDING (judge asked once, armed alert), then fires when LTP enters [x, x·1.03] and places', async () => {
    let ltp = 95;
    const t = build({ cfg: { mode: 'live' }, ltp: () => ltp });
    const r = await t.svc.evaluate(ev, T0);
    expect(r).toMatchObject({ decision: 'PENDING' });
    expect(t.repo.decisions[0]).toMatchObject({ decision: 'PENDING', status: 'PENDING' });
    expect(t.repo.decisions[0].plan.trigger).toMatchObject({ price: 100, op: 'ABOVE', bandLow: 100, bandHigh: 103 });
    expect(t.judge.judge).toHaveBeenCalledTimes(1);
    expect(t.executor.place).not.toHaveBeenCalled();
    expect(alerts().some((a) => /WAITING/.test(a) && /ABOVE 100/.test(a))).toBe(true);

    // still below → keep waiting
    await t.svc.checkTriggers(new Date(T0.getTime() + 5_000));
    expect(t.svc.pendingIds()).toEqual(['d1']);
    // above the band (chasing) → keep waiting
    ltp = 105;
    await t.svc.checkTriggers(new Date(T0.getTime() + 10_000));
    expect(t.executor.place).not.toHaveBeenCalled();
    // in band → full gate again, judge reused (< 10 min), order placed
    ltp = 101;
    await t.svc.checkTriggers(new Date(T0.getTime() + 15_000));
    expect(t.executor.place).toHaveBeenCalledTimes(1);
    expect(t.judge.judge).toHaveBeenCalledTimes(1);
    expect(t.repo.decisions[0]).toMatchObject({ decision: 'TAKE', status: 'DONE' });
    expect(alerts().some((a) => /TRIGGER hit/.test(a))).toBe(true);
    expect(t.svc.pendingIds()).toEqual([]);
    t.svc.onModuleDestroy();
  });

  it('polls one trigger at most every SIGNAL_TRIGGER_POLL_SEC', async () => {
    const t = build({ cfg: { mode: 'shadow' }, ltp: () => 95 });
    await t.svc.evaluate(ev, T0);
    t.quotes.ltp.mockClear();
    await t.svc.checkTriggers(new Date(T0.getTime() + 1_000));
    await t.svc.checkTriggers(new Date(T0.getTime() + 2_000));
    await t.svc.checkTriggers(new Date(T0.getTime() + 4_000));
    expect(t.quotes.ltp).toHaveBeenCalledTimes(1);
    await t.svc.checkTriggers(new Date(T0.getTime() + 7_000));
    expect(t.quotes.ltp).toHaveBeenCalledTimes(2);
    t.svc.onModuleDestroy();
  });

  it('re-asks the judge when its verdict is older than 10 min', async () => {
    let ltp = 95;
    const t = build({ cfg: { mode: 'shadow' }, ltp: () => ltp });
    await t.svc.evaluate(ev, T0);
    ltp = 100.5;
    await t.svc.checkTriggers(new Date(T0.getTime() + 11 * 60_000));
    expect(t.judge.judge).toHaveBeenCalledTimes(2);
    expect(t.repo.decisions[0].decision).toBe('TAKE');
    t.svc.onModuleDestroy();
  });

  it('the gate is re-run at the trigger: kill switch engaged meanwhile → SKIP, no order', async () => {
    let ltp = 95;
    const t = build({ cfg: { mode: 'live' }, ltp: () => ltp });
    await t.svc.evaluate(ev, T0);
    killOn = true;
    ltp = 101;
    await t.svc.checkTriggers(new Date(T0.getTime() + 6_000));
    expect(t.executor.place).not.toHaveBeenCalled();
    expect(t.repo.decisions[0]).toMatchObject({ decision: 'SKIP', skipReason: 'kill_switch' });
    t.svc.onModuleDestroy();
  });

  it('expires after SIGNAL_TRIGGER_WAIT_MIN → SKIP trigger_expired', async () => {
    const t = build({ cfg: { mode: 'shadow', triggerWaitMin: 30 }, ltp: () => 95 });
    await t.svc.evaluate(ev, T0);
    await t.svc.checkTriggers(new Date(T0.getTime() + 31 * 60_000));
    expect(t.repo.decisions[0]).toMatchObject({ decision: 'SKIP', skipReason: 'trigger_expired' });
    expect(alerts().some((a) => /trigger_expired/.test(a))).toBe(true);
    t.svc.onModuleDestroy();
  });

  it('never waits past the min-minutes-to-close cutoff', async () => {
    const t = build({ cfg: { mode: 'shadow' }, ltp: () => 95 });
    (t.svc as any).clock = { isOpen: () => true, minutesToClose: () => 30 };
    await t.svc.evaluate(ev, T0);
    const exp = Date.parse(t.repo.decisions[0].plan.trigger.expiresAt);
    expect(exp - T0.getTime()).toBe(10 * 60_000); // 30 min left − 20 min cutoff
    t.svc.onModuleDestroy();
  });

  it('a failing check at the trigger price (risk cap) SKIPs instead of waiting', async () => {
    const t = build({ cfg: { mode: 'shadow' }, signal: { sl: 50 }, ltp: () => 95 });
    const r = await t.svc.evaluate(ev, T0);
    expect(r).toMatchObject({ decision: 'SKIP', skipReason: 'risk_cap' });
    expect(t.judge.judge).not.toHaveBeenCalled();
  });

  it('at most SIGNAL_TRIGGER_MAX_PENDING armed at once', async () => {
    const t = build({ cfg: { mode: 'shadow', triggerMaxPending: 1 }, ltp: () => 95 });
    t.repo.pendingTriggerCount.mockResolvedValue(1);
    const r = await t.svc.evaluate(ev, T0);
    expect(r).toMatchObject({ decision: 'SKIP', skipReason: 'entry_tolerance' });
    expect(alerts().some((x) => x.includes("trigger watch full (1/1)"))).toBe(true);
  });

  it('SIGNAL_TRIGGER_WAIT_MIN=0 keeps the old behaviour (SKIP at once)', async () => {
    const t = build({ cfg: { mode: 'shadow', triggerWaitMin: 0 }, ltp: () => 95 });
    const r = await t.svc.evaluate(ev, T0);
    expect(r).toMatchObject({ decision: 'SKIP', skipReason: 'entry_tolerance' });
  });

  it('restart-safe: a PENDING trigger is resumed from the DB and fires', async () => {
    let ltp = 95;
    const a = build({ cfg: { mode: 'shadow' }, ltp: () => ltp });
    await a.svc.evaluate(ev, T0);
    a.svc.onModuleDestroy();
    // a fresh process over the same rows
    const b = build({ cfg: { mode: 'shadow' }, ltp: () => ltp });
    b.repo.decisions.push(...a.repo.decisions);
    expect(await b.svc.resumeTriggers(new Date(T0.getTime() + 60_000))).toBe(1);
    ltp = 100;
    await b.svc.checkTriggers(new Date(T0.getTime() + 65_000));
    expect(b.repo.decisions[0]).toMatchObject({ decision: 'TAKE' });
    expect(b.judge.judge).not.toHaveBeenCalled(); // reused: judged 65 s ago
    b.svc.onModuleDestroy();
  });

  it('restart after expiry → SKIP trigger_expired at once', async () => {
    const a = build({ cfg: { mode: 'shadow' }, ltp: () => 95 });
    await a.svc.evaluate(ev, T0);
    a.svc.onModuleDestroy();
    const b = build({ cfg: { mode: 'shadow' }, ltp: () => 95 });
    b.repo.decisions.push(...a.repo.decisions);
    expect(await b.svc.resumeTriggers(new Date(T0.getTime() + 40 * 60_000))).toBe(0);
    expect(b.repo.decisions[0]).toMatchObject({ decision: 'SKIP', skipReason: 'trigger_expired' });
  });

  it('a re-emitted signal.ready never re-evaluates an armed trigger', async () => {
    const t = build({ cfg: { mode: 'shadow' }, ltp: () => 95 });
    await t.svc.evaluate(ev, T0);
    expect(await t.svc.evaluate({ ...ev, agreeCount: 3 }, T0)).toBeNull();
    expect(t.repo.decisions).toHaveLength(1);
    t.svc.onModuleDestroy();
  });
});

describe('SignalTraderService — engine SL', () => {
  beforeEach(() => {
    process.env.LIVE_TRADING_ENABLED = 'true';
    setCoreKillSwitchReader({ isOn: async () => false, isOnForPlatform: async () => false, invalidate: () => undefined });
    (sendOpsAlert as jest.Mock).mockClear();
  });
  afterAll(() => setCoreKillSwitchReader(null));

  it('"SL paid" option: engine SL used, resized within the cap, marked engine_sl, judge told', async () => {
    const t = build({
      cfg: { mode: 'shadow' },
      signal: { sl: null, entryType: 'AT' },
      engineSl: async () => ({ sl: 80, method: 'premium_pct', detail: '25% premium stop from 101' }),
    });
    const r = await t.svc.evaluate(ev, T0);
    expect(r).toMatchObject({ decision: 'TAKE' });
    const d = t.repo.decisions[0];
    expect(d.plan).toMatchObject({ slSource: 'engine', sl: 80, engineSl: { method: 'premium_pct' } });
    // (101.5 − 80) × 75 = 1612.5 per lot → 1 lot under the ₹2000 cap (signal asked 2)
    expect(d.plan).toMatchObject({ lots: 1, qty: 75 });
    const packet = (t.judge.judge.mock.calls[0] as any[])[0];
    expect(packet.plan).toMatchObject({ slSource: 'engine', engineSl: { method: 'premium_pct' } });
    expect(alerts()[0]).toMatch(/ENGINE SL: premium_pct/);
  });

  it('engine SL whose one-lot risk exceeds the cap → SKIP risk_cap (never sized up)', async () => {
    const t = build({ cfg: { mode: 'shadow' }, signal: { sl: null, entryType: 'AT' }, engineSl: async () => ({ sl: 60, method: 'level_delta', detail: 'x' }) });
    const r = await t.svc.evaluate(ev, T0);
    expect(r).toMatchObject({ decision: 'SKIP', skipReason: 'risk_cap' });
  });

  it('SIGNAL_ENGINE_SL=off → SKIP sl_present, engine not asked', async () => {
    const t = build({ cfg: { mode: 'shadow', engineSl: false }, signal: { sl: null, entryType: 'AT' } });
    const r = await t.svc.evaluate(ev, T0);
    expect(r).toMatchObject({ decision: 'SKIP', skipReason: 'sl_present' });
    expect(t.context.engineSl).not.toHaveBeenCalled();
  });
});

describe('SignalTraderService — broker margin in the funds check', () => {
  // SIGNAL_LIVE_KINDS defaults to options only; these specs send a future live on purpose.
  const futCfg = { mode: 'live' as const, limitBufferPct: 0, liveKinds: ['CE', 'PE', 'FUT'] as SignalTraderConfig['liveKinds'] };
const futSignal: Partial<SignalView> = { instrumentKind: 'FUT', strike: null, entryType: 'AT', entryLow: 25000, entryHigh: 25000, sl: 24990, qty: 1 };
  beforeEach(() => {
    process.env.LIVE_TRADING_ENABLED = 'true';
    setCoreKillSwitchReader({ isOn: async () => false, isOnForPlatform: async () => false, invalidate: () => undefined });
  });
  afterAll(() => setCoreKillSwitchReader(null));

  it('futures: the broker margin calculator answer is used (method broker)', async () => {
    const t = build({ cfg: futCfg, signal: futSignal, ltp: () => 25000, margin: async () => ({ status: true, data: { totalMarginRequired: 150000 } }) });
    await t.svc.evaluate(ev, T0);
    const funds = t.repo.decisions[0].gate.find((c: any) => c.name === 'funds');
    expect(funds.funds).toMatchObject({ method: 'broker', required: 151500 });
    const [owner, pos] = (t.funds as any).margin.mock.calls[0];
    expect(owner).toBe('owner');
    expect(pos).toMatchObject({ exchange: 'NFO', token: '222', qty: 75, tradeType: 'BUY', orderType: 'LIMIT', productType: 'INTRADAY' });
    expect(t.executor.place).toHaveBeenCalledTimes(1);
  });

  it('futures: margin call fails → 25% estimate fallback (method estimate), short → PAPER', async () => {
    const t = build({ cfg: { ...futCfg, entryRetryMin: 0 }, signal: futSignal, ltp: () => 25000, funds: 100_000, margin: async () => ({ status: false, message: 'Invalid Token' }) });
    const r = await t.svc.evaluate(ev, T0);
    const funds = t.repo.decisions[0].gate.find((c: any) => c.name === 'funds');
    expect(funds.funds.method).toBe('estimate');
    expect(funds.detail).toMatch(/broker margin unavailable: broker: Invalid Token/);
    expect(r?.decision).toBe('PAPER');
    expect(t.executor.place).not.toHaveBeenCalled();
  });

  it('option BUY never asks the margin calculator (full premium)', async () => {
    const t = build({ cfg: { mode: 'live' }, margin: async () => ({ status: true, data: { totalMarginRequired: 1 } }) });
    await t.svc.evaluate(ev, T0);
    expect((t.funds as any).margin).not.toHaveBeenCalled();
    expect(t.repo.decisions[0].gate.find((c: any) => c.name === 'funds').funds.method).toBe('premium');
  });
});

describe('SignalTraderService — BFO', () => {
  beforeEach(() => {
    process.env.LIVE_TRADING_ENABLED = 'true';
    setCoreKillSwitchReader({ isOn: async () => false, isOnForPlatform: async () => false, invalidate: () => undefined });
  });
  afterAll(() => setCoreKillSwitchReader(null));

  it('a SENSEX option resolves on BFO, is quoted and ordered on BFO, SL enforceable on BFO', async () => {
    const t = build({ cfg: { mode: 'live' }, signal: { underlying: 'SENSEX', strike: 80000, entryType: 'AT', sl: 90, qty: 1 } });
    const r = await t.svc.evaluate(ev, T0);
    expect(r).toMatchObject({ decision: 'TAKE', placed: 'PLACED' });
    expect(t.quotes.ltp).toHaveBeenCalledWith('owner', '333', 'BFO');
    const arg = (t.executor.place.mock.calls[0] as any[])[0];
    expect(arg.plan).toMatchObject({ exchange: 'BFO', tradingsymbol: 'SENSEX99OCT8000CE', lotSize: 20 });
    expect(arg.qtyUnit).toBe('units');
    expect(t.repo.decisions[0].gate.find((c: any) => c.name === 'sl_enforceable').ok).toBe(true);
  });
});

describe('SignalTraderService — keep trying a TAKE for a few minutes (owner 2026-11-09)', () => {
  // UNIONBANK: short of funds at 15:07, cash freed at 15:09. CRUDEOIL 8200 PE: ₹1.50 under the band after the judge's 54 s.
  const at: Partial<SignalView> = { entryType: 'AT', entryLow: 100, entryHigh: 100, sl: 90 };
  const later = (s: number) => new Date(T0.getTime() + s * 1000);
  beforeEach(() => {
    process.env.LIVE_TRADING_ENABLED = 'true';
    setCoreKillSwitchReader({ isOn: async () => false, isOnForPlatform: async () => false, invalidate: () => undefined });
    (sendOpsAlert as jest.Mock).mockClear();
  });
  afterAll(() => setCoreKillSwitchReader(null));

  it('short of funds: waits, and goes live when the cash arrives, without asking the judge again', async () => {
    const t = build({ cfg: { mode: 'live' }, signal: at, ltp: () => 101, funds: 500 });
    expect(await t.svc.evaluate(ev, T0)).toMatchObject({ decision: 'PENDING' });
    expect(t.repo.decisions[0]).toMatchObject({ decision: 'PENDING', status: 'PENDING' });
    expect(t.paper.open).not.toHaveBeenCalled();
    (t.funds.available as jest.Mock).mockResolvedValue(1_000_000);
    await t.svc.checkTriggers(later(30));
    expect(t.executor.place).toHaveBeenCalledTimes(1);
    expect(t.judge.judge).toHaveBeenCalledTimes(1);
    expect(t.repo.decisions[0]).toMatchObject({ decision: 'TAKE', status: 'DONE' });
    expect(t.svc.pendingIds()).toEqual([]);
    t.svc.onModuleDestroy();
  });

  it('still short when the window ends: the paper trade, as before', async () => {
    const t = build({ cfg: { mode: 'live' }, signal: at, ltp: () => 101, funds: 500 });
    await t.svc.evaluate(ev, T0);
    await t.svc.checkTriggers(later(30));
    expect(t.paper.open).not.toHaveBeenCalled();
    await t.svc.checkTriggers(later(5 * 60));
    expect(t.paper.open).toHaveBeenCalledTimes(1);
    expect(t.executor.place).not.toHaveBeenCalled();
    expect(t.repo.decisions[0]).toMatchObject({ decision: 'PAPER', skipReason: 'insufficient_funds', status: 'DONE' });
    expect(t.svc.pendingIds()).toEqual([]);
    t.svc.onModuleDestroy();
  });

  it('checks the account at most every 30 s while waiting', async () => {
    const t = build({ cfg: { mode: 'live' }, signal: at, ltp: () => 101, funds: 500 });
    await t.svc.evaluate(ev, T0);
    const before = (t.funds.available as jest.Mock).mock.calls.length;
    await t.svc.checkTriggers(later(5));
    await t.svc.checkTriggers(later(20));
    await t.svc.checkTriggers(later(29));
    expect((t.funds.available as jest.Mock).mock.calls.length - before).toBeLessThanOrEqual(1);
    t.svc.onModuleDestroy();
  });

  it('price left the band while the judge thought: waits, and enters when it comes back', async () => {
    let ltp = 101;
    const t = build({ cfg: { mode: 'live' }, signal: at, ltp: () => ltp });
    t.judge.judge.mockImplementation((async () => { ltp = 95; return { ok: true, verdict: takeVerdict, latencyMs: 10 }; }) as never);
    expect(await t.svc.evaluate(ev, T0)).toMatchObject({ decision: 'PENDING' });
    await t.svc.checkTriggers(later(30));
    expect(t.executor.place).not.toHaveBeenCalled();
    ltp = 100;
    await t.svc.checkTriggers(later(60));
    expect(t.executor.place).toHaveBeenCalledTimes(1);
    expect(t.judge.judge).toHaveBeenCalledTimes(1);
    t.svc.onModuleDestroy();
  });

  it('price never comes back: SKIP price_moved when the window ends', async () => {
    let ltp = 101;
    const t = build({ cfg: { mode: 'live' }, signal: at, ltp: () => ltp });
    t.judge.judge.mockImplementation((async () => { ltp = 95; return { ok: true, verdict: takeVerdict, latencyMs: 10 }; }) as never);
    await t.svc.evaluate(ev, T0);
    await t.svc.checkTriggers(later(5 * 60));
    expect(t.repo.decisions[0]).toMatchObject({ decision: 'SKIP', skipReason: 'price_moved', status: 'DONE' });
    expect(t.executor.place).not.toHaveBeenCalled();
    t.svc.onModuleDestroy();
  });

  it('price recovers but the cash is short at the end: paper, not a price skip', async () => {
    let ltp = 101;
    const t = build({ cfg: { mode: 'live' }, signal: at, ltp: () => ltp, funds: 500 });
    t.judge.judge.mockImplementation((async () => { ltp = 95; return { ok: true, verdict: takeVerdict, latencyMs: 10 }; }) as never);
    await t.svc.evaluate(ev, T0);
    ltp = 100;
    await t.svc.checkTriggers(later(30));
    await t.svc.checkTriggers(later(5 * 60));
    expect(t.repo.decisions[0]).toMatchObject({ decision: 'PAPER', skipReason: 'insufficient_funds' });
    t.svc.onModuleDestroy();
  });

  it('the stop was already crossed: no waiting', async () => {
    let ltp = 101;
    const t = build({ cfg: { mode: 'live' }, signal: at, ltp: () => ltp });
    t.judge.judge.mockImplementation((async () => { ltp = 89; return { ok: true, verdict: takeVerdict, latencyMs: 10 }; }) as never);
    expect(await t.svc.evaluate(ev, T0)).toMatchObject({ decision: 'SKIP', skipReason: 'price_moved' });
    expect(t.svc.pendingIds()).toEqual([]);
    t.svc.onModuleDestroy();
  });

  it('every safety check runs again: the kill switch during the wait stops the order', async () => {
    let kill = false;
    setCoreKillSwitchReader({ isOn: async () => kill, isOnForPlatform: async () => kill, invalidate: () => undefined });
    const t = build({ cfg: { mode: 'live' }, signal: at, ltp: () => 101, funds: 500 });
    await t.svc.evaluate(ev, T0);
    kill = true;
    (t.funds.available as jest.Mock).mockResolvedValue(1_000_000);
    await t.svc.checkTriggers(later(30));
    expect(t.executor.place).not.toHaveBeenCalled();
    expect(t.repo.decisions[0]).toMatchObject({ decision: 'SKIP', status: 'DONE' });
    t.svc.onModuleDestroy();
  });

  it('another channel took the same trade during the wait: no second order', async () => {
    const t = build({ cfg: { mode: 'live' }, signal: at, ltp: () => 101, funds: 500 });
    await t.svc.evaluate(ev, T0);
    t.repo.clusterTaken.mockImplementation((async (id: string) => id === 'cl1') as never);
    (t.funds.available as jest.Mock).mockResolvedValue(1_000_000);
    await t.svc.checkTriggers(later(30));
    expect(t.executor.place).not.toHaveBeenCalled();
    expect(t.repo.decisions[0]).toMatchObject({ decision: 'SKIP', skipReason: 'cluster_not_taken' });
    t.svc.onModuleDestroy();
  });

  it('never waits inside the last minutes of the session', async () => {
    const t = build({ cfg: { mode: 'live', minMinutesToClose: 300 }, signal: at, ltp: () => 101, funds: 500 });
    expect(await t.svc.evaluate(ev, T0)).not.toMatchObject({ decision: 'PENDING' });
    t.svc.onModuleDestroy();
  });

  it('SIGNAL_ENTRY_RETRY_MIN=0 is the rollback: paper at once', async () => {
    const t = build({ cfg: { mode: 'live', entryRetryMin: 0 } as never, signal: at, ltp: () => 101, funds: 500 });
    expect(await t.svc.evaluate(ev, T0)).toMatchObject({ decision: 'PAPER' });
    t.svc.onModuleDestroy();
  });

  it('restart after the window: the paper trade still opens', async () => {
    const a = build({ cfg: { mode: 'live' }, signal: at, ltp: () => 101, funds: 500 });
    await a.svc.evaluate(ev, T0);
    a.svc.onModuleDestroy();
    const b = build({ cfg: { mode: 'live' }, signal: at, ltp: () => 101, funds: 500 });
    b.repo.decisions.push(...a.repo.decisions);
    expect(await b.svc.resumeTriggers(later(10 * 60))).toBe(0);
    expect(b.paper.open).toHaveBeenCalledTimes(1);
    expect(b.repo.decisions[0]).toMatchObject({ decision: 'PAPER', skipReason: 'insufficient_funds' });
  });

  it('a re-emitted signal.ready never starts a second evaluation while waiting', async () => {
    const t = build({ cfg: { mode: 'live' }, signal: at, ltp: () => 101, funds: 500 });
    await t.svc.evaluate(ev, T0);
    expect(await t.svc.evaluate(ev, later(10))).toBeNull();
    t.svc.onModuleDestroy();
  });
});
