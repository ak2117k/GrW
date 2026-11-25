import { Logger } from '@nestjs/common';
import { parseMessageReaderConfig, type ReaderMode } from '../message-reader.config';
import type { ReaderCounts } from '../repositories/message-reader.repository';
import { MESSAGE_READER_HEALTH_CRON, MessageReaderCron } from './message-reader.cron';

const OPEN = new Date('2026-11-25T05:00:00Z'); // Wed 10:30 IST

type Opts = {
  mode?: ReaderMode;
  agents?: boolean;
  tradingDay?: boolean;
  now?: Date;
  counts?: Partial<ReaderCounts>;
  lastFailure?: { at: Date; error: string | null } | null;
  lease?: { runExclusiveFailClosed: jest.Mock };
};

function make(o: Opts = {}) {
  const repo = {
    countsSince: jest.fn(async (): Promise<ReaderCounts> => ({ posts: 3, byStatus: {}, p50Ms: null, p95Ms: null, lastReadAt: new Date('2026-11-25T04:10:00Z'), ...o.counts })),
    lastFailure: jest.fn(async () => (o.lastFailure === undefined ? { at: OPEN, error: 'message reader timed out after 25000 ms' } : o.lastFailure)),
  };
  const clock = { isTradingDay: jest.fn(() => o.tradingDay ?? true) };
  const alert = jest.fn(async () => true);
  const cfg = parseMessageReaderConfig({ MESSAGE_READER: o.mode ?? 'shadow' });
  const cron = new MessageReaderCron(repo, cfg, clock, o.lease as never, () => o.now ?? OPEN, () => o.agents ?? true, alert);
  return { cron, repo, clock, alert };
}

describe('MessageReaderCron (reader health)', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined));
  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.BOOT_JOBS;
  });

  it('runs every 5 min, 09:00–15:55 IST on weekdays', () => {
    expect(MESSAGE_READER_HEALTH_CRON).toBe('*/5 9-15 * * 1-5');
  });

  it('alerts when posts arrive and nothing is read', async () => {
    const m = make({ counts: { posts: 3, byStatus: { FAILED: 3 } } });
    await m.cron.onHealth();
    expect(m.repo.countsSince).toHaveBeenCalledWith(new Date(OPEN.getTime() - 15 * 60_000));
    expect(m.alert).toHaveBeenCalledTimes(1);
    const [key, text] = m.alert.mock.calls[0] as unknown as [string, string];
    expect(key).toBe('message-reader-dead');
    expect(text).toContain('posts 3, read 0 in 15 min; last read 09:40 IST; last error message reader timed out after 25000 ms');
  });

  it('checks in shadow and in on mode alike', async () => {
    const m = make({ mode: 'on', counts: { posts: 5 } });
    await m.cron.onHealth();
    expect(m.alert).toHaveBeenCalledTimes(1);
  });

  it('quiet when the market is closed (holiday)', async () => {
    const m = make({ tradingDay: false, counts: { posts: 9 } });
    await m.cron.onHealth();
    expect(m.alert).not.toHaveBeenCalled();
  });

  it('quiet when the market is closed (after 15:30 IST)', async () => {
    const m = make({ now: new Date('2026-11-25T10:05:00Z'), counts: { posts: 9 } }); // 15:35 IST
    await m.cron.onHealth();
    expect(m.alert).not.toHaveBeenCalled();
    expect(m.repo.countsSince).not.toHaveBeenCalled();
  });

  it('quiet with 2 posts', async () => {
    const m = make({ counts: { posts: 2 } });
    await m.cron.onHealth();
    expect(m.alert).not.toHaveBeenCalled();
  });

  it('quiet when a post was READ', async () => {
    const m = make({ counts: { posts: 6, byStatus: { READ: 1, FAILED: 5 } } });
    await m.cron.onHealth();
    expect(m.alert).not.toHaveBeenCalled();
  });

  it('does nothing when the reader is off or the AI agents are off', async () => {
    for (const m of [make({ mode: 'off' }), make({ agents: false })]) {
      await m.cron.onHealth();
      expect(m.repo.countsSince).not.toHaveBeenCalled();
      expect(m.alert).not.toHaveBeenCalled();
    }
  });

  it('does nothing with BOOT_JOBS=false', async () => {
    process.env.BOOT_JOBS = 'false';
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const m = make();
    await m.cron.onHealth();
    expect(m.repo.countsSince).not.toHaveBeenCalled();
  });

  it('runs under the fail-closed lease', async () => {
    const lease = { runExclusiveFailClosed: jest.fn(async (_n: string, _t: number, fn: () => Promise<unknown>) => fn()) };
    const m = make({ lease });
    await m.cron.onHealth();
    expect(lease.runExclusiveFailClosed).toHaveBeenCalledWith('message-reader-health', expect.any(Number), expect.any(Function));
    expect(m.alert).toHaveBeenCalledTimes(1);
  });

  it('a failing count query is logged, not thrown', async () => {
    const m = make();
    m.repo.countsSince.mockRejectedValueOnce(new Error('db down'));
    await expect(m.cron.onHealth()).resolves.toBeUndefined();
    expect(Logger.prototype.warn).toHaveBeenCalledWith(expect.stringContaining('db down'));
  });
});
