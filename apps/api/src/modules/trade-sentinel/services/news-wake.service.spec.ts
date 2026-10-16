import { NewsWakeService } from './news-wake.service';
import { NewsWatchBook } from './news-watch-book';
import { parseNewsEventsConfig } from '../../news-events/config';
import { article, fakeNewsIndex } from '../../news-events/testing';

const NOW = Date.UTC(2026, 9, 16, 5, 0);
const own = (id: string, over: Record<string, unknown> = {}) =>
  article({ id, title: `INFY ${id}`, publishedAt: NOW - 60_000, tags: { instruments: ['INFY'], sectors: [], indices: [], markets: [] }, ...over });

function harness(mode: string) {
  const book = new NewsWatchBook();
  book.upsert({ trackerId: 't1', userId: 'u1', symbol: 'INFY', exchange: 'NSE', instrumentKeys: ['I:INFY'] });
  const runner = { wakeForTick: jest.fn() };
  const index = fakeNewsIndex(() => ({ status: 'warming', reason: 'x' }));
  const svc = new NewsWakeService(book, runner as never, index as never, parseNewsEventsConfig({ NEWS_EVENTS_V2_ENABLED: mode }));
  const log = jest.spyOn((svc as unknown as { logger: { log: (m: string) => void } }).logger, 'log').mockImplementation(() => undefined);
  return { svc, runner, index, log, book };
}

describe('NewsWakeService', () => {
  const prevBootJobs = process.env.BOOT_JOBS;
  afterEach(() => {
    if (prevBootJobs === undefined) delete process.env.BOOT_JOBS;
    else process.env.BOOT_JOBS = prevBootJobs;
  });

  it('off, or the sentinel shadow off, or BOOT_JOBS=false: does not subscribe', () => {
    expect(harness('false').svc.start(true)).toBe(false);
    expect(harness('true').svc.start(false)).toBe(false);
    process.env.BOOT_JOBS = 'false';
    expect(harness('true').svc.start(true)).toBe(false);
  });

  it('no index or no config wired: does not subscribe', () => {
    const book = new NewsWatchBook();
    expect(new NewsWakeService(book, { wakeForTick: jest.fn() } as never).start(true)).toBe(false);
  });

  it('false: onAdded does nothing at all', () => {
    const { svc, runner, log } = harness('false');
    svc.onAdded([own('a')], NOW);
    expect(runner.wakeForTick).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('true: an own-instrument headline wakes the user once (per article), with the title', () => {
    const { svc, runner } = harness('true');
    svc.onAdded([own('a')], NOW);
    svc.onAdded([own('a')], NOW + 1000);
    expect(runner.wakeForTick).toHaveBeenCalledTimes(1);
    expect(runner.wakeForTick).toHaveBeenCalledWith('u1', 'news-hit on INFY: "INFY a"', 'NSE');
  });

  it('true: an index headline wakes an index-option position (X: key)', () => {
    const { svc, runner, book } = harness('true');
    book.upsert({ trackerId: 't2', userId: 'u2', symbol: 'NIFTY28OCT2625000CE', exchange: 'NFO', instrumentKeys: ['X:NIFTY'] });
    svc.onAdded([article({ id: 'n', title: 'Nifty hits record', publishedAt: NOW - 1000, tags: { instruments: [], sectors: [], indices: ['NIFTY'], markets: ['IN'] } })], NOW);
    expect(runner.wakeForTick).toHaveBeenCalledWith('u2', 'news-hit on NIFTY28OCT2625000CE: "Nifty hits record"', 'NFO');
  });

  it('true: a second headline inside the 5-min cooldown does not wake; after it, it does', () => {
    const { svc, runner } = harness('true');
    svc.onAdded([own('a')], NOW);
    svc.onAdded([own('b')], NOW + 4 * 60_000);
    svc.onAdded([own('c', { publishedAt: NOW + 5 * 60_000 })], NOW + 5 * 60_000 + 1);
    expect(runner.wakeForTick.mock.calls.map((c) => c[1])).toEqual(['news-hit on INFY: "INFY a"', 'news-hit on INFY: "INFY c"']);
  });

  it('never wakes on sector/index/market-only headlines, inferred dates, or anything older than 30 min (re-tag, restart)', () => {
    const { svc, runner } = harness('true');
    svc.onAdded(
      [
        article({ id: 's', publishedAt: NOW, tags: { instruments: [], sectors: ['NIFTY IT'], indices: ['NIFTY'], markets: ['IN'] } }),
        own('inf', { dateInferred: true }),
        own('old', { publishedAt: NOW - 31 * 60_000 }),
      ],
      NOW,
    );
    expect(runner.wakeForTick).not.toHaveBeenCalled();
  });

  it('a tracker that left the watch book loses its seen-set; nothing is woken for it', () => {
    const { svc, runner, book } = harness('true');
    book.prune('u1', new Set());
    svc.onAdded([own('a')], NOW);
    expect(runner.wakeForTick).not.toHaveBeenCalled();
  });

  it('observe: logs a would-wake line, never wakes', () => {
    const { svc, runner, log } = harness('observe');
    svc.onAdded([own('a')], NOW);
    svc.onAdded([own('a')], NOW + 1000);
    expect(runner.wakeForTick).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('[news-wake] observe: would wake u1 for INFY — "INFY a"');
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('a throwing runner never escapes into the index publisher', () => {
    const { svc, runner } = harness('true');
    runner.wakeForTick.mockImplementation(() => {
      throw new Error('boom');
    });
    jest.spyOn((svc as unknown as { logger: { warn: (m: string) => void } }).logger, 'warn').mockImplementation(() => undefined);
    expect(() => svc.onAdded([own('a')], NOW)).not.toThrow();
  });

  it('start subscribes to the index and forwards its additions; destroy unsubscribes', () => {
    const { svc, runner, index } = harness('true');
    expect(svc.start(true)).toBe(true);
    index.emit([own('z', { publishedAt: Date.now() - 1000 })]);
    expect(runner.wakeForTick).toHaveBeenCalledTimes(1);
    svc.onModuleDestroy();
    index.emit([own('y', { publishedAt: Date.now() - 1000 })]);
    expect(runner.wakeForTick).toHaveBeenCalledTimes(1);
  });
});
