import { Logger } from '@nestjs/common';
import { parseMessageReaderConfig, type ReaderMode } from '../message-reader.config';
import type { ReaderCounts } from '../repositories/message-reader.repository';
import { MESSAGE_READER_CLOSE_BREADTH_CRON, MESSAGE_READER_HEALTH_CRON, MESSAGE_READER_SCORE_CRON, MessageReaderCron } from './message-reader.cron';

const OPEN = new Date('2026-11-25T05:00:00Z'); // Wed 10:30 IST

type Opts = {
  mode?: ReaderMode;
  agents?: boolean;
  tradingDay?: boolean;
  now?: Date;
  counts?: Partial<ReaderCounts>;
  lastFailure?: { at: Date; error: string | null } | null;
  lease?: { runExclusiveFailClosed: jest.Mock };
  noScoring?: boolean;
};

function make(o: Opts = {}) {
  const repo = {
    countsSince: jest.fn(async (): Promise<ReaderCounts> => ({ posts: 3, byStatus: {}, p50Ms: null, p95Ms: null, lastReadAt: new Date('2026-11-25T04:10:00Z'), ...o.counts })),
    lastFailure: jest.fn(async () => (o.lastFailure === undefined ? { at: OPEN, error: 'message reader timed out after 25000 ms' } : o.lastFailure)),
  };
  const clock = { isTradingDay: jest.fn(() => o.tradingDay ?? true) };
  const alert = jest.fn(async () => true);
  const cfg = parseMessageReaderConfig({ MESSAGE_READER: o.mode ?? 'shadow' });
  const scoring = { storeCloseBreadth: jest.fn(async () => 0.8), scoreNight: jest.fn(async () => ({ filled: 1, pending: 0 })) };
  const cron = new MessageReaderCron(repo, cfg, clock, o.lease as never, () => o.now ?? OPEN, () => o.agents ?? true, alert, o.noScoring ? undefined : (scoring as never));
  return { cron, repo, clock, alert, scoring };
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

  it('does nothing when the reader is off (agents on or off)', async () => {
    for (const m of [make({ mode: 'off' }), make({ mode: 'off', agents: false })]) {
      await m.cron.onHealth();
      expect(m.repo.countsSince).not.toHaveBeenCalled();
      expect(m.alert).not.toHaveBeenCalled();
    }
  });

  describe('reader switched on but AI agents off', () => {
    it('boot warns once, naming the mode and what to set', () => {
      const m = make({ mode: 'shadow', agents: false });
      m.cron.onApplicationBootstrap();
      expect(Logger.prototype.warn).toHaveBeenCalledTimes(1);
      const line = (Logger.prototype.warn as jest.Mock).mock.calls[0][0] as string;
      expect(line).toContain('MESSAGE_READER=shadow');
      expect(line).toContain('AI agents are off');
      expect(line).toContain('AI_AGENTS=on and SENTINEL_JUDGE=vertex');
    });

    it('boot is quiet when the reader is off or the agents are on', () => {
      make({ mode: 'off', agents: false }).cron.onApplicationBootstrap();
      make({ mode: 'on', agents: true }).cron.onApplicationBootstrap();
      expect(Logger.prototype.warn).not.toHaveBeenCalled();
    });

    it('sends the agents-off alert in market hours, without the dead-reader check', async () => {
      const m = make({ mode: 'on', agents: false });
      await m.cron.onHealth();
      expect(m.alert).toHaveBeenCalledTimes(1);
      const [key, text] = m.alert.mock.calls[0] as unknown as [string, string];
      expect(key).toBe('message-reader-agents-off');
      expect(text).toContain('MESSAGE_READER=on but the AI agents are off, so no Telegram post is being read');
      expect(m.repo.countsSince).not.toHaveBeenCalled();
    });

    it('no agents-off alert outside market hours or on a holiday', async () => {
      for (const m of [make({ agents: false, now: new Date('2026-11-25T10:05:00Z') }), make({ agents: false, tradingDay: false })]) {
        await m.cron.onHealth();
        expect(m.alert).not.toHaveBeenCalled();
      }
    });
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

describe('MessageReaderCron (night scoring of claims)', () => {
  const AT_1525 = new Date('2026-11-25T09:55:00Z');
  const AT_1830 = new Date('2026-11-25T13:00:00Z');
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.BOOT_JOBS;
  });

  it('stores the close A/D at 15:25 and scores at 18:30 IST, weekdays', () => {
    expect(MESSAGE_READER_CLOSE_BREADTH_CRON).toBe('25 15 * * 1-5');
    expect(MESSAGE_READER_SCORE_CRON).toBe('30 18 * * 1-5');
  });

  it('15:25: stores the close breadth under its lease', async () => {
    const lease = { runExclusiveFailClosed: jest.fn(async (_n: string, _t: number, fn: () => Promise<unknown>) => fn()) };
    const m = make({ now: AT_1525, lease });
    await m.cron.onCloseBreadth();
    expect(lease.runExclusiveFailClosed).toHaveBeenCalledWith('message-reader-close-breadth', expect.any(Number), expect.any(Function));
    expect(m.scoring.storeCloseBreadth).toHaveBeenCalledWith(AT_1525);
  });

  it('15:25: nothing when the reader is off, on a holiday, or with BOOT_JOBS=false', async () => {
    const off = make({ mode: 'off', now: AT_1525 });
    await off.cron.onCloseBreadth();
    const holiday = make({ tradingDay: false, now: AT_1525 });
    await holiday.cron.onCloseBreadth();
    process.env.BOOT_JOBS = 'false';
    const noBoot = make({ now: AT_1525 });
    await noBoot.cron.onCloseBreadth();
    for (const m of [off, holiday, noBoot]) expect(m.scoring.storeCloseBreadth).not.toHaveBeenCalled();
  });

  it('18:30: scores under its lease, also when the reader is off (pending DAYS / WEEKS claims finish)', async () => {
    const lease = { runExclusiveFailClosed: jest.fn(async (_n: string, _t: number, fn: () => Promise<unknown>) => fn()) };
    const m = make({ mode: 'off', now: AT_1830, lease });
    await m.cron.onScore();
    expect(lease.runExclusiveFailClosed).toHaveBeenCalledWith('message-reader-score', expect.any(Number), expect.any(Function));
    expect(m.scoring.scoreNight).toHaveBeenCalledWith(AT_1830);
  });

  it('18:30: nothing on a holiday or with BOOT_JOBS=false', async () => {
    const holiday = make({ tradingDay: false, now: AT_1830 });
    await holiday.cron.onScore();
    process.env.BOOT_JOBS = 'false';
    const noBoot = make({ now: AT_1830 });
    await noBoot.cron.onScore();
    for (const m of [holiday, noBoot]) expect(m.scoring.scoreNight).not.toHaveBeenCalled();
  });

  it('a failing job is logged, not thrown', async () => {
    const m = make({ now: AT_1830 });
    m.scoring.scoreNight.mockRejectedValueOnce(new Error('bars down'));
    await expect(m.cron.onScore()).resolves.toBeUndefined();
    expect(Logger.prototype.warn).toHaveBeenCalledWith(expect.stringContaining('bars down'));
  });

  it('warns (not silent) when the scoring service is not wired', async () => {
    const m = make({ now: AT_1830, noScoring: true });
    await m.cron.onScore();
    expect(Logger.prototype.warn).toHaveBeenCalledWith(expect.stringContaining('not wired'));
  });
});
