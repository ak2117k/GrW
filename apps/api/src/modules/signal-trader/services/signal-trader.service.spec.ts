jest.mock('../../../common/utils/ops-alert', () => ({ sendOpsAlert: jest.fn().mockResolvedValue(true) }));

import { sendOpsAlert } from '../../../common/utils/ops-alert';
import { setCoreKillSwitchReader } from '../../trade-core/risk-wall/kill-gate';
import { parseSignalTraderConfig, type SignalTraderConfig } from '../domain/signal-trader.config';
import { SIGNAL_JUDGE_SYSTEM } from '../domain/judge';
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
    channelViews: jest.fn(async (u: string) => ({ status: 'present', source: 'telegram INFO', underlying: { underlying: u, bull: 1, bear: 3, lean: 'BEAR' }, others: [] })),
    claimDecision: jest.fn(async (c: Record<string, any>) => {
      if (decisions.some((d) => d.signalId === c.signalId && d.evaluation === c.evaluation)) return null;
      const id = `d${decisions.length + 1}`;
      decisions.push({ ...c, id, status: 'PENDING' });
      return id;
    }),
    finishDecision: jest.fn(async (id: string, f: Record<string, any>) => {
      Object.assign(decisions.find((d) => d.id === id)!, f, { status: 'DONE' });
    }),
    tradesToday: jest.fn(async (_mode?: string, _now?: Date) => decisions.filter((d) => d.decision === 'TAKE').length),
    paperOnNoFunds: jest.fn(async () => true),
    claimPaperFallback: jest.fn(async (id: string, check: Record<string, any>) => {
      const d = decisions.find((x) => x.id === id);
      if (!d || d.decision !== 'TAKE') return false;
      Object.assign(d, { decision: 'PAPER', skipReason: 'insufficient_funds', gate: [...(d.gate ?? []), check] });
      return true;
    }),
    signalLossToday: jest.fn(async () => 0),
    clusterTaken: jest.fn(async () => false),
    holding: jest.fn(async () => false),
    orderForSignal: jest.fn(async () => null),
    appendThesisNote: jest.fn(async () => true),
    pendingOrders: jest.fn(async () => []),
  };
}

const takeVerdict = { verdict: 'TAKE', confidence: 80, reasons: ['OI supports'], entry: null, sl: null, targets: [], lots: null };

function build(over: { cfg?: Partial<SignalTraderConfig>; env?: Record<string, string>; judge?: any; ltp?: number | null; funds?: number | null | 'throw'; place?: any; lessons?: any; marketEvents?: any; master?: unknown[]; signal?: SignalView } = {}) {
  // liveFromIstMin 0: the specs run at any hour (the 09:45 live start has its own tests).
  const cfg = { ...parseSignalTraderConfig({ HUB_OWNER_USER_ID: 'owner' }), liveFromIstMin: 0, ...over.cfg };
  const repo = makeRepo();
  if (over.signal) repo.signal.mockResolvedValue(over.signal);
  const judge = { judge: jest.fn(over.judge ?? (async () => ({ ok: true, verdict: takeVerdict, latencyMs: 10 }))) };
  const context = { build: jest.fn(async () => ({})), nearestLevels: jest.fn(async () => null), optionDelta: jest.fn(async () => null) };
  const executor = { place: jest.fn(over.place ?? (async () => ({ kind: 'PLACED', orderRowId: 'o1', brokerOrderId: 'b1' }))), resume: jest.fn() };
  const risk = { validateTrade: jest.fn(async () => ({ allowed: true })) };
  const clock = { isOpen: () => true, minutesToClose: () => 200 };
  const master = { getInstrumentMaster: async () => over.master ?? masterRows };
  const ltp = over.ltp === undefined ? 101 : over.ltp;
  const quotes = { ltp: jest.fn(async () => ltp) };
  const fundsVal = over.funds === undefined ? 1_000_000 : over.funds;
  const funds = { available: jest.fn(async () => {
    if (fundsVal === 'throw') throw new Error('RMS down');
    return fundsVal;
  }) };
  const paper = { open: jest.fn(async () => ({ ok: true as const, tradeId: 'pt1', entryPrice: 101.5, duplicate: false })) };
  const svc = new SignalTraderService(cfg, over.env ?? LIVE_ENV, repo as never, judge as never, context as never, executor as never, risk as never, clock, master, quotes, funds, paper, over.lessons, over.marketEvents);
  return { svc, repo, judge, executor, risk, quotes, funds, paper };
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

  describe('going live (2026-11-03): allowlist + live learning', () => {
    it('SIGNAL_LIVE_UNDERLYINGS: a TAKE on a listed underlying is placed; any other is paper-traded, never sent', async () => {
      const listed = build({ cfg: { mode: 'live', liveUnderlyings: ['NIFTY', 'BANKNIFTY', 'SENSEX'] } });
      expect(await listed.svc.evaluate(ev)).toMatchObject({ decision: 'TAKE', placed: 'PLACED' });
      const other = build({ cfg: { mode: 'live', liveUnderlyings: ['BANKNIFTY'] } });
      expect(await other.svc.evaluate(ev)).toMatchObject({ decision: 'PAPER' });
      expect(other.executor.place).not.toHaveBeenCalled();
      expect(other.paper.open).toHaveBeenCalledTimes(1);
    });

    it('live + SIGNAL_PAPER_LEARN: a call the live gate refuses (trades/day used) is learning-paper-traded — even a judge TAKE is never sent', async () => {
      const t = build({ cfg: { mode: 'live', paperLearn: true } });
      t.repo.tradesToday.mockResolvedValue(3);
      expect(await t.svc.evaluate(ev)).toMatchObject({ decision: 'PAPER' });
      expect(t.executor.place).not.toHaveBeenCalled();
      expect(t.paper.open).toHaveBeenCalledTimes(1);
      const off = build({ cfg: { mode: 'live', paperLearn: false } });
      off.repo.tradesToday.mockResolvedValue(3);
      expect((await off.svc.evaluate(ev))?.skipReason).toBe('trades_today');
      expect(off.paper.open).not.toHaveBeenCalled();
    });

    it('live + SIGNAL_PAPER_LEARN: a judge SKIP opens a learning paper trade and never reaches the broker', async () => {
      const skip = async () => ({ ok: true, verdict: { verdict: 'SKIP', confidence: 60, reasons: ['thin room'], entry: null, sl: null, targets: [], lots: null }, latencyMs: 5 });
      const t = build({ cfg: { mode: 'live', paperLearn: true }, judge: skip as never });
      expect(await t.svc.evaluate(ev)).toMatchObject({ decision: 'PAPER' });
      expect(t.executor.place).not.toHaveBeenCalled();
      expect(t.paper.open).toHaveBeenCalledTimes(1);
      const off = build({ cfg: { mode: 'live', paperLearn: false }, judge: skip as never });
      expect(await off.svc.evaluate(ev)).toMatchObject({ decision: 'SKIP' });
      expect(off.paper.open).not.toHaveBeenCalled();
    });

    it('SIGNAL_LIVE_KINDS: a live TAKE on a kind off the list is paper-traded (reason recorded), never sent', async () => {
      const t = build({ cfg: { mode: 'live', liveKinds: ['FUT'] } });
      expect(await t.svc.evaluate(ev)).toMatchObject({ decision: 'PAPER' });
      expect(t.executor.place).not.toHaveBeenCalled();
      expect(t.paper.open).toHaveBeenCalledTimes(1);
      expect(t.repo.decisions[0].judge.liveRouted).toMatchObject({ reason: 'live_kind' });
      // The default (OPT) sends a CE buy.
      const opt = build({ cfg: { mode: 'live', liveKinds: parseSignalTraderConfig({}).liveKinds } });
      expect(await opt.svc.evaluate(ev)).toMatchObject({ decision: 'TAKE', placed: 'PLACED' });
    });

    it('SIGNAL_LIVE_FROM_IST: a live TAKE before 09:45 IST is paper-traded; from 09:45 it is sent; paper mode is untouched', async () => {
      const early = build({ cfg: { mode: 'live', liveFromIstMin: 9 * 60 + 45 } });
      expect(await early.svc.evaluate(ev, new Date('2026-11-04T04:10:00Z'))).toMatchObject({ decision: 'PAPER' }); // 09:40 IST
      expect(early.executor.place).not.toHaveBeenCalled();
      expect(early.repo.decisions[0].judge.liveRouted).toMatchObject({ reason: 'live_before_start' });
      const later = build({ cfg: { mode: 'live', liveFromIstMin: 9 * 60 + 45 } });
      expect(await later.svc.evaluate(ev, new Date('2026-11-04T04:15:00Z'))).toMatchObject({ decision: 'TAKE', placed: 'PLACED' }); // 09:45 IST
      const paper = build({ cfg: { mode: 'paper', liveFromIstMin: 9 * 60 + 45 } });
      expect(await paper.svc.evaluate(ev, new Date('2026-11-04T03:50:00Z'))).toMatchObject({ decision: 'PAPER' });
      expect(paper.repo.decisions[0].judge.liveRouted).toBeUndefined();
    });
  });

  it('judge timeout → SKIP judge_unavailable, no order', async () => {
    const t = build({ cfg: { mode: 'live' }, judge: async () => ({ ok: false, reason: 'judge_unavailable', detail: 'no verdict within 120 s', latencyMs: 120000 }) });
    const r = await t.svc.evaluate(ev);
    expect(r).toMatchObject({ decision: 'SKIP', skipReason: 'judge_unavailable' });
    expect(t.executor.place).not.toHaveBeenCalled();
  });

  describe('paper mode', () => {
    it('a TAKE opens a paper trade — no broker order, no funds read', async () => {
      const t = build({ cfg: { mode: 'paper' } });
      const r = await t.svc.evaluate(ev);
      expect(r).toMatchObject({ decision: 'PAPER' });
      expect(t.executor.place).not.toHaveBeenCalled();
      expect(t.funds.available).not.toHaveBeenCalled();
      expect(t.paper.open).toHaveBeenCalledTimes(1);
      expect((t.paper.open.mock.calls[0] as any[])[0]).toMatchObject({ trigger: 'paper_mode' });
      expect(t.repo.decisions[0]).toMatchObject({ decision: 'PAPER', mode: 'paper', skipReason: null });
      expect((sendOpsAlert as jest.Mock).mock.calls.at(-1)[1]).toMatch(/PAPER \(paper mode\)/);
    });

    it('a judge SKIP is a SKIP with the judge record, no paper trade', async () => {
      const t = build({ cfg: { mode: 'paper' }, judge: async () => ({ ok: true, verdict: { ...takeVerdict, verdict: 'SKIP', reasons: ['PCR against'] }, latencyMs: 5 }) });
      const r = await t.svc.evaluate(ev);
      expect(r?.decision).toBe('SKIP');
      expect(t.paper.open).not.toHaveBeenCalled();
      expect(t.repo.decisions[0].judge).toMatchObject({ verdict: 'SKIP' });
    });

    describe('learning mode (SIGNAL_PAPER_LEARN=on)', () => {
      const skipJudge = async () => ({ ok: true, verdict: { ...takeVerdict, verdict: 'SKIP', reasons: ['PCR against'] }, latencyMs: 5 });

      it('a judge SKIP is still paper-traded, the AI call kept as aiDecision, no stop on the trade', async () => {
        const t = build({ cfg: { mode: 'paper', paperLearn: true }, judge: skipJudge });
        const r = await t.svc.evaluate(ev);
        expect(r?.decision).toBe('PAPER');
        expect(t.paper.open).toHaveBeenCalledTimes(1);
        expect((t.paper.open.mock.calls[0] as any[])[0].plan).toMatchObject({ learn: true });
        expect(t.repo.decisions[0].judge).toMatchObject({ verdict: 'SKIP', aiDecision: 'SKIP', learnTaken: true, reasons: ['PCR against'] });
      });

      it('a TAKE is traded as TAKE; an unavailable judge is NONE; the risk check goes out tagged learn', async () => {
        const take = build({ cfg: { mode: 'paper', paperLearn: true } });
        await take.svc.evaluate(ev);
        expect(take.repo.decisions[0].judge).toMatchObject({ aiDecision: 'TAKE' });
        expect((take.risk.validateTrade.mock.calls[0] as any[])[0]).toMatchObject({ isPaper: true, entryTags: ['learn'] });
        const none = build({ cfg: { mode: 'paper', paperLearn: true }, judge: async () => ({ ok: false, reason: 'judge_unavailable', detail: 'timeout', latencyMs: 120000 }) });
        expect((await none.svc.evaluate(ev))?.decision).toBe('PAPER');
        expect(none.repo.decisions[0].judge).toMatchObject({ aiDecision: 'NONE' });
      });

      it('live and shadow never learn', async () => {
        const t = build({ cfg: { mode: 'shadow', paperLearn: true }, judge: skipJudge });
        expect((await t.svc.evaluate(ev))?.decision).toBe('SKIP');
      });
    });

    it('a failed hard check with a plan still asks the judge (its read is recorded on the SKIP)', async () => {
      killOn = true;
      const t = build({ cfg: { mode: 'paper' } });
      const r = await t.svc.evaluate(ev);
      expect(r?.skipReason).toBe('kill_switch');
      expect(t.judge.judge).toHaveBeenCalledTimes(1);
      expect(t.repo.decisions[0].judge).toMatchObject({ verdict: 'TAKE' });
      expect(t.paper.open).not.toHaveBeenCalled();
    });

    it('a late entry (price ran 30% past the call) is planned at the current price and judged on the room left', async () => {
      const t = build({ cfg: { mode: 'paper' }, ltp: 130 });
      await t.svc.evaluate(ev);
      expect(t.judge.judge).toHaveBeenCalledTimes(1);
      const packet = t.judge.judge.mock.calls[0][0] as { plan: { ltp: number; late: { chasePct: number; room: { needs: string; missing: string[] } } } };
      expect(packet.plan.ltp).toBe(130);
      expect(packet.plan.late).toMatchObject({ chasePct: 30, room: { needs: 'UP' } });
    });

    it('no plan (price ran past SIGNAL_LATE_MAX_PCT) → no judge call', async () => {
      const t = build({ cfg: { mode: 'paper' }, ltp: 150 });
      const r = await t.svc.evaluate(ev);
      expect(r?.skipReason).toBe('entry_tolerance');
      expect(t.judge.judge).not.toHaveBeenCalled();
    });
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
    // Telegram channels' market views on the underlying: read-only context in the packet.
    expect(packet.channelViews).toMatchObject({ status: 'present', underlying: { lean: 'BEAR' } });
    const t3 = build({ cfg: { mode: 'shadow' }, judge: weak });
    (t3.repo.channelViews as jest.Mock).mockRejectedValueOnce(new Error('relation "channel_infos" does not exist'));
    await t3.svc.evaluate({ ...ev, agreeCount: 3, conflict: true });
    expect(((t3.judge.judge.mock.calls[0] as any[])[0]).channelViews).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('channel_infos') });
  });

  it('prompt v5 packet: channel sample flag, market.noise (stated unavailable when it cannot be read)', async () => {
    const t = build({ cfg: { mode: 'shadow', judgeDefault: 'skip' } });
    (t.repo.channelStats as jest.Mock).mockResolvedValueOnce({ n: 8, right: 0, wrong: 1, rolling20Right: 5, rolling20Wrong: 2 });
    await t.svc.evaluate(ev);
    const packet = (t.judge.judge.mock.calls[0] as any[])[0];
    expect(packet.promptVersion).toBe('signal-judge-v5');
    expect(packet.channelStats).toMatchObject({ scoredCalls: 7, sessionScored: 1, sampleSufficient: false });
    expect(packet.market.noise).toMatchObject({ status: 'unavailable', reason: expect.stringMatching(/^noise units:/) });
    expect(packet.plan).toHaveProperty('optionValue');
    expect(packet).not.toHaveProperty('lessons');
  });

  describe('SIGNAL_JUDGE_DEFAULT (2026-11-04)', () => {
    const judged = (t: ReturnType<typeof build>) => t.judge.judge.mock.calls[0] as any[];

    it('skip: today exactly — the v5 system prompt, promptVersion v5, no events block', async () => {
      const t = build({ cfg: { mode: 'shadow', judgeDefault: 'skip' }, marketEvents: { listFrom: jest.fn(async () => []) } });
      await t.svc.evaluate(ev);
      const [packet, opts] = judged(t);
      expect(opts.system).toBe(SIGNAL_JUDGE_SYSTEM);
      expect(packet.promptVersion).toBe('signal-judge-v5');
      expect(packet).not.toHaveProperty('events');
    });

    it('take: the default-take prompt and v7-take; events present from the calendar', async () => {
      const fomc = { id: 'e1', scope: 'market', kind: 'fomc', key: 'US', title: 'FOMC rate decision', startsAt: new Date(), allDay: false, impact: 'high', source: 'config/market-events.json', sourceRef: null, fetchedAt: new Date() };
      const t = build({ cfg: { mode: 'shadow', judgeDefault: 'take' }, env: { ...LIVE_ENV, MARKET_EVENT_DAYS: 'off' }, marketEvents: { listFrom: jest.fn(async () => [fomc]) } });
      await t.svc.evaluate(ev);
      const [packet, opts] = judged(t);
      expect(opts.system).toMatch(/Your default is TAKE/);
      expect(opts.system).not.toMatch(/your default is SKIP/);
      expect(packet.promptVersion).toBe('signal-judge-v7-take');
      expect(packet.events).toEqual({ status: 'present', events: [expect.objectContaining({ name: 'FOMC rate decision', expectMove: true, affects: expect.arrayContaining(['NIFTY']) })] });
    });

    it('take: the calendar failing or unwired → events absent with a reason (never "no event")', async () => {
      const failing = build({ cfg: { mode: 'shadow', judgeDefault: 'take' }, marketEvents: { listFrom: jest.fn(async () => { throw new Error('db down'); }) } });
      await failing.svc.evaluate(ev);
      expect(judged(failing)[0].events).toEqual({ status: 'absent', reason: expect.stringMatching(/db down.*NOT a finding/) });
      const unwired = build({ cfg: { mode: 'shadow', judgeDefault: 'take' } });
      await unwired.svc.evaluate(ev);
      expect(judged(unwired)[0].events).toEqual({ status: 'absent', reason: expect.stringMatching(/not wired/) });
    });
  });

  it('caps.maxLossPerTrade is the underlying’s own cap: GOLD ₹7,500 (HARD_LOSS_EXIT_RUPEES_BY_UNDERLYING default), NIFTY ₹2,000', async () => {
    const nifty = build({ cfg: { mode: 'shadow' } });
    await nifty.svc.evaluate(ev);
    expect(((nifty.judge.judge.mock.calls[0] as any[])[0]).caps.maxLossPerTrade).toBe(2000);
    const gold: SignalView = {
      ...signal, underlying: 'GOLD', strike: 150000, entryLow: 566.5, entryHigh: 566.5, entryType: 'AT', sl: 560, targets: [600], qty: 1,
      rawText: 'BUY GOLD 150000 CE @ 566.5 SL 560',
    };
    const goldRow = { token: '556656', symbol: 'GOLD27NOV99150000CE', name: 'GOLD', expiry: '27NOV2099', strike: '15000000', lotsize: '1', instrumenttype: 'OPTFUT', exch_seg: 'MCX', tick_size: '50' };
    const t = build({ cfg: { mode: 'shadow' }, ltp: 566.5, master: [goldRow], signal: gold });
    await t.svc.evaluate(ev);
    expect(t.judge.judge).toHaveBeenCalledTimes(1);
    expect(((t.judge.judge.mock.calls[0] as any[])[0]).caps.maxLossPerTrade).toBe(7500);
  });

  it('self-review lessons of scope SIGNAL_JUDGE ride in the packet when the reader gives any', async () => {
    const lessons = { inject: jest.fn(() => [{ key: 'judge-the-cap-stop', text: 'Judge the cap-sized stop on its noise distance.', right: 2, wrong: 0 }]) };
    const t = build({ cfg: { mode: 'shadow' }, lessons });
    await t.svc.evaluate(ev);
    expect(lessons.inject).toHaveBeenCalledWith('SIGNAL_JUDGE');
    expect(((t.judge.judge.mock.calls[0] as any[])[0]).lessons).toEqual([expect.objectContaining({ key: 'judge-the-cap-stop' })]);
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

  describe('funds check + PAPER (no funds)', () => {
    const fundsOf = (d: Record<string, any>) => (d.gate as any[]).find((c) => c.name === 'funds');

    it('funds ok → the live order goes out; the funds check is recorded with available / required', async () => {
      const t = build({ cfg: { mode: 'live' }, funds: 50_000 });
      expect(await t.svc.evaluate(ev)).toMatchObject({ decision: 'TAKE', placed: 'PLACED' });
      expect(t.executor.place).toHaveBeenCalledTimes(1);
      expect(t.paper.open).not.toHaveBeenCalled();
      expect(fundsOf(t.repo.decisions[0]).funds).toEqual({ available: 50_000, required: 15377.25, ok: true, method: 'premium' });
    });

    it('funds short → a PAPER trade, NO broker call, decision PAPER (never counted as a TAKE), alert', async () => {
      const t = build({ cfg: { mode: 'live' }, funds: 9_000 });
      const r = await t.svc.evaluate(ev);
      expect(r).toMatchObject({ decision: 'PAPER', skipReason: 'insufficient_funds', paper: { ok: true, tradeId: 'pt1' } });
      expect(t.executor.place).not.toHaveBeenCalled();
      expect(t.paper.open).toHaveBeenCalledTimes(1);
      const arg = (t.paper.open.mock.calls[0] as any[])[0];
      expect(arg).toMatchObject({ decisionId: 'd1', trigger: 'funds_check', plan: { limitPrice: 101.5, qty: 150, sl: 90, targets: [120] } });
      const d = t.repo.decisions[0];
      expect(d).toMatchObject({ decision: 'PAPER', skipReason: 'insufficient_funds' });
      expect(fundsOf(d).funds).toMatchObject({ available: 9000, ok: false });
      // caps untouched: nothing counts as a TAKE
      expect(await t.repo.tradesToday('live', new Date())).toBe(0);
      const texts = (sendOpsAlert as jest.Mock).mock.calls.map((c) => c[1]);
      expect(texts.some((x: string) => /^PAPER \(insufficient funds\): need ₹15,377, available ₹9,000 — BUY NIFTY 25000 CE/.test(x))).toBe(true);
      expect(texts.some((x: string) => /Signal TAKE/.test(x))).toBe(false);
    });

    it('a PAPER decision is never re-evaluated', async () => {
      const t = build({ cfg: { mode: 'live' }, funds: 9_000 });
      await t.svc.evaluate(ev);
      expect(await t.svc.evaluate({ ...ev, agreeCount: 3 })).toBeNull();
      expect(t.paper.open).toHaveBeenCalledTimes(1);
    });

    it('funds unreadable → no paper; recorded unknown; the order goes as before', async () => {
      for (const funds of [null, 'throw'] as const) {
        const t = build({ cfg: { mode: 'live' }, funds });
        expect(await t.svc.evaluate(ev)).toMatchObject({ decision: 'TAKE', placed: 'PLACED' });
        expect(t.paper.open).not.toHaveBeenCalled();
        const c = fundsOf(t.repo.decisions[0]);
        expect(c).toMatchObject({ ok: null, required: false, funds: { available: null, ok: null } });
      }
    });

    it('setting off → plain SKIP insufficient_funds, no paper, no order', async () => {
      const t = build({ cfg: { mode: 'live' }, funds: 9_000 });
      t.repo.paperOnNoFunds.mockResolvedValue(false);
      expect(await t.svc.evaluate(ev)).toMatchObject({ decision: 'SKIP', skipReason: 'insufficient_funds' });
      expect(t.paper.open).not.toHaveBeenCalled();
      expect(t.executor.place).not.toHaveBeenCalled();
    });

    it('shadow mode never reads funds', async () => {
      const t = build({ cfg: { mode: 'shadow' }, funds: 1 });
      expect((await t.svc.evaluate(ev))?.decision).toBe('TAKE');
      expect(t.funds.available).not.toHaveBeenCalled();
    });

    it('broker rejects for funds → paper fallback ONCE per decision (idempotent); TAKE becomes PAPER', async () => {
      const t = build({
        cfg: { mode: 'live' },
        place: async (i: any) => {
          await i.onRejected('RMS:Margin Exceeds,Required:15377.00, Available:900.00');
          await i.onRejected('RMS:Margin Exceeds,Required:15377.00, Available:900.00');
          return { kind: 'REJECTED', orderRowId: 'o1', reason: 'RMS:Margin Exceeds' };
        },
      });
      await t.svc.evaluate(ev);
      expect(t.paper.open).toHaveBeenCalledTimes(1);
      expect((t.paper.open.mock.calls[0] as any[])[0]).toMatchObject({ trigger: 'broker_reject' });
      const d = t.repo.decisions[0];
      expect(d).toMatchObject({ decision: 'PAPER', skipReason: 'insufficient_funds' });
      expect((d.gate as any[]).some((c) => c.name === 'broker_funds_reject' && c.ok === false)).toBe(true);
      expect(await t.repo.tradesToday('live', new Date())).toBe(0);
    });

    it('a non-funds broker rejection stays a plain rejection (no paper)', async () => {
      const t = build({ cfg: { mode: 'live' }, place: async (i: any) => (await i.onRejected('Price out of circuit limit'), { kind: 'REJECTED', orderRowId: 'o1', reason: 'x' }) });
      await t.svc.evaluate(ev);
      expect(t.paper.open).not.toHaveBeenCalled();
      expect(t.repo.decisions[0].decision).toBe('TAKE');
    });
  });
});
