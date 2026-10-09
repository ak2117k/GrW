import { ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma, type CoreStrategySelection } from '@prisma/client';
import type { AuditService } from '../../../../common/audit/audit.service';
import type { CoreStrategyRepository, VersionWithStrategy } from '../repositories/core-strategy.repository';
import type { CoreStrategySelectionRepository } from '../repositories/core-strategy-selection.repository';
import { plainBlocks } from '../testing/block-fixtures';
import { CoreStrategySelectionService } from './core-strategy-selection.service';

const T0 = new Date('2026-10-09T04:00:00.000Z');

function version(over: Partial<VersionWithStrategy> = {}): VersionWithStrategy {
  return {
    id: 'v1', strategyId: 's1', version: 1, blocks: plainBlocks() as unknown as Prisma.JsonValue, status: 'PAPER',
    createdBy: 'OWNER', approvedBy: 'usr_owner', approvedAt: T0, sourceDocId: null, notes: null, createdAt: T0, updatedAt: T0,
    strategy: { id: 's1', key: 'ungated', name: 'Ungated', description: 'd', allowedVehicles: ['CASH_INTRADAY'], createdAt: T0 },
    ...over,
  };
}

function selection(over: Partial<CoreStrategySelection> = {}): CoreStrategySelection {
  return { id: 'sel_1', userId: 'user_A', strategyId: 's1', strategyVersionId: 'v1', enabled: true, capitalAllocation: new Prisma.Decimal('100000'), createdAt: T0, updatedAt: T0, ...over };
}

function setup() {
  const selections = {
    listForUser: jest.fn().mockResolvedValue([selection()]),
    findForUser: jest.fn().mockResolvedValue(null),
    upsert: jest.fn().mockImplementation((userId, strategyId, data) => Promise.resolve(selection({ userId, strategyId, ...data }))),
  };
  const catalogue = { findVersion: jest.fn().mockResolvedValue(version()) };
  const audit = { append: jest.fn().mockResolvedValue({ seq: 1n, hash: 'h' }) };
  const service = new CoreStrategySelectionService(
    selections as unknown as CoreStrategySelectionRepository,
    catalogue as unknown as CoreStrategyRepository,
    audit as unknown as AuditService,
  );
  return { selections, catalogue, audit, service };
}

describe('CoreStrategySelectionService', () => {
  it("lists only the caller's selections, as wire DTOs", async () => {
    const { selections, service } = setup();
    expect(await service.list('user_A')).toEqual([
      { id: 'sel_1', strategyId: 's1', strategyVersionId: 'v1', enabled: true, capitalAllocation: 100000, updatedAt: T0.toISOString() },
    ]);
    expect(selections.listForUser).toHaveBeenCalledWith('user_A');
  });

  it('writes only the caller’s own selection, whatever the input carries, and audits before/after', async () => {
    const { selections, audit, service } = setup();
    selections.findForUser.mockResolvedValueOnce(selection({ enabled: false, capitalAllocation: new Prisma.Decimal(0) }));
    const smuggled = { strategyVersionId: 'v1', enabled: true, capitalAllocation: 250000, userId: 'user_B' } as never;
    const out = await service.set('user_A', 's1', smuggled);
    expect(selections.findForUser).toHaveBeenCalledWith('user_A', 's1');
    expect(selections.upsert).toHaveBeenCalledWith('user_A', 's1', { strategyVersionId: 'v1', enabled: true, capitalAllocation: new Prisma.Decimal('250000') });
    expect(selections.upsert.mock.calls[0][2].capitalAllocation).toBeInstanceOf(Prisma.Decimal);
    expect(out).toMatchObject({ strategyVersionId: 'v1', enabled: true, capitalAllocation: 250000 });
    expect(audit.append).toHaveBeenCalledWith({
      action: 'CORE_STRATEGY_SELECTION_CHANGED',
      userId: 'user_A',
      target: 'core_strategy_selection:sel_1',
      meta: {
        strategyKey: 'ungated',
        version: 1,
        // Audit meta records the exact 2-dp string, never a float.
        before: { strategyVersionId: 'v1', enabled: false, capitalAllocation: '0.00' },
        after: { strategyVersionId: 'v1', enabled: true, capitalAllocation: '250000.00' },
      },
    });
  });

  it('refuses a version that does not exist or belongs to another strategy (404)', async () => {
    const { catalogue, selections, service } = setup();
    catalogue.findVersion.mockResolvedValueOnce(null);
    await expect(service.set('user_A', 's1', { strategyVersionId: 'nope', enabled: false, capitalAllocation: 0 })).rejects.toBeInstanceOf(NotFoundException);
    catalogue.findVersion.mockResolvedValueOnce(version({ strategyId: 's2' }));
    await expect(service.set('user_A', 's1', { strategyVersionId: 'v1', enabled: false, capitalAllocation: 0 })).rejects.toBeInstanceOf(NotFoundException);
    expect(selections.upsert).not.toHaveBeenCalled();
  });

  it('only a PAPER version can be selected', async () => {
    const { catalogue, selections, audit, service } = setup();
    for (const status of ['DRAFT', 'RETIRED', 'LIVE']) {
      catalogue.findVersion.mockResolvedValueOnce(version({ status }));
      await expect(service.set('user_A', 's1', { strategyVersionId: 'v1', enabled: true, capitalAllocation: 1000 })).rejects.toBeInstanceOf(ConflictException);
    }
    catalogue.findVersion.mockResolvedValueOnce(version({ status: 'DRAFT' }));
    await expect(service.set('user_A', 's1', { strategyVersionId: 'v1', enabled: false, capitalAllocation: 1000 })).rejects.toBeInstanceOf(ConflictException);
    expect(selections.upsert).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
  });

  it('a selection already on a retired version can be switched off', async () => {
    const { catalogue, selections, service } = setup();
    catalogue.findVersion.mockResolvedValueOnce(version({ status: 'RETIRED' }));
    selections.findForUser.mockResolvedValueOnce(selection({ strategyVersionId: 'v1', enabled: true }));
    await service.set('user_A', 's1', { strategyVersionId: 'v1', enabled: false, capitalAllocation: 100000 });
    expect(selections.upsert).toHaveBeenCalledWith('user_A', 's1', { strategyVersionId: 'v1', enabled: false, capitalAllocation: new Prisma.Decimal('100000') });
  });

  it('enabling needs a capital allocation above 0; any capital must be a finite number ≥ 0, ≤ 2 dp, below 10^12', async () => {
    const { selections, service } = setup();
    await expect(service.set('user_A', 's1', { strategyVersionId: 'v1', enabled: true, capitalAllocation: 0 })).rejects.toBeInstanceOf(UnprocessableEntityException);
    for (const bad of [-1, NaN, Infinity, 1.234, 0.001, 1e-7, 1e12, 1e21]) {
      await expect(service.set('user_A', 's1', { strategyVersionId: 'v1', enabled: false, capitalAllocation: bad })).rejects.toBeInstanceOf(UnprocessableEntityException);
    }
    await service.set('user_A', 's1', { strategyVersionId: 'v1', enabled: false, capitalAllocation: 0 });
    expect(selections.upsert).toHaveBeenCalledTimes(1);
  });

  it('stores 1234.56 exactly and returns it as a 2-dp JSON number; audit gets the exact string', async () => {
    const { selections, audit, service } = setup();
    const out = await service.set('user_A', 's1', { strategyVersionId: 'v1', enabled: true, capitalAllocation: 1234.56 });
    const written = selections.upsert.mock.calls[0][2].capitalAllocation as Prisma.Decimal;
    expect(written).toBeInstanceOf(Prisma.Decimal);
    expect(written.toFixed(2)).toBe('1234.56');
    expect(out.capitalAllocation).toBe(1234.56);
    expect(audit.append.mock.calls[0][0].meta.after.capitalAllocation).toBe('1234.56');
    await service.set('user_A', 's1', { strategyVersionId: 'v1', enabled: true, capitalAllocation: 999999999999.99 });
    expect((selections.upsert.mock.calls[1][2].capitalAllocation as Prisma.Decimal).toFixed(2)).toBe('999999999999.99');
  });

  it('the enabled-needs-capital rule compares exact Decimals: ₹0.01 is enough', async () => {
    const { service } = setup();
    await expect(service.set('user_A', 's1', { strategyVersionId: 'v1', enabled: true, capitalAllocation: 0.01 })).resolves.toMatchObject({ capitalAllocation: 0.01 });
  });

  it('a concurrent first write for the same strategy is a 409 to retry, and nothing is audited', async () => {
    const { selections, audit, service } = setup();
    selections.upsert.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test' }));
    const err = await service.set('user_A', 's1', { strategyVersionId: 'v1', enabled: true, capitalAllocation: 100000 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).message).toBe('selection changed at the same time; retry');
    const other = new Error('db down');
    selections.upsert.mockRejectedValueOnce(other);
    await expect(service.set('user_A', 's1', { strategyVersionId: 'v1', enabled: true, capitalAllocation: 100000 })).rejects.toBe(other);
    expect(audit.append).not.toHaveBeenCalled();
  });
});
