// apps/api/src/modules/sentinel-executor/services/sentinel-exit-poller.service.spec.ts
import { Logger } from '@nestjs/common';
import { SentinelExitPoller, AI_EXIT_POLL_MS, EXIT_FILL_SETTLE_MS, EXIT_OUTCOME_MS } from './sentinel-exit-poller.service';
import { CLAIM_STALE_MS, SECOND_SWEEP_MS } from '../domain/claim-timing';

const ENV_KEYS = ['AI_AUTO_EXIT_ENABLED', 'AI_AUTO_EXIT_MODE', 'AI_AUTO_EXIT_USER_IDS', 'AI_AUTO_EXIT_QTY_UNITS', 'BOOT_JOBS'];
function setEnv(e: Record<string, string>) {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, e);
}
function make() {
  const repo = { pendingVerdicts: jest.fn().mockResolvedValue([]), sweepInterrupted: jest.fn().mockResolvedValue(0) };
  const executor = { process: jest.fn().mockResolvedValue({ status: 'SKIPPED' }) };
  const settler = { runOnce: jest.fn().mockResolvedValue(undefined) };
  const outcomes = { runOnce: jest.fn().mockResolvedValue(undefined) };
  return { repo, executor, settler, outcomes, poller: new SentinelExitPoller(repo as never, executor as never, settler as never, outcomes as never) };
}

describe('SentinelExitPoller', () => {
  afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); setEnv({}); });

  it.each([
    ['disabled (default)', {}],
    ['AI_AUTO_EXIT_ENABLED=false', { AI_AUTO_EXIT_ENABLED: 'false', AI_AUTO_EXIT_USER_IDS: 'owner', AI_AUTO_EXIT_MODE: 'live' }],
    ['BOOT_JOBS=false', { AI_AUTO_EXIT_ENABLED: 'true', AI_AUTO_EXIT_USER_IDS: 'owner', BOOT_JOBS: 'false' }],
    ['enabled with an empty allow-list', { AI_AUTO_EXIT_ENABLED: 'true' }],
  ])('%s → no timer, no query, no executor call', async (_n, env) => {
    jest.useFakeTimers();
    setEnv(env as Record<string, string>);
    const { poller, repo, executor, settler, outcomes } = make();
    poller.onModuleInit();
    expect(jest.getTimerCount()).toBe(0);
    expect(settler.runOnce).not.toHaveBeenCalled();
    expect(outcomes.runOnce).not.toHaveBeenCalled();
    jest.advanceTimersByTime(10 * AI_EXIT_POLL_MS);
    await Promise.resolve();
    // Even a direct call does nothing when the poller never started.
    await poller.runOnce();
    expect(repo.pendingVerdicts).not.toHaveBeenCalled();
    expect(repo.sweepInterrupted).not.toHaveBeenCalled();
    expect(executor.process).not.toHaveBeenCalled();
    poller.onModuleDestroy();
  });

  it('enabled: sweeps at start and again after the stale bound, polls every 5 s with a 2× age look-back', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-12T10:00:00Z'));
    setEnv({ AI_AUTO_EXIT_ENABLED: 'true', AI_AUTO_EXIT_USER_IDS: 'owner' });
    const { poller, repo } = make();
    poller.onModuleInit();
    await Promise.resolve();
    expect(repo.sweepInterrupted).toHaveBeenCalledWith(new Date(new Date('2026-10-12T10:00:00Z').getTime() - CLAIM_STALE_MS));
    jest.advanceTimersByTime(AI_EXIT_POLL_MS);
    await Promise.resolve();
    expect(repo.pendingVerdicts).toHaveBeenCalledWith(['owner'], new Date('2026-10-12T09:57:05Z'), 5);
    jest.advanceTimersByTime(SECOND_SWEEP_MS - AI_EXIT_POLL_MS - 1);
    expect(repo.sweepInterrupted).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1);
    expect(repo.sweepInterrupted).toHaveBeenCalledTimes(2);
    poller.onModuleDestroy();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('the ENABLED line names the mode and the per-exchange quantity units (R16)', () => {
    jest.useFakeTimers();
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    setEnv({ AI_AUTO_EXIT_ENABLED: 'true', AI_AUTO_EXIT_USER_IDS: 'owner', AI_AUTO_EXIT_QTY_UNITS: 'MCX:lots' });
    const { poller } = make();
    poller.onModuleInit();
    const line = warn.mock.calls.map((c) => String(c[0])).find((l) => l.includes('ENABLED'));
    expect(line).toContain('mode=dry-run');
    expect(line).toContain('qty-units=NFO:units,BFO:units,MCX:lots');
    expect(line).toContain('cancel-protective=off');
    poller.onModuleDestroy();
  });

  it('enabled: logs the exit-discipline config line and warns each config problem', () => {
    jest.useFakeTimers();
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    setEnv({ AI_AUTO_EXIT_ENABLED: 'true', AI_AUTO_EXIT_USER_IDS: 'owner' });
    process.env.GATE_CLOSE_MIN = '999';
    try {
      const { poller } = make();
      poller.onModuleInit();
      const lines = warn.mock.calls.map((c) => String(c[0]));
      expect(lines).toContain('[exit-discipline] GATE_CLOSE_MIN=999 is out of range — using 10');
      expect(lines.find((l) => l.startsWith('[exit-discipline] ON '))).toContain('floorArmN=1.5');
      poller.onModuleDestroy();
    } finally {
      delete process.env.GATE_CLOSE_MIN;
    }
  });

  it('processes verdicts sequentially, oldest first, and a failing verdict does not stop the rest', async () => {
    setEnv({ AI_AUTO_EXIT_ENABLED: 'true', AI_AUTO_EXIT_USER_IDS: 'owner' });
    const { poller, repo, executor } = make();
    repo.pendingVerdicts.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
    executor.process.mockRejectedValueOnce(new Error('db blip')).mockResolvedValueOnce({ status: 'DRY_RUN' });
    poller.onModuleInit();
    await poller.runOnce();
    expect(executor.process.mock.calls.map((c) => c[0].id)).toEqual(['a', 'b']);
    poller.onModuleDestroy();
  });

  it('is single-flight: an overlapping pass does nothing', async () => {
    setEnv({ AI_AUTO_EXIT_ENABLED: 'true', AI_AUTO_EXIT_USER_IDS: 'owner' });
    const { poller, repo } = make();
    let release!: () => void;
    repo.pendingVerdicts.mockReturnValueOnce(new Promise((r) => { release = () => r([]); }));
    poller.onModuleInit();
    const first = poller.runOnce();
    await poller.runOnce();
    expect(repo.pendingVerdicts).toHaveBeenCalledTimes(1);
    release();
    await first;
    await poller.runOnce();
    expect(repo.pendingVerdicts).toHaveBeenCalledTimes(2);
    poller.onModuleDestroy();
  });

  it('a failing poll query is logged and the next pass still runs', async () => {
    setEnv({ AI_AUTO_EXIT_ENABLED: 'true', AI_AUTO_EXIT_USER_IDS: 'owner' });
    const { poller, repo } = make();
    repo.pendingVerdicts.mockRejectedValueOnce(new Error('db down'));
    poller.onModuleInit();
    await expect(poller.runOnce()).resolves.toBeUndefined();
    await poller.runOnce();
    expect(repo.pendingVerdicts).toHaveBeenCalledTimes(2);
    poller.onModuleDestroy();
  });

  it('enabled: the E5 fill settler runs on its own 30 s timer, separate from the exit poll, cleared on destroy', async () => {
    jest.useFakeTimers();
    setEnv({ AI_AUTO_EXIT_ENABLED: 'true', AI_AUTO_EXIT_USER_IDS: 'owner' });
    const spy = jest.spyOn(global, 'setInterval');
    const { poller, settler, repo } = make();
    poller.onModuleInit();
    expect(spy.mock.calls.map((c) => c[1])).toEqual(expect.arrayContaining([AI_EXIT_POLL_MS, EXIT_FILL_SETTLE_MS]));
    expect(EXIT_FILL_SETTLE_MS).toBe(30_000);
    jest.advanceTimersByTime(EXIT_FILL_SETTLE_MS);
    expect(settler.runOnce).toHaveBeenCalledTimes(1);
    expect(repo.pendingVerdicts).toHaveBeenCalled(); // the exit poll runs on its own timer
    poller.onModuleDestroy();
    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(10 * EXIT_FILL_SETTLE_MS);
    expect(settler.runOnce).toHaveBeenCalledTimes(1);
  });

  it('enabled: outcome scoring runs on its own 60 s timer, cleared on destroy', () => {
    jest.useFakeTimers();
    setEnv({ AI_AUTO_EXIT_ENABLED: 'true', AI_AUTO_EXIT_USER_IDS: 'owner' });
    const spy = jest.spyOn(global, 'setInterval');
    const { poller, outcomes } = make();
    poller.onModuleInit();
    expect(EXIT_OUTCOME_MS).toBe(60_000);
    expect(spy.mock.calls.map((c) => c[1])).toEqual(expect.arrayContaining([EXIT_OUTCOME_MS]));
    jest.advanceTimersByTime(EXIT_OUTCOME_MS);
    expect(outcomes.runOnce).toHaveBeenCalledTimes(1);
    poller.onModuleDestroy();
    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(5 * EXIT_OUTCOME_MS);
    expect(outcomes.runOnce).toHaveBeenCalledTimes(1);
  });
});

describe('SentinelExitPoller — exit noise read (record only)', () => {
  afterEach(() => { jest.restoreAllMocks(); setEnv({}); });

  it('is fired after an exit the executor acted on, never awaited: a hanging or throwing read cannot block the next verdict', async () => {
    setEnv({ AI_AUTO_EXIT_ENABLED: 'true', AI_AUTO_EXIT_USER_IDS: 'owner' });
    const repo = { pendingVerdicts: jest.fn().mockResolvedValue([]), sweepInterrupted: jest.fn().mockResolvedValue(0), findByVerdictId: jest.fn(async () => ({ fillPrice: null, orderLtp: 532, decisionLtp: 531.3 })) };
    const executor = { process: jest.fn() };
    const idle = { runOnce: jest.fn().mockResolvedValue(undefined) };
    const created = new Date('2026-10-30T05:55:00Z');
    repo.pendingVerdicts.mockResolvedValue([
      { id: 'a', userId: 'owner', trackerId: 't1', symbol: 'X', reason: 'r', createdAt: created },
      { id: 'b', userId: 'owner', trackerId: 't2', symbol: 'Y', reason: 'r', createdAt: created },
      { id: 'c', userId: 'owner', trackerId: 't3', symbol: 'Z', reason: 'r', createdAt: created },
    ]);
    executor.process.mockResolvedValueOnce({ status: 'FILLED' }).mockResolvedValueOnce({ status: 'SKIPPED', reason: 'DAILY_CAP' }).mockResolvedValueOnce({ status: 'DRY_RUN' });
    const record = jest.fn().mockImplementationOnce(() => new Promise(() => undefined)).mockImplementationOnce(() => { throw new Error('db down'); });
    const poller = new SentinelExitPoller(repo as never, executor as never, idle as never, idle as never, { record } as never);
    jest.spyOn(global, 'setInterval').mockReturnValue({ unref: () => undefined } as never);
    jest.spyOn(global, 'setTimeout').mockReturnValue({ unref: () => undefined } as never);
    poller.onModuleInit();
    await poller.runOnce();
    expect(executor.process.mock.calls.map((c) => c[0].id)).toEqual(['a', 'b', 'c']);
    await new Promise((r) => setImmediate(r));
    // SKIPPED is not an exit: only a and c are read.
    expect(record.mock.calls.map((c) => c[0].refId)).toEqual(['a', 'c']);
    expect(record.mock.calls[0][0]).toMatchObject({ source: 'real', exitRule: 'AI_EXIT', trackerId: 't1', userId: 'owner', context: { execution: 'FILLED' }, exitPrice: 532 });
    poller.onModuleDestroy();
  });
});
