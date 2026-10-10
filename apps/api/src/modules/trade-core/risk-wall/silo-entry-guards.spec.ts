import { AdaptiveStopWatchService } from '../../adaptive-stop-track/services/adaptive-stop-watch.service';
import { AnandDualTrackService } from '../../anand-dual-track/services/anand-dual-track.service';
import { AutoExecutionService } from '../../auto-execution/services/auto-execution.service';
import { AutoTradeService } from '../../auto-trade/services/auto-trade.service';
import { BreakoutSwingPollerService } from '../../breakout-swing-track/services/breakout-swing-poller.service';
import { BreakoutSwingService } from '../../breakout-swing-track/services/breakout-swing.service';
import { SellFuturesService } from '../../sell-futures-track/services/sell-futures.service';
import { UngatedWatchService } from '../../ungated-track/services/ungated-watch.service';
import { WatchService } from '../../watch-monitor/services/watch.service';
import { CoreKillSwitchEntryBlockedError, setCoreKillSwitchReader, type KillSwitchReadPort } from './kill-gate';

/**
 * Owner answer 2: every silo's new-entry point refuses while the core kill switch is on,
 * and fails closed when it cannot be read. Each block names the entry point it guards.
 * Dependencies are tripwires: touching one past a refusal fails the test, and touching
 * one when the switch is off proves the call went past the guard into unchanged silo code.
 */
const make = (platformOn: boolean | Error, userOn: (u: string) => boolean = () => false) => {
  const r: KillSwitchReadPort & { isOn: jest.Mock; isOnForPlatform: jest.Mock } = {
    isOn: jest.fn(async (u: string) => userOn(u)),
    isOnForPlatform: jest.fn(async () => { if (platformOn instanceof Error) throw platformOn; return platformOn; }),
    invalidate: jest.fn(),
  };
  setCoreKillSwitchReader(r);
  return r;
};
const ON = () => make(true);
const OFF = () => make(false);
const BROKEN = () => make(new Error('db down'));
afterEach(() => { OFF(); });

/** A dependency that fails loudly if touched (except the members given). */
function tripwire(name: string, allowed: Record<string, unknown> = {}): any {
  return new Proxy(allowed, {
    get(target, prop) {
      if (prop in target) return (target as Record<string | symbol, unknown>)[prop];
      if (prop === 'then') return undefined;
      throw new Error(`tripwire: ${name}.${String(prop)} touched`);
    },
  });
}
const deps = (n: number) => Array.from({ length: n }, (_, i) => tripwire(`dep${i}`));
const construct = <T>(C: new (...a: any[]) => T, args: unknown[]): T => new C(...args);

/** The call went past the guard (it may fail later on a tripwire; it was not refused). */
async function pastGuard(p: Promise<unknown>) {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).not.toBeInstanceOf(CoreKillSwitchEntryBlockedError);
}

const alert = { symbol: 'RELIANCE', token: '2885', exchange: 'NSE', side: 'BUY', scannerName: 'Anand 100Hull >200 hull', initialPrice: 2500 } as never;

describe('watch-monitor, gated + options watch: WatchService.executeEntry (watch.service.ts:420)', () => {
  const svc = () => construct(WatchService, deps(8));
  it('refuses while the owner switch is on, touching nothing', async () => {
    const r = ON();
    expect(await svc().executeEntry('we_1')).toBeNull();
    expect(r.isOnForPlatform).toHaveBeenCalled();
  });
  it('fails closed when the switch cannot be read', async () => {
    BROKEN();
    expect(await svc().executeEntry('we_1')).toBeNull();
  });
  it('passes through when off', async () => {
    OFF();
    await expect(svc().executeEntry('we_1')).rejects.toThrow('tripwire: dep0.findById touched');
  });
});

describe.each([
  ['ungated-track: UngatedWatchService.createFromAlert (ungated-watch.service.ts:100)', () => construct(UngatedWatchService, deps(8))],
  ['adaptive-stop-track: AdaptiveStopWatchService.createFromAlert (adaptive-stop-watch.service.ts:166)', () => construct(AdaptiveStopWatchService, deps(8))],
  ['sell-futures-track: SellFuturesService.createFromAlert (sell-futures.service.ts:88)', () => construct(SellFuturesService, deps(8))],
  ['breakout-swing-track: BreakoutSwingService.createFromAlert (breakout-swing.service.ts:92)', () => construct(BreakoutSwingService, deps(4))],
])('%s', (_name, svc) => {
  it('refuses while the owner switch is on, before any silo rule runs', async () => {
    ON();
    await expect((svc() as { createFromAlert(i: never): Promise<unknown> }).createFromAlert(alert)).rejects.toBeInstanceOf(CoreKillSwitchEntryBlockedError);
  });
  it('fails closed when the switch cannot be read', async () => {
    BROKEN();
    await expect((svc() as { createFromAlert(i: never): Promise<unknown> }).createFromAlert(alert)).rejects.toBeInstanceOf(CoreKillSwitchEntryBlockedError);
  });
  it('passes through when off', async () => {
    OFF();
    await pastGuard((svc() as { createFromAlert(i: never): Promise<unknown> }).createFromAlert(alert));
  });
});

describe('breakout-swing-track: the resting-order fill in BreakoutSwingPollerService.fillQueued (breakout-swing-poller.service.ts:125)', () => {
  function poller() {
    const repo = {
      listQueued: jest.fn(async () => [{ id: 'b1', symbol: 'TCS', token: '11536', limitPrice: 100 }]),
      recordTick: jest.fn(async () => undefined),
      fill: jest.fn(async () => undefined),
    };
    const exitPrice = { resolveExitPrices: jest.fn(async () => new Map([['11536', { price: 101, fresh: true }]])) };
    const p = construct(BreakoutSwingPollerService, [repo, exitPrice]);
    const fillQueued = () => (p as unknown as { fillQueued(): Promise<void> }).fillQueued();
    return { repo, fillQueued };
  }
  it('does not fill while the owner switch is on, but still records the price', async () => {
    ON();
    const { repo, fillQueued } = poller();
    await fillQueued();
    expect(repo.fill).not.toHaveBeenCalled();
    expect(repo.recordTick).toHaveBeenCalled();
  });
  it('fails closed when the switch cannot be read', async () => {
    BROKEN();
    const { repo, fillQueued } = poller();
    await fillQueued();
    expect(repo.fill).not.toHaveBeenCalled();
  });
  it('fills as before when off', async () => {
    OFF();
    const { repo, fillQueued } = poller();
    await fillQueued();
    expect(repo.fill).toHaveBeenCalledTimes(1);
  });
});

describe('anand-dual-track: AnandDualTrackService.createEntries (anand-dual-track.service.ts:25)', () => {
  const input = { symbol: 'INFY', token: '1594', hitPrice: 1500, alertId: 'a1', scoreBreakdown: {} } as never;
  const svc = () => {
    const bumpLeadStat = jest.fn(async () => undefined);
    return { bumpLeadStat, s: construct(AnandDualTrackService, [tripwire('repo', { bumpLeadStat })]) };
  };
  it('records the lead stat, then creates no entry while the owner switch is on', async () => {
    ON();
    const { s, bumpLeadStat } = svc();
    await expect(s.createEntries(input)).resolves.toBeUndefined();
    expect(bumpLeadStat).toHaveBeenCalledWith('swing', 'INFY');
  });
  it('fails closed when the switch cannot be read', async () => {
    BROKEN();
    await expect(svc().s.createEntries(input)).resolves.toBeUndefined();
  });
  it('passes through when off', async () => {
    OFF();
    await expect(svc().s.createEntries(input)).rejects.toThrow('tripwire: repo.findActiveTradedBySymbol touched');
  });
});

describe('auto-execution: AutoExecutionService.execute (auto-execution.service.ts:70), per user', () => {
  const job = { userId: 'user_A', signal: { symbol: 'NIFTY', segment: 'INTRADAY' }, idempotencyKey: 'k1' } as never;
  let reject: jest.SpyInstance;
  beforeEach(() => {
    reject = jest.spyOn(AutoExecutionService.prototype as never, 'rejectTerminal' as never).mockResolvedValue(undefined as never);
  });
  afterEach(() => reject.mockRestore());
  const svc = () => construct(AutoExecutionService, deps(12));
  it('refuses with the existing USER_KILL_SWITCH terminal reject while that user’s switch is on', async () => {
    const r = make(false, (u) => u === 'user_A');
    await svc().execute(job);
    expect(r.isOn).toHaveBeenCalledWith('user_A');
    expect(r.isOnForPlatform).not.toHaveBeenCalled();
    expect(reject).toHaveBeenCalledWith('user_A', { symbol: 'NIFTY', segment: 'INTRADAY' }, 'k1', 'USER_KILL_SWITCH');
  });
  it('fails closed when the switch cannot be read', async () => {
    setCoreKillSwitchReader({ isOn: async () => { throw new Error('db down'); }, isOnForPlatform: async () => false, invalidate: () => undefined });
    await svc().execute(job);
    expect(reject).toHaveBeenCalledWith('user_A', expect.anything(), 'k1', 'USER_KILL_SWITCH');
  });
  it('another user’s switch does not block this user', async () => {
    make(true, (u) => u === 'user_B');
    await expect(svc().execute(job)).rejects.toThrow('tripwire: dep0.hasActive touched');
    expect(reject).not.toHaveBeenCalled();
  });
});

describe('auto-trade: AutoTradeService (auto-trade.service.ts:157, :269, :347)', () => {
  const signal = {
    id: 's1', confidenceScore: 80, side: 'BUY', entryPrice: 100, stoplossPrice: 95, targetPrice: 110, strategy: 'x',
    instrument: { symbol: 'RELIANCE', token: '2885', exchange: 'NSE' },
  };
  function svc() {
    const signalRepository = tripwire('signalRepository', {
      getActiveSignals: jest.fn(async () => [signal]),
      getSignalById: jest.fn(async () => ({ ...signal, trades: [] })),
    });
    const settingsService = tripwire('settingsService', { getSettings: jest.fn(async () => ({ autoTradeMode: 'FULLY_AUTOMATIC', maxCapitalPerTrade: 50000 })) });
    const tradeExecutionService = tripwire('tradeExecutionService');
    const s = construct(AutoTradeService, [tripwire('signalGenerator'), signalRepository, tradeExecutionService, tripwire('risk'), settingsService, tripwire('gateway'), tripwire('feed')]);
    return s;
  }
  it('the scan skips every signal while the owner switch is on', async () => {
    ON();
    const stats = await svc().processActiveSignals();
    expect(stats).toMatchObject({ processed: 1, executed: 0, skipped: 1, errors: 0 });
  });
  it('the scan fails closed when the switch cannot be read', async () => {
    BROKEN();
    expect(await svc().processActiveSignals()).toMatchObject({ executed: 0, skipped: 1, errors: 0 });
  });
  it('approval and force-execute return null and keep the approval pending while on', async () => {
    ON();
    const s = svc();
    (s as unknown as { pendingApprovals: Map<string, unknown> }).pendingApprovals.set('s1', { signal, tradeRequest: { symbol: 'RELIANCE' }, timestamp: new Date() });
    expect(await s.approveSignal('s1')).toBeNull();
    expect(s.getPendingApprovals()).toHaveLength(1);
    expect(await s.forceExecuteSignal('s1')).toBeNull();
  });
  it('passes through when off (reaches the trade engine)', async () => {
    OFF();
    const stats = await svc().processActiveSignals();
    expect(stats).toMatchObject({ executed: 0, errors: 1 }); // tradeExecutionService tripwire, caught by the scan loop
  });
});
