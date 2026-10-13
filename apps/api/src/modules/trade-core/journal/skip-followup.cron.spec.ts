import type { JobRunnerService } from '../../../common/job-registry';
import type { HubCandle } from '../../market-hub/candles/candle.types';
import type { CoreCandles } from '../market/core-candles';
import { CORE_SKIP_FOLLOWUP_JOB, FOLLOWUP_MAX_INSTRUMENTS, priceAt, sessionCloseMs, SkipFollowupCron } from './skip-followup.cron';
import { MemoryJournalStore } from './testing/memory-journal-store';

const D = '2026-10-13';
const ist = (hhmm: string) => new Date(`${D}T${hhmm}:00.000+05:30`);
/** 1m bars from 09:15 to 15:29, close = 500 + minutes since the open (whole rupees: exact comparisons). */
const DAY: HubCandle[] = Array.from({ length: 375 }, (_, i) => ({ ts: ist('09:15').getTime() + i * 60_000, open: 0, high: 0, low: 0, close: 500 + i, volume: 1 }));

async function skipRow(store: MemoryJournalStore, at: Date, token = '2885', over: Record<string, unknown> = {}) {
  await store.repo.append([{
    type: 'INTENT_SKIPPED', userId: 'user_A', at, intentId: `ci_${token}_${at.getTime()}`, strategyId: 'cs_x', symbol: 'RELIANCE-EQ',
    payload: { reason: 'GATE', token, exchange: 'NSE', alertPrice: 499, ltp: 500, ...over },
  }]);
}

function setup(read?: CoreCandles['read']) {
  const store = new MemoryJournalStore();
  const journal = store.port();
  const candles = { read: read ?? jest.fn().mockResolvedValue({ ok: true, candles: DAY, complete: true }) } as unknown as CoreCandles;
  const corpus = { entrySetup: jest.fn(), outcome: jest.fn().mockResolvedValue(undefined) };
  const jobs = { run: jest.fn((_n: string, _o: unknown, fn: () => Promise<unknown>) => fn()) };
  const cron = new SkipFollowupCron(store.repo, journal, candles, corpus, jobs as unknown as JobRunnerService);
  return { store, cron, candles, corpus, jobs };
}

describe('priceAt', () => {
  it('is the close of the newest bar that ended at or before t; null before the first bar ends', () => {
    expect(priceAt(DAY, ist('09:15').getTime())).toBeNull();
    expect(priceAt(DAY, ist('09:16').getTime())).toBe(500);
    expect(priceAt(DAY, ist('10:45').getTime() + 30_000)).toBe(589);
    expect(priceAt(DAY, sessionCloseMs(D))).toBe(874);
  });
});

describe('SkipFollowupCron (spec §8.1, J14, O14)', () => {
  it('writes PRICE_FOLLOWUP for each skip of the day (30 min after it, and at the close) and merges them into the corpus', async () => {
    const s = setup();
    await skipRow(s.store, ist('10:15'));
    const r = await s.cron.followUp(D, ist('16:10'));
    expect(r).toEqual({ skipped: 1, instruments: 1, written: 1, unpriced: 0 });
    const f = s.store.rows.find((x) => x.type === 'PRICE_FOLLOWUP');
    expect(f).toMatchObject({ userId: 'user_A', strategyId: 'cs_x', payload: { reason: 'GATE', refPrice: 500, priceAfter30m: 589, priceAfterClose: 874 } });
    expect(s.corpus.outcome).toHaveBeenCalledWith(f?.intentId, { priceAfter30m: 589, priceAfterClose: 874 }, ist('16:10'));
  });

  it('reads each instrument once, is idempotent on a rerun, and counts what it could not price', async () => {
    const read = jest.fn().mockResolvedValueOnce({ ok: true, candles: DAY, complete: true }).mockResolvedValueOnce({ ok: false, reason: 'hub candles are off' }).mockResolvedValue({ ok: true, candles: DAY, complete: true });
    const s = setup(read);
    await skipRow(s.store, ist('10:15'));
    await skipRow(s.store, ist('11:00'));
    await skipRow(s.store, ist('11:30'), '1594');
    expect(await s.cron.followUp(D, ist('16:10'))).toEqual({ skipped: 3, instruments: 2, written: 2, unpriced: 1 });
    expect(read).toHaveBeenCalledTimes(2);
    await s.cron.followUp(D, ist('16:20'));
    expect(s.store.rows.filter((x) => x.type === 'PRICE_FOLLOWUP')).toHaveLength(3); // the rerun added only the 1594 one
  });

  it(`prices at most ${FOLLOWUP_MAX_INSTRUMENTS} instruments a day`, async () => {
    const s = setup();
    for (let i = 0; i < FOLLOWUP_MAX_INSTRUMENTS + 2; i += 1) await skipRow(s.store, ist('10:15'), String(10_000 + i));
    const r = await s.cron.followUp(D, ist('16:10'));
    expect(r).toMatchObject({ instruments: FOLLOWUP_MAX_INSTRUMENTS, unpriced: 2 });
  });

  it('runs through the job runner under its job name; a failure is logged, never thrown', async () => {
    const s = setup();
    await s.cron.run(ist('16:10'));
    expect(s.jobs.run).toHaveBeenCalledWith(CORE_SKIP_FOLLOWUP_JOB, expect.objectContaining({ onRedisError: 'run-anyway' }), expect.any(Function));
    s.jobs.run.mockRejectedValueOnce(new Error('lease lost'));
    await expect(s.cron.run(ist('16:10'))).resolves.toBeUndefined();
  });
});
