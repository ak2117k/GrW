import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ROLES_KEY, type AuthenticatedUser } from '../../../../common/decorators';
import type { CoreStrategyCatalogueService } from '../services/core-strategy-catalogue.service';
import type { CoreStrategySelectionService } from '../services/core-strategy-selection.service';
import { Prisma } from '@prisma/client';
import { CreateDraftDto, SetSelectionDto, SetVersionStatusDto, toSelectionDto } from '../dto/core-strategy.dto';
import { CoreStrategiesController } from './core-strategies.controller';

const OWNER: AuthenticatedUser = { userId: 'usr_owner', role: 'ADMIN', email: 'o@x' };
const USER_A: AuthenticatedUser = { userId: 'user_A', role: 'USER', email: 'a@x' };

function setup() {
  const catalogue = {
    list: jest.fn().mockResolvedValue([]),
    createDraft: jest.fn().mockResolvedValue({ id: 'v2' }),
    editVersion: jest.fn().mockResolvedValue({ version: { id: 'v1' }, created: false }),
    approve: jest.fn().mockResolvedValue({ id: 'v1', status: 'PAPER' }),
    setStatus: jest.fn().mockResolvedValue({ id: 'v1', status: 'RETIRED' }),
  };
  const selections = { list: jest.fn().mockResolvedValue([]), set: jest.fn().mockResolvedValue({ id: 'sel_1' }) };
  const controller = new CoreStrategiesController(
    catalogue as unknown as CoreStrategyCatalogueService,
    selections as unknown as CoreStrategySelectionService,
  );
  return { catalogue, selections, controller };
}

const rolesOf = (method: keyof CoreStrategiesController) =>
  Reflect.getMetadata(ROLES_KEY, CoreStrategiesController.prototype[method]) as string[] | undefined;

describe('CoreStrategiesController', () => {
  it('every catalogue write route is @AdminOnly; reads and selections are not', () => {
    for (const m of ['createDraft', 'edit', 'approve', 'setStatus'] as const) expect(rolesOf(m)).toEqual(['ADMIN']);
    for (const m of ['list', 'listSelections', 'setSelection'] as const) expect(rolesOf(m)).toBeUndefined();
  });

  it('passes the caller as the actor for listing and mode changes', async () => {
    const { catalogue, controller } = setup();
    await controller.list(USER_A);
    expect(catalogue.list).toHaveBeenCalledWith({ userId: 'user_A', role: 'USER' });
    await controller.approve(OWNER, 'v1');
    expect(catalogue.approve).toHaveBeenCalledWith('v1', { userId: 'usr_owner', role: 'ADMIN' });
    await controller.setStatus(OWNER, 'v1', { status: 'RETIRED' });
    expect(catalogue.setStatus).toHaveBeenCalledWith('v1', 'RETIRED', { userId: 'usr_owner', role: 'ADMIN' });
  });

  it('a REST draft is always created by OWNER, with notes defaulting to null, audited as the token user', async () => {
    const { catalogue, controller } = setup();
    await controller.createDraft('u1', 's1', { blocks: { a: 1 } });
    expect(catalogue.createDraft).toHaveBeenCalledWith('s1', { blocks: { a: 1 }, notes: null }, 'OWNER', 'u1');
    await controller.edit('u1', 'v1', { notes: 'n' });
    expect(catalogue.editVersion).toHaveBeenCalledWith('v1', { blocks: undefined, notes: 'n' }, 'u1');
  });

  it('selection routes take the user from the token, never from the path or body', async () => {
    const { selections, controller } = setup();
    await controller.listSelections('user_A');
    expect(selections.list).toHaveBeenCalledWith('user_A');
    const body = { strategyVersionId: 'v1', enabled: true, capitalAllocation: 1000 };
    await controller.setSelection('user_A', 's1', body);
    expect(selections.set).toHaveBeenCalledWith('user_A', 's1', body);
  });
});

describe('request DTOs', () => {
  it('SetSelectionDto strips a smuggled userId and refuses strings, NaN, negatives, > 2 dp and ≥ 10^12 for capital', async () => {
    const dto = plainToInstance(SetSelectionDto, { strategyVersionId: 'v1', enabled: true, capitalAllocation: 1000, userId: 'user_B' });
    expect(await validate(dto, { whitelist: true })).toEqual([]);
    expect((dto as unknown as Record<string, unknown>).userId).toBeUndefined();
    for (const good of [0, 0.01, 1234.56, 999999999999.99]) {
      expect(await validate(plainToInstance(SetSelectionDto, { strategyVersionId: 'v1', enabled: true, capitalAllocation: good }))).toEqual([]);
    }
    for (const bad of ['1000', NaN, -1, Infinity, 1.234, 0.001, 1e-7, 1e12, 1e21, null, undefined]) {
      const errs = await validate(plainToInstance(SetSelectionDto, { strategyVersionId: 'v1', enabled: true, capitalAllocation: bad }));
      expect(errs.map((e) => e.property)).toEqual(['capitalAllocation']);
    }
  });

  it('CreateDraftDto strips createdBy and status', async () => {
    const dto = plainToInstance(CreateDraftDto, { blocks: { entry: {} }, createdBy: 'AI', status: 'PAPER' });
    expect(await validate(dto, { whitelist: true })).toEqual([]);
    expect(dto).toEqual({ blocks: { entry: {} } });
  });

  it('SetVersionStatusDto accepts only the four statuses', async () => {
    expect(await validate(plainToInstance(SetVersionStatusDto, { status: 'RETIRED' }))).toEqual([]);
    expect(await validate(plainToInstance(SetVersionStatusDto, { status: 'ARCHIVED' }))).toHaveLength(1);
  });
});

describe('toSelectionDto', () => {
  it('returns the Decimal(14,2) capital as a JSON number with 2 dp', () => {
    const T = new Date('2026-10-09T04:00:00.000Z');
    const row = { id: 'sel', userId: 'u', strategyId: 's1', strategyVersionId: 'v1', enabled: true, createdAt: T, updatedAt: T };
    for (const [stored, wire] of [['1234.56', 1234.56], ['0', 0], ['0.10', 0.1], ['999999999999.99', 999999999999.99]] as const) {
      const out = toSelectionDto({ ...row, capitalAllocation: new Prisma.Decimal(stored) });
      expect(typeof out.capitalAllocation).toBe('number');
      expect(out.capitalAllocation).toBe(wire);
      expect(out.capitalAllocation.toFixed(2)).toBe(new Prisma.Decimal(stored).toFixed(2));
    }
  });
});
