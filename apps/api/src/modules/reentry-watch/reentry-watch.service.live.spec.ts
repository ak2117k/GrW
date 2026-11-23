import type { Bar1m } from '../entry-engine/domain/entry-decision';
import type { EnginePaperInput } from '../entry-engine/entry-engine-paper.service';
import { parseSignalTraderConfig } from '../signal-trader/domain/signal-trader.config';
import type { PlaceInput, PlaceResult } from '../signal-trader/services/signal-executor.service';
import { istTs, niftyBars } from './domain/reentry-fixtures';
import type { ExitedPosition } from './domain/reentry-rules';
import { parseReentryWatchConfig, type ReentryWatchMode } from './reentry-watch.config';
import type { LiveCounts } from './reentry-watch.repository';
import { ReentryWatchService } from './reentry-watch.service';

/**
 * REENTRY_WATCH=live (docs/superpowers/specs/2026-11-23-reentry-live-design.md §4.2 / §6a). Fake executor, fake
 * repositories, fake funds — nothing here can reach a broker.
 */
const MIN = 60_000;
const DAY = '2026-11-05';
const LIVE_ENV = { SENTINEL_TRIGGERS_ENABLED: 'true', AI_AUTO_EXIT_ENABLED: 'true', AI_AUTO_EXIT_MODE: 'live', AI_AUTO_EXIT_USER_IDS: 'owner' };

/** The owner's REAL NIFTY CE exit at 10:01 (a trade_trackers row). */
const realExit: ExitedPosition = {
  refTable: 'trade_trackers', refId: 'tr-nifty', origin: 'REAL', symbol: 'NIFTY09NOV2624400CE', exchange: 'NFO', underlying: 'NIFTY',
  kind: 'CE', side: 'BUY', entryAt: new Date(istTs(DAY, '09:40')), exitAt: new Date(istTs(DAY, '10:01')), exitPrice: 147.15, userId: 'owner',
};
const paperExit: ExitedPosition = { ...realExit, refTable: 'trades', refId: 'p-nifty', origin: 'SIGNAL_PAPER' };

function masterRows() {
  const rows: Record<string, string>[] = [];
  for (const k of [24100, 24150, 24200, 24250, 24300, 24350, 24400, 24450, 24500, 24550]) for (const kind of ['CE', 'PE']) {
    rows.push({ token: `NIFTY${k}${kind}`, symbol: `NIFTY10NOV26${k}${kind}`, name: 'NIFTY', expiry: '10NOV2026', strike: String(k * 100), lotsize: '75', instrumenttype: 'OPTIDX', exch_seg: 'NFO', tick_size: '5' });
  }
  return rows;
}

type JudgeOut = { ok: boolean; mode: string; decision?: string; open: boolean };

interface Opts {
  mode?: ReentryWatchMode;
  exits?: ExitedPosition[];
  bars?: Bar1m[];
  /** Option LTP: 100 ⇒ NIFTY 1 lot risk 25 × 75 = ₹1,875 (fits ₹2,000); 150 ⇒ ₹2,812 (over). */
  ltp?: number;
  judge?: JudgeOut | null;
  counts?: Partial<LiveCounts> | 'throw' | (() => Partial<LiveCounts>);
  /** The injected clock's now() (absent = the clock has no now(), as before). */
  now?: () => Date;
  /** Runs inside the AI judge call / the option LTP read (time passing during those awaits). */
  onJudge?: () => void;
  onLtp?: () => void;
  pending?: unknown[];
  /** The signal trader's env (its mode decides who resumes PLACED rows after a restart). */
  signalEnv?: Record<string, string>;
  openOrInFlight?: boolean | 'throw';
  lossToday?: number | 'throw';
  funds?: number | null;
  place?: (i: PlaceInput) => Promise<PlaceResult>;
  env?: Record<string, string>;
}

function make(o: Opts = {}) {
  const bars = o.bars ?? niftyBars();
  let opened = 0;
  let placedLive = 0;
  const repo = {
    exitsSince: jest.fn(async () => o.exits ?? [realExit]),
    reentriesSince: jest.fn(async () => opened),
    openOnUnderlying: jest.fn(async () => opened),
    reentriesOf: jest.fn(async () => ({ count: opened, lastExitAt: null })),
    insertDecision: jest.fn(async () => undefined),
    settleDecision: jest.fn(async () => undefined),
    liveCountsFor: jest.fn(async (): Promise<LiveCounts> => {
      if (o.counts === 'throw') throw new Error('db down');
      const extra = typeof o.counts === 'function' ? o.counts() : o.counts ?? {};
      return { reentriesOfWatch: opened + placedLive, liveToday: placedLive, liveLossesToday: 0, ...extra };
    }),
    underlyingOpenOrInFlight: jest.fn(async () => {
      if (o.openOrInFlight === 'throw') throw new Error('db down');
      return (o.openOrInFlight ?? false) || placedLive > 0;
    }),
    settleLiveDecision: jest.fn(async () => undefined),
    pendingLiveReentryOrders: jest.fn(async (_d: Date, _s: readonly string[]) => o.pending ?? []),
  };
  const engineRepo = {
    hubBars: jest.fn(async () => [] as Bar1m[]),
    tableBars: jest.fn(async (_e: string, _t: string, from: Date, to: Date) => bars.filter((b) => b.ts >= from.getTime() && b.ts <= to.getTime())),
    strikeLiquidity: jest.fn(async () => new Map()),
  };
  const signalRepo = {
    nearestFuture: jest.fn(async () => null),
    signalLossToday: jest.fn(async () => {
      if (o.lossToday === 'throw') throw new Error('db down');
      return o.lossToday ?? 0;
    }),
  };
  const oi = { input: jest.fn(async () => { throw new Error('no chain'); }) };
  const paper = {
    open: jest.fn(async (_i: EnginePaperInput) => {
      opened++;
      return { ok: true as const, tradeId: `t${opened}`, entryPrice: o.ltp ?? 100 };
    }),
  };
  const clock = {
    isOpen: jest.fn(() => true),
    minutesToClose: jest.fn((_x: string, at?: Date) => Math.round((istTs(DAY, '15:30') - (at ?? new Date()).getTime()) / MIN)),
    ...(o.now ? { now: o.now } : {}),
  };
  const master = { getInstrumentMaster: jest.fn(async () => masterRows()) };
  const quotes = { ltp: jest.fn(async () => (o.onLtp?.(), o.ltp ?? 100)) };
  const alert = jest.fn(async (_k: string, _t: string) => true);
  const j = o.judge === undefined ? { ok: true, mode: 'on', decision: 'ENTER', open: true } : o.judge;
  const judge = j === null ? undefined : {
    judge: jest.fn(async () => {
      o.onJudge?.();
      return j.ok
        ? { ok: true, mode: j.mode, verdict: { decision: j.decision ?? 'ENTER' }, latencyMs: 1, open: j.open, note: `judge ${j.mode} ${j.decision}` }
        : { ok: false, mode: j.mode, reason: 'timeout', latencyMs: 1, open: j.open, note: `judge ${j.mode} failed` };
    }),
  };
  const executor = {
    resume: jest.fn(async () => undefined),
    place: jest.fn(async (i: PlaceInput): Promise<PlaceResult> => {
      if (o.place) return o.place(i);
      placedLive++;
      return { kind: 'PLACED', orderRowId: `so${placedLive}`, brokerOrderId: `B${placedLive}` };
    }),
  };
  const funds = { available: jest.fn(async () => (o.funds === undefined ? 500_000 : o.funds)) };
  const svc = new ReentryWatchService(
    parseReentryWatchConfig({ REENTRY_WATCH: o.mode ?? 'live', ...(o.env ?? {}) }),
    { ...parseSignalTraderConfig(o.signalEnv ?? {}), ownerUserId: 'owner' },
    clock, master, quotes, repo as never, engineRepo as never, signalRepo as never, oi as never, paper as never, alert,
    judge as never, executor as never, funds as never, LIVE_ENV,
  );
  return { svc, repo, paper, alert, executor, judge, signalRepo, counters: () => ({ opened, placedLive }) };
}

async function session(svc: ReentryWatchService, from: string, to: string) {
  for (let t = istTs(DAY, from); t <= istTs(DAY, to); t += 2 * MIN) await svc.run(new Date(t));
}

type LiveSettle = { mode?: string; limit?: string | null; detail?: string | null; signalOrderId?: string | null; tradeId?: string | null; note?: string | null };
const liveSettles = (repo: ReturnType<typeof make>['repo']) => repo.settleLiveDecision.mock.calls.map((c) => (c as unknown as [string, LiveSettle])[1]);
const limitsStored = (repo: ReturnType<typeof make>['repo']) => liveSettles(repo).map((s) => s.limit).filter((l): l is string => !!l);

describe('ReentryWatchService — REENTRY_WATCH=live', () => {
  const prev = process.env.LIVE_TRADING_ENABLED;
  beforeEach(() => {
    process.env.LIVE_TRADING_ENABLED = 'true';
  });
  afterAll(() => {
    if (prev === undefined) delete process.env.LIVE_TRADING_ENABLED;
    else process.env.LIVE_TRADING_ENABLED = prev;
  });

  it('config: live is a mode; anything unknown is still paper', () => {
    expect(parseReentryWatchConfig({ REENTRY_WATCH: 'live' }).mode).toBe('live');
    expect(parseReentryWatchConfig({ REENTRY_WATCH: 'LIVE!' }).mode).toBe('paper');
  });

  it('happy path: a REAL exit, judge ENTER (on) ⇒ ONE live LIMIT order (source reentry + watch key), decision row live, one alert, no paper', async () => {
    const { svc, repo, paper, alert, executor } = make();
    await session(svc, '10:03', '13:00');
    expect(executor.place).toHaveBeenCalledTimes(1);
    const i = executor.place.mock.calls[0][0];
    expect(i).toMatchObject({ ownerUserId: 'owner', source: 'reentry', reentryWatchKey: 'trade_trackers:tr-nifty', channel: 'reentry-watch' });
    expect(i.plan).toMatchObject({ exchange: 'NFO', side: 'BUY', lots: 1, qty: 75 });
    expect(i.plan.tradingsymbol).toMatch(/^NIFTY10NOV26\d+CE$/);
    // The decision id is the reentry_watch_decisions row id (unique per intent; the executor claims it first).
    const sigRow = repo.insertDecision.mock.calls.map((c) => (c as unknown as [{ id: string; action: string; mode: string }])[0]).find((r) => r.action === 'SIGNAL')!;
    expect(i.decisionId).toBe(sigRow.id);
    // The row is 'paper' until an order is actually sent; the settle then marks it 'live' with its order row (§4.4).
    expect(sigRow.mode).toBe('paper');
    expect(repo.settleLiveDecision).toHaveBeenCalledWith(sigRow.id, expect.objectContaining({ mode: 'live', signalOrderId: 'so1' }));
    expect(paper.open).not.toHaveBeenCalled();
    const liveAlerts = alert.mock.calls.filter((c) => c[0].startsWith('reentry-live:'));
    expect(liveAlerts).toHaveLength(1);
    expect(liveAlerts[0][1]).toMatch(/^Re-entry \(LIVE\): NIFTY CE same direction/);
    // The in-flight order holds the underlying: later ticks WAIT, nothing more is sent or opened.
    expect(executor.place).toHaveBeenCalledTimes(1);
  });

  it('LIVE_TRADING_ENABLED off ⇒ nothing sent, paper with limit MODE', async () => {
    process.env.LIVE_TRADING_ENABLED = 'false';
    const { svc, repo, paper, executor } = make();
    await session(svc, '10:03', '11:30');
    expect(executor.place).not.toHaveBeenCalled();
    expect(paper.open).toHaveBeenCalledTimes(1);
    expect(limitsStored(repo)).toContain('MODE');
  });

  it.each<[string, Opts, string]>([
    ['judge observe', { judge: { ok: true, mode: 'observe', decision: 'ENTER', open: true } }, 'JUDGE'],
    ['judge call failed', { judge: { ok: false, mode: 'on', open: true } }, 'JUDGE'],
    ['no judge wired', { judge: null }, 'JUDGE'],
    ['per-trade cap (4 used)', { counts: { reentriesOfWatch: 4 } }, 'CAP'],
    ['day cap (6 live today)', { counts: { liveToday: 6 } }, 'MAX_PER_DAY'],
    ['loss stop (3 losses)', { counts: { liveLossesToday: 3 } }, 'LOSS_STOP'],
    ['daily real-money stop', { lossToday: 10_000 }, 'DAILY_LOSS_STOP'],
    ['counts unreadable', { counts: 'throw' }, 'UNKNOWN_INPUT'],
    ['signal loss unreadable', { lossToday: 'throw' }, 'UNKNOWN_INPUT'],
    ['open/in-flight unreadable', { openOrInFlight: 'throw' }, 'UNKNOWN_INPUT'],
    ['risk over ₹2,000 (NFO, no mini)', { ltp: 150 }, 'RISK_OVER_LIMIT'],
    ['funds short', { funds: 1_000 }, 'NO_FUNDS'],
    ['funds unreadable', { funds: null }, 'NO_FUNDS'],
  ])('%s ⇒ no live order; the limit is stored', async (_name, opts, limit) => {
    const { svc, repo, paper, executor } = make(opts);
    await session(svc, '10:03', '11:30');
    expect(executor.place).not.toHaveBeenCalled();
    if (limit === 'CAP') {
      // The per-trade cap (live + paper together, 4) ends the watch in the rules: no SIGNAL, nothing opened.
      expect(paper.open).not.toHaveBeenCalled();
      const cats = repo.insertDecision.mock.calls.map((c) => (c as unknown as [{ category: string }])[0].category);
      expect(cats).toContain('cap-original');
      return;
    }
    expect(limitsStored(repo)).toContain(limit);
    // A gate refusal still opens the paper re-entry exactly as paper mode (except the judge declining, which opens nothing).
    if (limit !== 'JUDGE' || opts.judge?.open) expect(paper.open).toHaveBeenCalledTimes(1);
  });

  it('funds unreadable is never live (the size reads it as unknown)', async () => {
    const { svc, executor } = make({ funds: null });
    await session(svc, '10:03', '11:30');
    expect(executor.place).not.toHaveBeenCalled();
  });

  it('judge declines (on, SKIP) ⇒ nothing opened, the JUDGE limit stored', async () => {
    const { svc, repo, paper, executor } = make({ judge: { ok: true, mode: 'on', decision: 'SKIP', open: false } });
    await session(svc, '10:03', '13:00');
    expect(executor.place).not.toHaveBeenCalled();
    expect(paper.open).not.toHaveBeenCalled();
    expect(liveSettles(repo)[0]).toMatchObject({ mode: 'paper', limit: 'JUDGE' });
  });

  it('LOSS_STOP alerts the owner once a day, however many signals it blocks', async () => {
    const second: ExitedPosition = { ...realExit, refId: 'tr-nifty-2' };
    const { svc, alert } = make({ exits: [realExit, second], counts: { liveLossesToday: 3 } });
    await session(svc, '10:03', '13:00');
    expect(alert.mock.calls.filter((c) => c[0].startsWith('reentry-live-stop:'))).toHaveLength(1);
  });

  it('outside the live window (REENTRY_LIVE_FROM_IST=12:30, signal ~10:1x) ⇒ TIME_WINDOW, paper opened', async () => {
    const { svc, repo, paper, executor } = make({ env: { REENTRY_LIVE_FROM_IST: '12:30' } });
    await session(svc, '10:03', '12:00');
    expect(executor.place).not.toHaveBeenCalled();
    expect(limitsStored(repo)).toEqual(['TIME_WINDOW']);
    expect(paper.open).toHaveBeenCalledTimes(1);
  });

  it('executor DUPLICATE ⇒ nothing more: no paper twin, no alert', async () => {
    const { svc, repo, paper, alert, executor } = make({ place: async () => ({ kind: 'DUPLICATE' }) });
    await svc.run(new Date(istTs(DAY, '10:03')));
    await session(svc, '10:05', '11:30');
    expect(executor.place).toHaveBeenCalled();
    expect(paper.open).not.toHaveBeenCalled();
    expect(alert.mock.calls.filter((c) => c[0].startsWith('reentry-live:'))).toHaveLength(0);
    expect(liveSettles(repo).some((s) => /already has an order/.test(String(s.note)))).toBe(true);
  });

  it('REJECTED for funds ⇒ the paper fallback once (NO_FUNDS, broker text)', async () => {
    const { svc, repo, paper, executor } = make({
      place: async (i) => {
        await i.onRejected?.('Insufficient funds: margin shortfall');
        return { kind: 'REJECTED', orderRowId: 'so1', reason: 'Insufficient funds: margin shortfall' };
      },
    });
    await session(svc, '10:03', '13:00');
    expect(executor.place).toHaveBeenCalledTimes(1);
    expect(paper.open).toHaveBeenCalledTimes(1);
    expect(liveSettles(repo)).toEqual(expect.arrayContaining([expect.objectContaining({ mode: 'paper', limit: 'NO_FUNDS', tradeId: 't1' })]));
  });

  it('REJECTED for another reason ⇒ no paper twin, the broker reason stored', async () => {
    const { svc, repo, paper } = make({ place: async () => ({ kind: 'REJECTED', orderRowId: 'so1', reason: 'RMS: price band' }) });
    await session(svc, '10:03', '13:00');
    expect(paper.open).not.toHaveBeenCalled();
    expect(liveSettles(repo)).toEqual(expect.arrayContaining([expect.objectContaining({ signalOrderId: 'so1', detail: expect.stringContaining('RMS: price band') })]));
  });

  it('executor throws ⇒ order state unknown: never a paper twin, never a retry', async () => {
    const { svc, repo, paper, executor } = make({ place: async () => { throw new Error('socket hang up'); } });
    await session(svc, '10:03', '13:00');
    expect(executor.place).toHaveBeenCalledTimes(1);
    expect(paper.open).not.toHaveBeenCalled();
    expect(limitsStored(repo)).toContain('UNKNOWN_INPUT');
  });

  it('BLOCKED at send (kill switch) ⇒ nothing sent, paper with MODE', async () => {
    const { svc, repo, paper } = make({ place: async () => ({ kind: 'BLOCKED', orderRowId: 'so1', reason: 'core kill switch engaged' }) });
    await session(svc, '10:03', '13:00');
    expect(paper.open).toHaveBeenCalledTimes(1);
    expect(limitsStored(repo)).toContain('MODE');
  });

  it('a PAPER-source watch in live mode stays paper: no live reads, no order', async () => {
    const { svc, repo, paper, executor } = make({ exits: [paperExit] });
    await session(svc, '10:03', '11:30');
    expect(executor.place).not.toHaveBeenCalled();
    expect(repo.liveCountsFor).not.toHaveBeenCalled();
    expect(repo.settleLiveDecision).not.toHaveBeenCalled();
    expect(paper.open).toHaveBeenCalledTimes(1);
  });

  it('mode paper: a REAL exit is paper exactly as before (no live reads, no order)', async () => {
    const { svc, repo, paper, executor } = make({ mode: 'paper' });
    await session(svc, '10:03', '11:30');
    expect(executor.place).not.toHaveBeenCalled();
    expect(repo.liveCountsFor).not.toHaveBeenCalled();
    expect(repo.underlyingOpenOrInFlight).not.toHaveBeenCalled();
    expect(repo.settleLiveDecision).not.toHaveBeenCalled();
    expect(paper.open).toHaveBeenCalledTimes(1);
  });

  it('§6a.3d cooldown: a closed LIVE re-entry holds the watch 10 min after its own exit (not just paper exits)', async () => {
    const liveExit = new Date(istTs(DAY, '12:55'));
    const { svc, repo, executor } = make({ counts: { lastLiveExitAt: liveExit } });
    await session(svc, '10:03', '13:30');
    expect(executor.place).toHaveBeenCalledTimes(1);
    const sig = repo.insertDecision.mock.calls.map((c) => (c as unknown as [{ action: string; at: Date }])[0]).find((r) => r.action === 'SIGNAL')!;
    expect(sig.at.getTime()).toBeGreaterThanOrEqual(liveExit.getTime() + 10 * MIN);
    const cats = repo.insertDecision.mock.calls.map((c) => (c as unknown as [{ category: string }])[0].category);
    expect(cats).toContain('cooldown');
  });

  it('live mode: rows of a PAPER-source watch are stored as mode paper (what happened, not the switch)', async () => {
    const { svc, repo } = make({ exits: [paperExit] });
    await session(svc, '10:03', '11:30');
    const modes = repo.insertDecision.mock.calls.map((c) => (c as unknown as [{ mode: string }])[0].mode);
    expect(modes.length).toBeGreaterThan(0);
    expect(new Set(modes)).toEqual(new Set(['paper']));
  });

  it('a live-eligible watch is not stopped by the paper day cap (5) — the live day cap applies instead', async () => {
    const { svc, repo, executor } = make();
    repo.reentriesSince.mockResolvedValue(5);
    await session(svc, '10:03', '11:30');
    expect(executor.place).toHaveBeenCalledTimes(1);
  });
});

// ---- Review fixes (2026-11-23) ----

/** A session whose clock.now() follows the run time unless a test moves it (time passing inside an await). */
function steppedClock() {
  const st = { runAt: 0, jumpTo: null as number | null };
  return {
    st,
    now: () => new Date(st.jumpTo ?? st.runAt),
    async session(svc: ReentryWatchService, from: string, to: string) {
      for (let t = istTs(DAY, from); t <= istTs(DAY, to); t += 2 * MIN) {
        st.runAt = t;
        st.jumpTo = null;
        await svc.run(new Date(t));
      }
    },
  };
}

describe('ReentryWatchService — LIVE review fixes', () => {
  const prev = process.env.LIVE_TRADING_ENABLED;
  beforeEach(() => {
    process.env.LIVE_TRADING_ENABLED = 'true';
  });
  afterAll(() => {
    if (prev === undefined) delete process.env.LIVE_TRADING_ENABLED;
    else process.env.LIVE_TRADING_ENABLED = prev;
  });

  // Fix 1 (CRITICAL): another user's real exit never trades the owner's account.
  it.each<[string, ExitedPosition]>([
    ['another user', { ...realExit, refId: 'tr-other', userId: 'someone-else' }],
    ['no user on the row', { ...realExit, refId: 'tr-nouser', userId: null }],
    ['user absent', (() => { const { userId: _u, ...rest } = realExit; return { ...rest, refId: 'tr-absent' }; })()],
  ])("a REAL exit of %s in live mode is watched exactly as in paper mode: no live reads, no order, the paper re-entry", async (_n, exit) => {
    const { svc, repo, paper, executor } = make({ exits: [exit] });
    await session(svc, '10:03', '11:30');
    expect(executor.place).not.toHaveBeenCalled();
    expect(repo.liveCountsFor).not.toHaveBeenCalled();
    expect(repo.underlyingOpenOrInFlight).not.toHaveBeenCalled();
    expect(repo.settleLiveDecision).not.toHaveBeenCalled();
    expect(paper.open).toHaveBeenCalledTimes(1);
  });

  it('the owner\'s REAL exit still goes live (the control for the case above)', async () => {
    const { svc, executor } = make({ exits: [realExit] });
    await session(svc, '10:03', '11:30');
    expect(executor.place).toHaveBeenCalledTimes(1);
  });

  // Fix 2 (MAJOR): the gate reads the clock AFTER the 10-20 s judge call, not the run's start time.
  it('the clock passes 15:00 during the AI judge call ⇒ no order, paper with TIME_WINDOW', async () => {
    const c = steppedClock();
    const { svc, repo, paper, executor } = make({ now: c.now, onJudge: () => { c.st.jumpTo = istTs(DAY, '15:01'); } });
    await c.session(svc, '10:03', '11:30');
    expect(executor.place).not.toHaveBeenCalled();
    expect(limitsStored(repo)).toEqual(['TIME_WINDOW']);
    expect(liveSettles(repo).find((s) => s.limit)!.detail).toMatch(/15:01 IST/);
    expect(paper.open).toHaveBeenCalledTimes(1);
  });

  it('the clock passes 15:00 after the gate (during the contract / LTP reads) ⇒ re-checked before the order: no order, TIME_WINDOW', async () => {
    const c = steppedClock();
    const { svc, repo, executor } = make({ now: c.now, onLtp: () => { c.st.jumpTo = istTs(DAY, '15:01'); } });
    await c.session(svc, '10:03', '11:30');
    expect(executor.place).not.toHaveBeenCalled();
    expect(limitsStored(repo)).toContain('TIME_WINDOW');
  });

  it('a clock that stays inside the window still places (the re-check does not block a normal order)', async () => {
    const c = steppedClock();
    const { svc, executor } = make({ now: c.now });
    await c.session(svc, '10:03', '11:30');
    expect(executor.place).toHaveBeenCalledTimes(1);
  });

  // Fix 4 (MINOR): the counts are re-read after the judge, right before the gate decision.
  it('another live re-entry lands during the judge call (6 live today after it) ⇒ no order, MAX_PER_DAY', async () => {
    let judged = false;
    const { svc, repo, executor } = make({ onJudge: () => { judged = true; }, counts: () => (judged ? { liveToday: 6 } : {}) });
    await session(svc, '10:03', '11:30');
    expect(executor.place).not.toHaveBeenCalled();
    expect(limitsStored(repo)).toContain('MAX_PER_DAY');
  });

  it('a position opens on the underlying during the judge call ⇒ no order, UNDERLYING_OPEN', async () => {
    let judged = false;
    const { svc, repo, executor } = make({ onJudge: () => { judged = true; } });
    repo.underlyingOpenOrInFlight.mockImplementation(async () => judged);
    await session(svc, '10:03', '11:30');
    expect(executor.place).not.toHaveBeenCalled();
    expect(limitsStored(repo)).toContain('UNDERLYING_OPEN');
  });

  // Fix 5 (MINOR, real money): restart recovery of live re-entry orders.
  describe('onApplicationBootstrap — resume live re-entry orders after a restart', () => {
    const prevBoot = process.env.BOOT_JOBS;
    afterEach(() => {
      if (prevBoot === undefined) delete process.env.BOOT_JOBS;
      else process.env.BOOT_JOBS = prevBoot;
    });
    const row = { id: 'so1', brokerOrderId: 'B1', orderTag: 'sigabc', userId: 'owner', exchange: 'NFO', token: '1', tradingsymbol: 'X', side: 'BUY', qty: 75, lots: 1, limitPrice: 100, sl: 75, targets: [] };

    it("signal trader NOT live (it resumes nothing): today's PLACED + UNCERTAIN re-entry rows are followed (fill-wait cancel, fills settled)", async () => {
      const { svc, repo, executor } = make({ pending: [row], signalEnv: { SIGNAL_TRADING: 'paper' } });
      await svc.onApplicationBootstrap();
      expect(repo.pendingLiveReentryOrders).toHaveBeenCalledWith(expect.any(Date), ['PLACED', 'UNCERTAIN']);
      expect(executor.resume).toHaveBeenCalledWith([row], expect.any(Number));
    });

    it('signal trader live (it already resumes every PLACED row, any source): only UNCERTAIN re-entry rows here — never followed twice', async () => {
      const { svc, repo, executor } = make({ pending: [row], signalEnv: { SIGNAL_TRADING: 'live' } });
      await svc.onApplicationBootstrap();
      expect(repo.pendingLiveReentryOrders).toHaveBeenCalledWith(expect.any(Date), ['UNCERTAIN']);
      expect(executor.resume).toHaveBeenCalledTimes(1);
    });

    it('resumes even after a rollback to paper (a resting live order must still be cancelled / settled)', async () => {
      const { svc, executor } = make({ mode: 'paper', pending: [row] });
      await svc.onApplicationBootstrap();
      expect(executor.resume).toHaveBeenCalledWith([row], expect.any(Number));
    });

    it('nothing pending ⇒ nothing resumed; BOOT_JOBS=false ⇒ nothing read', async () => {
      const a = make({ pending: [] });
      await a.svc.onApplicationBootstrap();
      expect(a.executor.resume).not.toHaveBeenCalled();
      process.env.BOOT_JOBS = 'false';
      const b = make({ pending: [row] });
      await b.svc.onApplicationBootstrap();
      expect(b.repo.pendingLiveReentryOrders).not.toHaveBeenCalled();
      expect(b.executor.resume).not.toHaveBeenCalled();
    });
  });
});
