// apps/api/src/modules/sentinel-executor/controllers/sentinel-executor.controller.spec.ts
import { ForbiddenException } from '@nestjs/common';
import { SentinelExecutorController } from './sentinel-executor.controller';

const row = {
  id: 'r1', userId: 'owner', verdictId: 'v1', trackerId: 't1', symbol: 'X', exchange: 'MCX', token: '1',
  side: 'SELL', quantity: 100, productType: 'CARRYFORWARD', orderType: 'MARKET', limitPrice: null,
  mode: 'dry-run', status: 'DRY_RUN', reason: 'would SELL', sessionSource: 'user-feed', brokerOrderId: null,
  brokerMessage: null, orderStatus: null, marketOrderId: null, verdictReason: 'thesis broken',
  createdAt: new Date('2026-10-12T10:00:00Z'), updatedAt: new Date('2026-10-12T10:00:01Z'),
};

describe('SentinelExecutorController', () => {
  const repo = { listForUser: jest.fn().mockResolvedValue([row]) };
  const ctl = new SentinelExecutorController(repo as never);
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
