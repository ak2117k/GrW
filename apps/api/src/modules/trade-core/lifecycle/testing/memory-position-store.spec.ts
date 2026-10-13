import { ActivePositionExistsError } from '../repositories/core-position.repository';
import { cashPlan, NOW } from './lifecycle-fixtures';
import { MemoryPositionStore } from './memory-position-store';
import type { NewPositionRow } from '../lifecycle.types';

const row = (over: Partial<NewPositionRow> = {}): NewPositionRow => ({
  userId: 'user_A',
  intentId: 'int_1',
  strategyId: 'cs_ungated',
  strategyVersionId: 'csv_ungated_v1',
  vehicle: 'CASH_INTRADAY',
  instrument: { exchange: 'NSE', token: '2885', symbol: 'RELIANCE-EQ', lotSize: 1, underlying: null },
  underlying: 'RELIANCE',
  side: 'BUY',
  direction: 'LONG',
  requestedQty: 100,
  plan: cashPlan(),
  ...over,
});

describe('MemoryPositionStore (the CorePositionRepository contract)', () => {
  it('creates PENDING_ENTRY with version 0 and nothing filled', async () => {
    const s = new MemoryPositionStore(() => NOW);
    const p = await s.repo.createIfNoActive(row());
    expect(p).toMatchObject({ status: 'PENDING_ENTRY', version: 0, entryFilledQty: 0, exitFilledQty: 0, openQty: 0, exitSeq: 0, underlying: 'RELIANCE' });
    expect(await s.repo.findByIntent('int_1')).toEqual(p);
  });

  it('refuses a second active position on the same instrument, and allows one after it closes', async () => {
    const s = new MemoryPositionStore(() => NOW);
    const p = await s.repo.createIfNoActive(row());
    await expect(s.repo.createIfNoActive(row({ intentId: 'int_2' }))).rejects.toBeInstanceOf(ActivePositionExistsError);
    await expect(s.repo.createIfNoActive(row({ intentId: 'int_3', userId: 'user_B' }))).resolves.toMatchObject({ userId: 'user_B' });
    await s.repo.update('user_A', p.id, 0, { status: 'CANCELLED', closedAt: NOW });
    await expect(s.repo.createIfNoActive(row({ intentId: 'int_4' }))).resolves.toMatchObject({ intentId: 'int_4' });
  });

  it('updates only at the expected version, bumps it, and recomputes openQty', async () => {
    const s = new MemoryPositionStore(() => NOW);
    const p = await s.repo.createIfNoActive(row());
    const u = await s.repo.update('user_A', p.id, 0, { status: 'OPEN', entryFilledQty: 100, entryAvgPrice: 500 });
    expect(u).toMatchObject({ version: 1, openQty: 100, status: 'OPEN' });
    expect(await s.repo.update('user_A', p.id, 0, { status: 'EXITING' })).toBeNull();
    expect(await s.repo.update('user_B', p.id, 1, { status: 'EXITING' })).toBeNull();
  });

  it("scopes reads to the user; system scans see every user's active positions", async () => {
    const s = new MemoryPositionStore(() => NOW);
    const a = await s.repo.createIfNoActive(row());
    await s.repo.createIfNoActive(row({ intentId: 'int_b', userId: 'user_B' }));
    expect(await s.repo.findForUser('user_B', a.id)).toBeNull();
    expect((await s.repo.listActive()).map((p) => p.userId)).toEqual(['user_A', 'user_B']);
    expect(await s.repo.listActiveUserIds()).toEqual(['user_A', 'user_B']);
    await s.repo.update('user_A', a.id, 0, { status: 'CANCELLED', closedAt: NOW });
    expect(await s.repo.listActiveUserIds()).toEqual(['user_B']);
    expect((await s.repo.listForUser('user_A', new Date(NOW.getTime() - 1000))).map((p) => p.id)).toEqual([a.id]);
    expect(await s.repo.listForUser('user_A', new Date(NOW.getTime() + 1000))).toEqual([]);
  });

  it('returns copies', async () => {
    const s = new MemoryPositionStore(() => NOW);
    const p = await s.repo.createIfNoActive(row());
    p.plan.stopPct = 99;
    expect((await s.repo.findForUser('user_A', p.id))?.plan.stopPct).toBe(1.5);
  });
});

describe('M5 reads', () => {
  it('lastOpenedAt is the newest openedAt of this strategy on the token; closed-since is newest first; user ids since', async () => {
    const s = new MemoryPositionStore(() => new Date('2026-10-13T05:00:00.000Z'));
    const base = {
      userId: 'user_A', strategyId: 'cs_x', strategyVersionId: 'csv_x', vehicle: 'CASH_INTRADAY' as const,
      instrument: { exchange: 'NSE', token: '2885', symbol: 'RELIANCE-EQ', lotSize: 1, underlying: null },
      underlying: 'RELIANCE', side: 'BUY' as const, direction: 'LONG' as const, requestedQty: 10, plan: cashPlan(),
    };
    const a = await s.repo.createIfNoActive({ ...base, intentId: 'i1' });
    await s.repo.update('user_A', a.id, a.version, { openedAt: new Date('2026-10-13T04:00:00.000Z'), status: 'CLOSED', closedAt: new Date('2026-10-13T04:30:00.000Z') });
    const b = await s.repo.createIfNoActive({ ...base, intentId: 'i2' });
    await s.repo.update('user_A', b.id, b.version, { openedAt: new Date('2026-10-13T04:45:00.000Z'), status: 'CLOSED', closedAt: new Date('2026-10-13T04:50:00.000Z') });
    expect(await s.repo.lastOpenedAt('user_A', 'cs_x', '2885')).toEqual(new Date('2026-10-13T04:45:00.000Z'));
    expect(await s.repo.lastOpenedAt('user_A', 'cs_other', '2885')).toBeNull();
    expect((await s.repo.listClosedSince('user_A', 'cs_x', '2885', new Date('2026-10-12T18:30:00.000Z'))).map((p) => p.intentId)).toEqual(['i2', 'i1']);
    expect(await s.repo.listUserIdsSince(new Date('2026-10-12T18:30:00.000Z'))).toEqual(['user_A']);
  });
});
