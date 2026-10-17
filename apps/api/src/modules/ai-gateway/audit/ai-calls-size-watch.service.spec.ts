import { Logger } from '@nestjs/common';
import { AiCallsSizeWatch, DEFAULT_AI_CALLS_WARN_MB, warnMbFrom } from './ai-calls-size-watch.service';

const MB = 1024 * 1024;

function make(bytes: number | bigint, rows: number | bigint, env: Record<string, string> = {}) {
  const $queryRaw = jest.fn().mockResolvedValue([{ bytes, rows }]);
  const config = { get: (k: string) => env[k] };
  return { svc: new AiCallsSizeWatch({ $queryRaw } as never, config as never), $queryRaw };
}

describe('warnMbFrom', () => {
  it('defaults, honours a positive override, and 0 disables', () => {
    expect(warnMbFrom(undefined)).toBe(DEFAULT_AI_CALLS_WARN_MB);
    expect(warnMbFrom('abc')).toBe(DEFAULT_AI_CALLS_WARN_MB);
    expect(warnMbFrom('500')).toBe(500);
    expect(warnMbFrom('0')).toBe(0);
  });
});

describe('AiCallsSizeWatch', () => {
  afterEach(() => jest.restoreAllMocks());

  it('logs size and rows, no warning under the threshold (bigint from pg is fine)', async () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { svc } = make(BigInt(10 * MB), BigInt(1234));
    await expect(svc.check()).resolves.toEqual({ mb: 10, rows: 1234, over: false });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('ai_calls: 10 MB, 1234 rows'));
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns once the table passes AI_CALLS_SIZE_WARN_MB', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { svc } = make(600 * MB, 9, { AI_CALLS_SIZE_WARN_MB: '500' });
    expect((await svc.check()).over).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('600 MB > 500 MB'));
  });

  it('a threshold of 0 never warns', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { svc } = make(5000 * MB, 9, { AI_CALLS_SIZE_WARN_MB: '0' });
    expect((await svc.check()).over).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('the cron never throws: a query failure is logged', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { svc, $queryRaw } = make(0, 0);
    $queryRaw.mockRejectedValue(new Error('db down'));
    await expect(svc.run()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('db down'));
  });
});
