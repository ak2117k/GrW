// apps/api/src/modules/sentinel-executor/services/manual-exit.service.spec.ts
import { ForbiddenException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { ManualExitService } from './manual-exit.service';
import { SentinelExitExecutor } from './sentinel-exit-executor.service';
import { istDayStartUtc } from '../domain/exit-order';
import { CLAIM_STALE_MS } from '../domain/claim-timing';

const NOW = new Date('2026-10-12T10:00:00Z');
const OWNER = { userId: 'owner', role: 'ADMIN', email: 'o@x' };
const ENV = { AI_AUTO_EXIT_QTY_UNITS: 'NFO:units,BFO:units,MCX:units' };
const TRACKER = { id: 't1', userId: 'owner', symbol: 'CRUDEOIL15OCT268950CE', status: 'OPEN', kind: 'POSITION', exchange: 'MCX', token: '445566', qty: 100 };
const env = (data: unknown) => ({ status: true, data });
const posRow = (netqty: string) => ({
  tradingsymbol: 'CRUDEOIL15OCT268950CE', symboltoken: '445566', exchange: 'MCX', producttype: 'CARRYFORWARD', netqty, ltp: '50',
});

type Row = { id: string; userId: string; verdictId: string; trackerId: string; status: string; reason: string | null;
  mode: string; verdictReason: string; createdAt: Date; exchange?: string | null; token?: string | null };

/** In-memory ai_exit_executions honouring the UNIQUE(verdictId) the idempotency relies on. */
function memRepo() {
  const rows: Row[] = [];
  let n = 0;
  const tick = () => new Promise<void>((r) => setImmediate(r)); // let concurrent requests interleave
  const repo = {
    rows,
    sweepInterrupted: jest.fn(async () => 0),
    findActiveManual: jest.fn(async (trackerId: string, userId: string) => {
      await tick();
      return [...rows].reverse().find((r) => r.trackerId === trackerId && r.userId === userId
        && r.verdictId.startsWith('man_') && (r.status === 'CLAIMED' || r.status === 'PLACED')) ?? null;
    }),
    countManualForTracker: jest.fn(async (trackerId: string) => {
      await tick();
      return rows.filter((r) => r.trackerId === trackerId && r.verdictId.startsWith('man_')).length;
    }),
    claim: jest.fn(async (v: { id: string; userId: string; trackerId: string; reason: string }, mode: string) => {
      await tick();
      if (rows.some((r) => r.verdictId === v.id)) return null;
      const id = `row${++n}`;
      rows.push({ id, userId: v.userId, verdictId: v.id, trackerId: v.trackerId, status: 'CLAIMED', reason: null,
        mode, verdictReason: v.reason, createdAt: NOW });
      return id;
    }),
    findById: jest.fn(async (id: string) => rows.find((r) => r.id === id) ?? null),
    findByVerdictId: jest.fn(async (verdictId: string) => rows.find((r) => r.verdictId === verdictId) ?? null),
    update: jest.fn(async (id: string, patch: Partial<Row>) => { Object.assign(rows.find((r) => r.id === id)!, patch); }),
    countCountedSince: jest.fn(async () => 0),
    hasInFlight: jest.fn(async (trackerId: string, excludeId: string, now: Date) =>
      rows.some((r) => r.id !== excludeId && r.trackerId === trackerId
        && (r.status === 'CLAIMED' || (r.createdAt >= istDayStartUtc(now) && r.status === 'PLACED')))),
  };
  return repo;
}

function harness(opts: { tracker?: unknown; book?: unknown[] } = {}) {
  const repo = memRepo();
  const prisma = {
    tradeTracker: { findUnique: jest.fn(async () => (opts.tracker === undefined ? TRACKER : opts.tracker)) },
    instrument: { findFirst: jest.fn(async () => ({ tickSize: 100, lotSize: null })) },
  };
  let flat = false;
  const session = {
    getPositionsEnvelope: jest.fn(async () => env([posRow(flat ? '0' : '100')])),
    getOrderBookEnvelope: jest.fn(async () => env(opts.book ?? [])),
    placeOrderClassified: jest.fn(async () => { flat = true; return { status: 'PLACED', orderId: 'O1', message: 'SUCCESS' }; }),
  };
  const sessions = { withOwnerSession: jest.fn(async (_u: string, fn: any) => fn(session, 'user-feed')) };
  const executor = new SentinelExitExecutor(
    repo as never, prisma as never, sessions as never, { isOpen: () => true } as never, async () => undefined,
  );
  const svc = new ManualExitService(repo as never, prisma as never, executor);
  return { svc, repo, prisma, session, sessions, executor };
}

describe('ManualExitService', () => {
  it('owner (ADMIN) on an open MCX long: claims man_<tracker>_1 as a live MANUAL row, then ONE SELL MARKET tagged am…', async () => {
    const h = harness();
    const r = await h.svc.request(OWNER, 't1', { now: NOW, env: ENV });
    expect(r.started).toBe(true);
    expect(r.row).toEqual(expect.objectContaining({ verdictId: 'man_t1_1', mode: 'live', status: 'CLAIMED' }));
    expect(r.row.verdictReason.startsWith('MANUAL:')).toBe(true);
    await expect(r.done).resolves.toEqual({ status: 'FILLED' });
    expect(h.session.placeOrderClassified).toHaveBeenCalledTimes(1);
    const [order, tag] = h.session.placeOrderClassified.mock.calls[0] as unknown as [any, string];
    expect(order).toEqual(expect.objectContaining({ side: 'SELL', quantity: 100, orderType: 'MARKET' }));
    expect(tag.startsWith('amM')).toBe(true);
    // Never counted toward the AI cap.
    expect(h.repo.countCountedSince).not.toHaveBeenCalled();
  });

  it('an allow-listed non-admin may use it', async () => {
    const h = harness();
    const r = await h.svc.request({ userId: 'owner', role: 'USER', email: 'o@x' }, 't1', {
      now: NOW, env: { ...ENV, AI_AUTO_EXIT_USER_IDS: 'owner' },
    });
    await r.done;
    expect(h.session.placeOrderClassified).toHaveBeenCalledTimes(1);
  });

  it('a double click (two concurrent requests) yields ONE attempt and ONE order; both get the same row', async () => {
    const h = harness();
    const [a, b] = await Promise.all([
      h.svc.request(OWNER, 't1', { now: NOW, env: ENV }),
      h.svc.request(OWNER, 't1', { now: NOW, env: ENV }),
    ]);
    await Promise.all([a.done, b.done]);
    expect(a.row.id).toBe(b.row.id);
    expect([a.started, b.started].filter(Boolean)).toHaveLength(1);
    expect(h.repo.rows).toHaveLength(1);
    expect(h.session.placeOrderClassified).toHaveBeenCalledTimes(1);
  });

  it('a second request while the first is in flight returns the existing attempt, no new row', async () => {
    const h = harness();
    h.repo.rows.push({ id: 'row9', userId: 'owner', verdictId: 'man_t1_1', trackerId: 't1', status: 'PLACED', reason: null,
      mode: 'live', verdictReason: 'MANUAL: owner exit', createdAt: NOW });
    const r = await h.svc.request(OWNER, 't1', { now: NOW, env: ENV });
    expect(r.started).toBe(false);
    expect(r.row.id).toBe('row9');
    expect(h.repo.claim).not.toHaveBeenCalled();
    expect(h.sessions.withOwnerSession).not.toHaveBeenCalled();
  });

  it('a retry after a SKIPPED attempt makes a new attempt (man_t1_2) that goes through every guard again', async () => {
    const h = harness();
    h.repo.rows.push({ id: 'row9', userId: 'owner', verdictId: 'man_t1_1', trackerId: 't1', status: 'SKIPPED', reason: 'EXCHANGE_CLOSED',
      mode: 'live', verdictReason: 'MANUAL: owner exit', createdAt: NOW });
    const r = await h.svc.request(OWNER, 't1', { now: NOW, env: ENV });
    expect(r.row.verdictId).toBe('man_t1_2');
    await r.done;
    expect(h.session.placeOrderClassified).toHaveBeenCalledTimes(1);
  });

  it('an open order on the contract → the attempt ends SKIPPED: OPEN_ORDER_EXISTS, no order', async () => {
    const h = harness({ book: [{ orderid: 'X', status: 'open', symboltoken: '445566', exchange: 'MCX' }] });
    const r = await h.svc.request(OWNER, 't1', { now: NOW, env: ENV });
    await expect(r.done).resolves.toEqual({ status: 'SKIPPED', reason: 'OPEN_ORDER_EXISTS' });
    expect(h.session.placeOrderClassified).not.toHaveBeenCalled();
  });

  it('a user who is neither ADMIN nor allow-listed → 403, nothing read or claimed', async () => {
    const h = harness();
    await expect(h.svc.request({ userId: 'u2', role: 'USER', email: 'u@x' }, 't1', { now: NOW, env: ENV }))
      .rejects.toBeInstanceOf(ForbiddenException);
    await expect(h.svc.request(undefined as never, 't1', { now: NOW, env: ENV })).rejects.toBeInstanceOf(ForbiddenException);
    expect(h.prisma.tradeTracker.findUnique).not.toHaveBeenCalled();
    expect(h.repo.claim).not.toHaveBeenCalled();
  });

  it("another user's tracker, or a missing one → 404, nothing claimed", async () => {
    const other = harness({ tracker: { ...TRACKER, userId: 'someone-else' } });
    await expect(other.svc.request(OWNER, 't1', { now: NOW, env: ENV })).rejects.toBeInstanceOf(NotFoundException);
    const missing = harness({ tracker: null });
    await expect(missing.svc.request(OWNER, 't1', { now: NOW, env: ENV })).rejects.toBeInstanceOf(NotFoundException);
    expect(other.repo.claim).not.toHaveBeenCalled();
    expect(missing.repo.claim).not.toHaveBeenCalled();
  });

  it.each<[string, Record<string, unknown>]>([
    ['TRACKER_CLOSED', { status: 'CLOSED' }],
    ['NOT_POSITION', { kind: 'HOLDING' }],
    ['EXCHANGE_NOT_FNO', { exchange: 'NSE' }],
  ])('%s → 422, nothing claimed', async (reason, over) => {
    const h = harness({ tracker: { ...TRACKER, ...over } });
    const err = await h.svc.request(OWNER, 't1', { now: NOW, env: ENV }).catch((e) => e);
    expect(err).toBeInstanceOf(UnprocessableEntityException);
    expect(String(err.message)).toContain(reason);
    expect(h.repo.claim).not.toHaveBeenCalled();
  });

  it('no configured qty unit for the exchange (MCX has no default) → 422 QTY_UNIT_UNCONFIGURED:MCX, nothing claimed', async () => {
    const h = harness();
    const err = await h.svc.request(OWNER, 't1', { now: NOW, env: {} }).catch((e) => e);
    expect(err).toBeInstanceOf(UnprocessableEntityException);
    expect(String(err.message)).toContain('QTY_UNIT_UNCONFIGURED:MCX');
    expect(h.repo.claim).not.toHaveBeenCalled();
    expect(h.session.placeOrderClassified).not.toHaveBeenCalled();
  });

  it('places even when AI_AUTO_EXIT_ENABLED is off and AI_AUTO_EXIT_MODE is dry-run (the owner order is always live)', async () => {
    const h = harness();
    const r = await h.svc.request(OWNER, 't1', {
      now: NOW, env: { ...ENV, AI_AUTO_EXIT_ENABLED: 'false', AI_AUTO_EXIT_MODE: 'dry-run', AI_AUTO_EXIT_DAILY_CAP: '0' },
    });
    await expect(r.done).resolves.toEqual({ status: 'FILLED' });
    expect(h.session.placeOrderClassified).toHaveBeenCalledTimes(1);
  });

  it('sweeps CLAIMED rows older than the shared stale bound (>= 180 s) first, so a crashed attempt cannot block the button forever', async () => {
    const h = harness();
    await (await h.svc.request(OWNER, 't1', { now: NOW, env: ENV })).done;
    expect(CLAIM_STALE_MS).toBeGreaterThanOrEqual(180_000);
    expect(h.repo.sweepInterrupted).toHaveBeenCalledWith(new Date(NOW.getTime() - CLAIM_STALE_MS));
  });
});
