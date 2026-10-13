// apps/api/src/modules/sentinel-executor/services/sentinel-exit-poller.service.spec.ts
import { Logger } from '@nestjs/common';
import { SentinelExitPoller, AI_EXIT_POLL_MS } from './sentinel-exit-poller.service';

const ENV_KEYS = ['AI_AUTO_EXIT_ENABLED', 'AI_AUTO_EXIT_MODE', 'AI_AUTO_EXIT_USER_IDS', 'AI_AUTO_EXIT_QTY_UNITS', 'BOOT_JOBS'];
function setEnv(e: Record<string, string>) {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, e);
}
function make() {
  const repo = { pendingVerdicts: jest.fn().mockResolvedValue([]), sweepInterrupted: jest.fn().mockResolvedValue(0) };
  const executor = { process: jest.fn().mockResolvedValue({ status: 'SKIPPED' }) };
  return { repo, executor, poller: new SentinelExitPoller(repo as never, executor as never) };
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
    const { poller, repo, executor } = make();
    poller.onModuleInit();
    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(10 * AI_EXIT_POLL_MS);
    await Promise.resolve();
    // Even a direct call does nothing when the poller never started.
    await poller.runOnce();
    expect(repo.pendingVerdicts).not.toHaveBeenCalled();
    expect(repo.sweepInterrupted).not.toHaveBeenCalled();
    expect(executor.process).not.toHaveBeenCalled();
    poller.onModuleDestroy();
  });

  it('enabled: sweeps at start and again at 65 s, polls every 5 s with a 2× age look-back', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-12T10:00:00Z'));
    setEnv({ AI_AUTO_EXIT_ENABLED: 'true', AI_AUTO_EXIT_USER_IDS: 'owner' });
    const { poller, repo } = make();
    poller.onModuleInit();
    await Promise.resolve();
    expect(repo.sweepInterrupted).toHaveBeenCalledWith(new Date('2026-10-12T09:59:00Z'));
    jest.advanceTimersByTime(AI_EXIT_POLL_MS);
    await Promise.resolve();
    expect(repo.pendingVerdicts).toHaveBeenCalledWith(['owner'], new Date('2026-10-12T09:57:05Z'), 5);
    jest.advanceTimersByTime(65_000);
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
});
