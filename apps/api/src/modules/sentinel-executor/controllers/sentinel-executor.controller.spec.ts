// apps/api/src/modules/sentinel-executor/controllers/sentinel-executor.controller.spec.ts
import { ForbiddenException } from '@nestjs/common';
import { SentinelExecutorController } from './sentinel-executor.controller';
import { toAiExitExecutionDto } from '../dto/ai-exit-execution.dto';

const row = {
  id: 'r1', userId: 'owner', verdictId: 'v1', trackerId: 't1', symbol: 'X', exchange: 'MCX', token: '1',
  side: 'SELL', quantity: 100, productType: 'CARRYFORWARD', orderType: 'MARKET', limitPrice: null,
  mode: 'dry-run', status: 'DRY_RUN', reason: 'would SELL', sessionSource: 'user-feed', brokerOrderId: null,
  brokerMessage: null, orderStatus: null, marketOrderId: null, verdictReason: 'thesis broken',
  createdAt: new Date('2026-10-12T10:00:00Z'), updatedAt: new Date('2026-10-12T10:00:01Z'),
};

describe('SentinelExecutorController', () => {
  const repo = { listForUser: jest.fn().mockResolvedValue([row]) };
  const ctl = new SentinelExecutorController(repo as never, {} as never, {} as never);
  afterEach(() => { delete process.env.AI_AUTO_EXIT_USER_IDS; repo.listForUser.mockClear(); });

  it('allow-listed user sees only their own rows, mapped to the DTO', async () => {
    process.env.AI_AUTO_EXIT_USER_IDS = 'owner';
    const out = await ctl.list({ userId: 'owner', role: 'USER', email: 'o@x' });
    expect(repo.listForUser).toHaveBeenCalledWith('owner', 20);
    expect(out[0]).toEqual(expect.objectContaining({ id: 'r1', status: 'DRY_RUN', createdAt: '2026-10-12T10:00:00.000Z' }));
    expect(out[0]).not.toHaveProperty('userId');
    expect(out[0]).not.toHaveProperty('token');
  });

  it('an admin not on the allow-list is allowed, still scoped to self', async () => {
    await ctl.list({ userId: 'admin1', role: 'ADMIN', email: 'a@x' });
    expect(repo.listForUser).toHaveBeenCalledWith('admin1', 20);
  });

  it('anyone else is 403 and nothing is read', async () => {
    process.env.AI_AUTO_EXIT_USER_IDS = 'owner';
    await expect(ctl.list({ userId: 'u2', role: 'USER', email: 'u@x' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(ctl.list(undefined as never)).rejects.toBeInstanceOf(ForbiddenException);
    expect(repo.listForUser).not.toHaveBeenCalled();
  });

  it('limit is clamped to 1..100', async () => {
    process.env.AI_AUTO_EXIT_USER_IDS = 'owner';
    await ctl.list({ userId: 'owner', role: 'USER', email: 'o@x' }, '1000');
    expect(repo.listForUser).toHaveBeenLastCalledWith('owner', 100);
    await ctl.list({ userId: 'owner', role: 'USER', email: 'o@x' }, 'abc');
    expect(repo.listForUser).toHaveBeenLastCalledWith('owner', 20);
    await ctl.list({ userId: 'owner', role: 'USER', email: 'o@x' }, '-5');
    expect(repo.listForUser).toHaveBeenLastCalledWith('owner', 20);
  });
});

describe('SentinelExecutorController — manual exit', () => {
  it('rows carry a trigger: AI for a sentinel verdict, MANUAL for the owner button', async () => {
    const repo = { listForUser: jest.fn().mockResolvedValue([row, { ...row, id: 'r2', verdictId: 'man_t1_1', verdictReason: 'MANUAL: owner exit' }]) };
    const ctl = new SentinelExecutorController(repo as never, {} as never, {} as never);
    const out = await ctl.list({ userId: 'admin1', role: 'ADMIN', email: 'a@x' });
    expect(out.map((r) => r.trigger)).toEqual(['AI', 'MANUAL']);
  });

  it('POST exit/:trackerId passes the JWT caller (never a body) and returns the row as a DTO without waiting for the broker', async () => {
    let finish: (v: unknown) => void = () => undefined;
    const done = new Promise((r) => { finish = r; });
    const manual = { request: jest.fn().mockResolvedValue({ row: { ...row, status: 'CLAIMED', verdictId: 'man_t1_1' }, started: true, done }) };
    const ctl = new SentinelExecutorController({} as never, {} as never, manual as never);
    const user = { userId: 'owner', role: 'ADMIN', email: 'o@x' };
    const out = await ctl.exit(user, 't1');
    expect(manual.request).toHaveBeenCalledWith(user, 't1');
    expect(out).toEqual(expect.objectContaining({ status: 'CLAIMED', trigger: 'MANUAL', verdictId: 'man_t1_1' }));
    finish({ status: 'FILLED' });
  });

  it('a rejected background run is logged, never an unhandled rejection', async () => {
    const manual = { request: jest.fn().mockResolvedValue({ row: { ...row, verdictId: 'man_t1_1' }, started: true, done: Promise.reject(new Error('db down')) }) };
    const ctl = new SentinelExecutorController({} as never, {} as never, manual as never);
    await expect(ctl.exit({ userId: 'owner', role: 'ADMIN', email: 'o@x' }, 't1')).resolves.toBeDefined();
    await new Promise((r) => setImmediate(r));
  });
});

describe('SentinelExecutorController — GET triggers (price triggers)', () => {
  const row = { id: 'trg1', userId: 'owner', trackerId: 't1', verdictId: 'v1', symbol: 'S', instrument: 'UNDERLYING', op: 'BELOW',
    price: 8930, watchExchange: 'MCX', watchToken: '472789', watchSymbol: 'CRUDEOIL19NOV26FUT', refPrice: 8951, status: 'ARMED',
    reason: null, armedAt: new Date('2026-10-13T17:03:00Z'), endedAt: null, firedAt: null, firedPrice: null, firedTickAt: null,
    createdAt: new Date('2026-10-13T17:03:00Z'), updatedAt: new Date('2026-10-13T17:03:00Z') };
  afterEach(() => { delete process.env.AI_AUTO_EXIT_USER_IDS; });

  it('the caller’s own rows only, as DTOs, limit clamped to 100', async () => {
    const listForUser = jest.fn().mockResolvedValue([row]);
    const c = new SentinelExecutorController({} as never, { listForUser } as never, {} as never);
    process.env.AI_AUTO_EXIT_USER_IDS = 'owner';
    const out = await c.triggers({ userId: 'owner', role: 'USER' } as never, '500');
    expect(listForUser).toHaveBeenCalledWith('owner', 100);
    expect(out[0]).toEqual(expect.objectContaining({ id: 'trg1', status: 'ARMED', watchSymbol: 'CRUDEOIL19NOV26FUT', armedAt: '2026-10-13T17:03:00.000Z' }));
    expect(out[0]).not.toHaveProperty('userId');
    expect(out[0]).not.toHaveProperty('watchToken');
  });

  it('403 for a non-admin outside the allow-list, before any query', async () => {
    const listForUser = jest.fn();
    const c = new SentinelExecutorController({} as never, { listForUser } as never, {} as never);
    process.env.AI_AUTO_EXIT_USER_IDS = 'owner';
    await expect(c.triggers({ userId: 'x', role: 'USER' } as never)).rejects.toThrow('not enabled');
    await expect(c.triggers(undefined as never)).rejects.toBeInstanceOf(ForbiddenException);
    expect(listForUser).not.toHaveBeenCalled();
  });
});

describe('AiExitExecutionDto.triggerId', () => {
  it('triggerId is the trigger row id for trg_ executions, null otherwise', () => {
    const base = { verdictId: 'trg_trg1', createdAt: new Date(0), updatedAt: new Date(0) } as never;
    expect(toAiExitExecutionDto({ ...(base as object), verdictId: 'trg_trg1' } as never)).toMatchObject({ trigger: 'PRICE_TRIGGER', triggerId: 'trg1' });
    expect(toAiExitExecutionDto({ ...(base as object), verdictId: 'cm9v' } as never)).toMatchObject({ trigger: 'AI', triggerId: null });
    expect(toAiExitExecutionDto({ ...(base as object), verdictId: 'man_t1_1' } as never)).toMatchObject({ trigger: 'MANUAL', triggerId: null });
  });
});
