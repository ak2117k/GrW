import { readFileSync } from 'fs';
import { join } from 'path';
import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { JobRunnerService } from '../../../common/job-registry';
import { MTF_INTEREST_JOB, MtfInterestCron } from './mtf-interest.cron';
import { PaperLedgerService, type PlaceContext } from './paper-ledger.service';
import type { PaperSettings } from './paper-settings';
import { fakeDefaults, MemoryPaperStore } from './testing/memory-paper-store';
import { cashBuy, mtfBuy, paperSettings } from './testing/paper-fixtures';

const D = (s: string) => new Prisma.Decimal(s);
const OPEN: PlaceContext = { sessionOpen: true, killSwitchActive: false };
/** Friday 2026-10-09, 10:30 IST. */
const FRI = new Date('2026-10-09T05:00:00.000Z');
const AT = new Date(FRI.getTime() + 10);

async function holding(settings: PaperSettings | null = paperSettings()) {
  const store = new MemoryPaperStore(() => FRI);
  const svc = new PaperLedgerService(store.tx, store.orderRepo, store.fillRepo, store.ledgerRepo, fakeDefaults(settings ?? paperSettings()));
  const { order } = await svc.place(mtfBuy(), OPEN, FRI);
  await svc.applyFill('user_A', order.id, order, { qty: 10, price: D('1000.5'), priceAt: AT });
  const interest = (userId = 'user_A') => store.ledger.filter((r) => r.type === 'MTF_INTEREST' && r.userId === userId).map((r) => [r.interestDate, r.amount.toFixed(2), r.token]);
  return { store, svc, interest };
}

describe('PaperLedgerService.postMtfInterest (spec §4.4)', () => {
  it('the first run posts the opening day on the funded amount', async () => {
    const { svc, interest } = await holding();
    // 10 × ₹1000.50 = ₹10005.00; funded 50% = ₹5002.50; × 18% ÷ 365 = ₹2.4670… → ₹2.47.
    expect(await svc.postMtfInterest('2026-10-09')).toEqual({ holdings: 1, posted: 1 });
    expect(interest()).toEqual([['2026-10-09', '-2.47', '1594']]);
  });

  it("Monday's run posts Saturday, Sunday and Monday", async () => {
    const { svc, interest } = await holding();
    await svc.postMtfInterest('2026-10-09');
    expect(await svc.postMtfInterest('2026-10-12')).toEqual({ holdings: 1, posted: 3 });
    expect(interest().map((r) => r[0])).toEqual(['2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12']);
  });

  it('a second run the same day posts nothing', async () => {
    const { svc, interest } = await holding();
    await svc.postMtfInterest('2026-10-12');
    expect(await svc.postMtfInterest('2026-10-12')).toEqual({ holdings: 1, posted: 0 });
    expect(interest()).toHaveLength(4);
  });

  it('a missed night is caught up from the opening day', async () => {
    const { svc, interest } = await holding();
    expect((await svc.postMtfInterest('2026-10-13')).posted).toBe(5);
    expect(interest().map((r) => r[0])).toEqual(['2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13']);
  });

  it('a closed holding is not charged, and cash positions never are', async () => {
    const { svc, interest } = await holding();
    const exit = (await svc.place(mtfBuy({ idempotencyKey: 'exit', purpose: 'EXIT', side: 'SELL', refPrice: 1010 }), OPEN, FRI)).order;
    await svc.applyFill('user_A', exit.id, exit, { qty: 10, price: D('1010'), priceAt: AT });
    const cash = (await svc.place(cashBuy(), OPEN, FRI)).order;
    await svc.applyFill('user_A', cash.id, cash, { qty: 100, price: D('500'), priceAt: AT });
    expect(await svc.postMtfInterest('2026-10-12')).toEqual({ holdings: 0, posted: 0 });
    expect(interest()).toEqual([]);
  });

  it('the exit day is not charged when the holding is sold before the 15:35 run', async () => {
    const { svc, interest } = await holding();
    await svc.postMtfInterest('2026-10-12');
    const exit = (await svc.place(mtfBuy({ idempotencyKey: 'exit', purpose: 'EXIT', side: 'SELL', refPrice: 1010 }), OPEN, FRI)).order;
    await svc.applyFill('user_A', exit.id, exit, { qty: 10, price: D('1010'), priceAt: AT });
    expect(await svc.postMtfInterest('2026-10-13')).toEqual({ holdings: 0, posted: 0 });
    expect(interest().map((r) => r[0])).toEqual(['2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12']);
  });

  it("one user's holding never posts interest for another", async () => {
    const { svc, interest } = await holding();
    const b = (await svc.place(mtfBuy({ userId: 'user_B', idempotencyKey: 'kb' }), OPEN, FRI)).order;
    await svc.applyFill('user_B', b.id, b, { qty: 10, price: D('1000.5'), priceAt: AT });
    const bExit = (await svc.place(mtfBuy({ userId: 'user_B', idempotencyKey: 'kb-exit', purpose: 'EXIT', side: 'SELL' }), OPEN, FRI)).order;
    await svc.applyFill('user_B', bExit.id, bExit, { qty: 10, price: D('1001'), priceAt: AT });
    expect(await svc.postMtfInterest('2026-10-09')).toEqual({ holdings: 1, posted: 1 });
    expect(interest('user_A')).toHaveLength(1);
    expect(interest('user_B')).toEqual([]);
  });

  it('without settings the run fails loudly and posts nothing', async () => {
    const { store } = await holding();
    const blind = new PaperLedgerService(store.tx, store.orderRepo, store.fillRepo, store.ledgerRepo, fakeDefaults(null));
    await expect(blind.postMtfInterest('2026-10-09')).rejects.toThrow('paper settings are incomplete');
    expect(store.ledger.filter((r) => r.type === 'MTF_INTEREST')).toEqual([]);
  });
});

describe('MtfInterestCron', () => {
  afterEach(() => jest.restoreAllMocks());

  it('runs at 15:35 IST Monday to Friday, through the job runner, for the IST date', async () => {
    const src = readFileSync(join(__dirname, 'mtf-interest.cron.ts'), 'utf8');
    expect(src).toContain("@Cron('0 35 15 * * 1-5', { name: MTF_INTEREST_JOB, timeZone: 'Asia/Kolkata' })");
    expect(MTF_INTEREST_JOB).toBe('core-mtf-interest');
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const ledger = { postMtfInterest: jest.fn().mockResolvedValue({ holdings: 1, posted: 1 }) };
    const jobs = { run: jest.fn((_name: string, _opts: unknown, fn: () => Promise<unknown>) => fn()) };
    await new MtfInterestCron(ledger as unknown as PaperLedgerService, jobs as unknown as JobRunnerService).run(new Date('2026-10-12T10:05:00.000Z'));
    expect(jobs.run).toHaveBeenCalledWith(MTF_INTEREST_JOB, { ttlMs: 30 * 60 * 1000, onRedisError: 'run-anyway' }, expect.any(Function));
    expect(ledger.postMtfInterest).toHaveBeenCalledWith('2026-10-12');
    expect(log).toHaveBeenCalledWith('MTF interest 2026-10-12: 1 open holding(s), 1 day row(s) posted');
  });

  it('a failing run is logged, never thrown into the scheduler', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const ledger = { postMtfInterest: jest.fn().mockRejectedValue(new Error('db down')) };
    const jobs = { run: jest.fn((_name: string, _opts: unknown, fn: () => Promise<unknown>) => fn()) };
    await expect(
      new MtfInterestCron(ledger as unknown as PaperLedgerService, jobs as unknown as JobRunnerService).run(new Date('2026-10-12T10:05:00.000Z')),
    ).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith('MTF interest 2026-10-12 failed: db down');
  });
});
