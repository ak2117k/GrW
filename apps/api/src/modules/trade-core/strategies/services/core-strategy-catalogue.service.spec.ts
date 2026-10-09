import { ConflictException, ForbiddenException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma, type CoreStrategy } from '@prisma/client';
import type { AuditService } from '../../../../common/audit/audit.service';
import type { CoreStrategyRepository, VersionWithStrategy } from '../repositories/core-strategy.repository';
import { adaptiveBlocks, plainBlocks } from '../testing/block-fixtures';
import { CoreStrategyCatalogueService, type Actor } from './core-strategy-catalogue.service';

const OWNER: Actor = { userId: 'usr_owner', role: 'ADMIN' };
const USER: Actor = { userId: 'usr_a', role: 'USER' };
const T0 = new Date('2026-10-09T04:00:00.000Z');

function strategy(over: Partial<CoreStrategy> = {}): CoreStrategy {
  return { id: 's1', key: 'ungated', name: 'Ungated', description: 'd', allowedVehicles: ['CASH_INTRADAY'], createdAt: T0, ...over };
}

function version(over: Partial<VersionWithStrategy> = {}): VersionWithStrategy {
  return {
    id: 'v1', strategyId: 's1', version: 1, blocks: plainBlocks() as unknown as Prisma.JsonValue, status: 'DRAFT',
    createdBy: 'OWNER', approvedBy: null, approvedAt: null, sourceDocId: null, notes: null,
    createdAt: T0, updatedAt: T0, strategy: strategy(), ...over,
  };
}

function setup() {
  const repo = {
    listWithVersions: jest.fn().mockResolvedValue([]),
    findStrategy: jest.fn().mockResolvedValue(strategy()),
    findVersion: jest.fn().mockResolvedValue(version()),
    nextVersionNumber: jest.fn().mockResolvedValue(2),
    createVersion: jest.fn().mockImplementation((d) => Promise.resolve({ ...version(), ...d, id: 'v_new', status: 'DRAFT', strategy: undefined })),
    updateDraft: jest.fn().mockResolvedValue(true),
    transition: jest.fn().mockResolvedValue(true),
  };
  const audit = { append: jest.fn().mockResolvedValue({ seq: 1n, hash: 'h' }) };
  const service = new CoreStrategyCatalogueService(repo as unknown as CoreStrategyRepository, audit as unknown as AuditService);
  return { repo, audit, service };
}

describe('CoreStrategyCatalogueService.list', () => {
  it('shows a user only approved (PAPER) versions and the owner every version', async () => {
    const { repo, service } = setup();
    repo.listWithVersions.mockResolvedValue([{ ...strategy(), versions: [version({ status: 'PAPER', approvedAt: T0, approvedBy: 'usr_owner' })] }]);
    const out = await service.list(USER);
    expect(repo.listWithVersions).toHaveBeenCalledWith(['PAPER']);
    expect(out[0].versions[0]).toMatchObject({ id: 'v1', status: 'PAPER', approvedAt: T0.toISOString(), createdAt: T0.toISOString() });
    await service.list(OWNER);
    expect(repo.listWithVersions).toHaveBeenLastCalledWith(undefined);
  });
});

describe('CoreStrategyCatalogueService.createDraft', () => {
  it('creates the next version number as an OWNER draft', async () => {
    const { repo, service } = setup();
    const out = await service.createDraft('s1', { blocks: plainBlocks(), notes: 'try 2' });
    expect(repo.createVersion).toHaveBeenCalledWith({ strategyId: 's1', version: 2, blocks: plainBlocks(), createdBy: 'OWNER', notes: 'try 2' });
    expect(out).toMatchObject({ id: 'v_new', version: 2, status: 'DRAFT', createdBy: 'OWNER' });
  });

  it('createDraft is OWNER unless the caller says AI', async () => {
    const { repo, service } = setup();
    await service.createDraft('s1', { blocks: plainBlocks(), notes: null }, 'AI');
    expect(repo.createVersion).toHaveBeenCalledWith(expect.objectContaining({ createdBy: 'AI' }));
  });

  it('refuses an unknown strategy (404) and invalid blocks (422, naming the path), writing nothing', async () => {
    const { repo, service } = setup();
    repo.findStrategy.mockResolvedValueOnce(null);
    await expect(service.createDraft('nope', { blocks: plainBlocks(), notes: null })).rejects.toBeInstanceOf(NotFoundException);
    const bad = { ...plainBlocks(), stop: { kind: 'fixedPct', pct: -1 } };
    await expect(service.createDraft('s1', { blocks: bad, notes: null })).rejects.toThrow(/stop\.pct/);
    await expect(service.createDraft('s1', { blocks: bad, notes: null })).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(service.createDraft('s1', { blocks: adaptiveBlocks(), notes: null })).resolves.toBeDefined();
    repo.findStrategy.mockResolvedValueOnce(strategy({ allowedVehicles: ['MTF'] }));
    await expect(service.createDraft('s1', { blocks: plainBlocks(), notes: null })).rejects.toThrow(/vehicle\.kind/);
    expect(repo.createVersion).toHaveBeenCalledTimes(1);
  });

  it('reports a concurrent create of the same version number as 409', async () => {
    const { repo, service } = setup();
    repo.createVersion.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test' }));
    await expect(service.createDraft('s1', { blocks: plainBlocks(), notes: null })).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('CoreStrategyCatalogueService.editVersion', () => {
  it('edits a DRAFT in place and keeps unspecified fields', async () => {
    const { repo, service } = setup();
    repo.findVersion.mockResolvedValueOnce(version({ notes: 'keep' })).mockResolvedValueOnce(version({ notes: 'keep', blocks: adaptiveBlocks() as unknown as Prisma.JsonValue }));
    const out = await service.editVersion('v1', { blocks: adaptiveBlocks() });
    expect(repo.updateDraft).toHaveBeenCalledWith('v1', { blocks: adaptiveBlocks(), notes: 'keep' });
    expect(repo.createVersion).not.toHaveBeenCalled();
    expect(out.created).toBe(false);
  });

  it('editing a PAPER version creates version n+1 and never touches the original', async () => {
    const { repo, service } = setup();
    repo.findVersion.mockResolvedValueOnce(version({ status: 'PAPER', notes: 'v1 notes' }));
    const out = await service.editVersion('v1', { notes: 'v2 notes' });
    expect(repo.updateDraft).not.toHaveBeenCalled();
    expect(repo.transition).not.toHaveBeenCalled();
    expect(repo.createVersion).toHaveBeenCalledWith({ strategyId: 's1', version: 2, blocks: plainBlocks(), createdBy: 'OWNER', notes: 'v2 notes' });
    expect(out).toMatchObject({ created: true, version: { id: 'v_new', version: 2, status: 'DRAFT' } });
  });

  it('a draft approved while it was being edited becomes n+1, not an overwrite', async () => {
    const { repo, service } = setup();
    repo.updateDraft.mockResolvedValueOnce(false);
    const out = await service.editVersion('v1', { notes: 'late edit' });
    expect(repo.createVersion).toHaveBeenCalledWith(expect.objectContaining({ version: 2, notes: 'late edit' }));
    expect(out.created).toBe(true);
  });

  it('refuses invalid merged blocks with 422 and writes nothing; 404 for an unknown version', async () => {
    const { repo, service } = setup();
    await expect(service.editVersion('v1', { blocks: { entry: {} } })).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(repo.updateDraft).not.toHaveBeenCalled();
    repo.findVersion.mockResolvedValueOnce(null);
    await expect(service.editVersion('nope', { notes: 'x' })).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('CoreStrategyCatalogueService.approve / setStatus', () => {
  it('approves a DRAFT into PAPER, stamps the approver, and audits it', async () => {
    const { repo, audit, service } = setup();
    const out = await service.approve('v1', OWNER);
    expect(repo.transition).toHaveBeenCalledWith('v1', 'DRAFT', { status: 'PAPER', approvedBy: 'usr_owner', approvedAt: expect.any(Date) });
    expect(audit.append).toHaveBeenCalledWith({
      action: 'CORE_STRATEGY_VERSION_APPROVED',
      userId: 'usr_owner',
      target: 'core_strategy_version:v1',
      meta: { strategyKey: 'ungated', version: 1, from: 'DRAFT', to: 'PAPER' },
    });
    expect(out).toMatchObject({ status: 'PAPER', approvedBy: 'usr_owner' });
  });

  it('a non-ADMIN actor cannot approve or change status, and nothing is written', async () => {
    const { repo, audit, service } = setup();
    await expect(service.approve('v1', USER)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.setStatus('v1', 'RETIRED', USER)).rejects.toBeInstanceOf(ForbiddenException);
    expect(repo.findVersion).not.toHaveBeenCalled();
    expect(repo.transition).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
  });

  it('refuses LIVE with 409 and writes nothing', async () => {
    const { repo, audit, service } = setup();
    repo.findVersion.mockResolvedValue(version({ status: 'PAPER' }));
    await expect(service.setStatus('v1', 'LIVE', OWNER)).rejects.toThrow(/LIVE is reserved until SP7/);
    await expect(service.setStatus('v1', 'LIVE', OWNER)).rejects.toBeInstanceOf(ConflictException);
    expect(repo.transition).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
  });

  it('refuses approving an already-approved version (409, no audit)', async () => {
    const { repo, audit, service } = setup();
    repo.findVersion.mockResolvedValue(version({ status: 'PAPER' }));
    await expect(service.approve('v1', OWNER)).rejects.toBeInstanceOf(ConflictException);
    expect(audit.append).not.toHaveBeenCalled();
  });

  it('approval re-validates stored blocks and writes nothing when they fail', async () => {
    const { repo, audit, service } = setup();
    repo.findVersion.mockResolvedValue(version({ blocks: { entry: {} } as unknown as Prisma.JsonValue }));
    await expect(service.approve('v1', OWNER)).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(repo.transition).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
  });

  it('a lost race (the row moved since it was read) is 409 and not audited', async () => {
    const { repo, audit, service } = setup();
    repo.transition.mockResolvedValueOnce(false);
    await expect(service.approve('v1', OWNER)).rejects.toBeInstanceOf(ConflictException);
    expect(audit.append).not.toHaveBeenCalled();
  });

  it('retires a PAPER version and audits a status change', async () => {
    const { repo, audit, service } = setup();
    repo.findVersion.mockResolvedValue(version({ status: 'PAPER' }));
    await service.setStatus('v1', 'RETIRED', OWNER);
    expect(repo.transition).toHaveBeenCalledWith('v1', 'PAPER', { status: 'RETIRED' });
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({
      action: 'CORE_STRATEGY_VERSION_STATUS_CHANGED', meta: { strategyKey: 'ungated', version: 1, from: 'PAPER', to: 'RETIRED' },
    }));
  });

  it('setStatus PAPER on a draft is an approval', async () => {
    const { audit, service } = setup();
    await service.setStatus('v1', 'PAPER', OWNER);
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({ action: 'CORE_STRATEGY_VERSION_APPROVED' }));
  });
});

describe('CoreStrategyCatalogueService draft and edit audit (ruling P6)', () => {
  it('createDraft appends DRAFTED after the write, with the actor, the new id and the version meta', async () => {
    const { repo, audit, service } = setup();
    await service.createDraft('s1', { blocks: plainBlocks(), notes: null }, 'OWNER', 'usr_owner');
    expect(audit.append).toHaveBeenCalledTimes(1);
    expect(audit.append).toHaveBeenCalledWith({
      action: 'CORE_STRATEGY_VERSION_DRAFTED',
      userId: 'usr_owner',
      target: 'core_strategy_version:v_new',
      meta: { strategyKey: 'ungated', version: 2, createdBy: 'OWNER' },
    });
    expect(repo.createVersion.mock.invocationCallOrder[0]).toBeLessThan(audit.append.mock.invocationCallOrder[0]);
  });

  it('createDraft without an actor audits a null userId and records an AI creator', async () => {
    const { audit, service } = setup();
    await service.createDraft('s1', { blocks: plainBlocks(), notes: null }, 'AI');
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({
      action: 'CORE_STRATEGY_VERSION_DRAFTED', userId: null, meta: { strategyKey: 'ungated', version: 2, createdBy: 'AI' },
    }));
  });

  it('a refused draft (unknown strategy, invalid blocks, lost version race) appends nothing', async () => {
    const { repo, audit, service } = setup();
    repo.findStrategy.mockResolvedValueOnce(null);
    await expect(service.createDraft('nope', { blocks: plainBlocks(), notes: null }, 'OWNER', 'usr_owner')).rejects.toBeInstanceOf(NotFoundException);
    const bad = { ...plainBlocks(), stop: { kind: 'fixedPct', pct: -1 } };
    await expect(service.createDraft('s1', { blocks: bad, notes: null }, 'OWNER', 'usr_owner')).rejects.toBeInstanceOf(UnprocessableEntityException);
    repo.createVersion.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test' }));
    await expect(service.createDraft('s1', { blocks: plainBlocks(), notes: null }, 'OWNER', 'usr_owner')).rejects.toBeInstanceOf(ConflictException);
    expect(audit.append).not.toHaveBeenCalled();
  });

  it('an in-place draft edit appends EDITED once, after the write', async () => {
    const { repo, audit, service } = setup();
    await service.editVersion('v1', { notes: 'tweak' }, 'usr_owner');
    expect(audit.append).toHaveBeenCalledTimes(1);
    expect(audit.append).toHaveBeenCalledWith({
      action: 'CORE_STRATEGY_VERSION_EDITED',
      userId: 'usr_owner',
      target: 'core_strategy_version:v1',
      meta: { strategyKey: 'ungated', version: 1 },
    });
    expect(repo.updateDraft.mock.invocationCallOrder[0]).toBeLessThan(audit.append.mock.invocationCallOrder[0]);
  });

  it('an edit that becomes n+1 appends DRAFTED exactly once and no EDITED', async () => {
    const { repo, audit, service } = setup();
    repo.findVersion.mockResolvedValueOnce(version({ status: 'PAPER' }));
    await service.editVersion('v1', { notes: 'v2 notes' }, 'usr_owner');
    expect(audit.append).toHaveBeenCalledTimes(1);
    expect(audit.append).toHaveBeenCalledWith({
      action: 'CORE_STRATEGY_VERSION_DRAFTED',
      userId: 'usr_owner',
      target: 'core_strategy_version:v_new',
      meta: { strategyKey: 'ungated', version: 2, createdBy: 'OWNER' },
    });
  });

  it('a draft approved mid-edit (n+1 via the lost update) also audits DRAFTED once and no EDITED', async () => {
    const { repo, audit, service } = setup();
    repo.updateDraft.mockResolvedValueOnce(false);
    await service.editVersion('v1', { notes: 'late edit' }, 'usr_owner');
    expect(audit.append).toHaveBeenCalledTimes(1);
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({ action: 'CORE_STRATEGY_VERSION_DRAFTED', userId: 'usr_owner' }));
  });

  it('a refused edit (invalid blocks, unknown version) appends nothing', async () => {
    const { repo, audit, service } = setup();
    await expect(service.editVersion('v1', { blocks: { entry: {} } }, 'usr_owner')).rejects.toBeInstanceOf(UnprocessableEntityException);
    repo.findVersion.mockResolvedValueOnce(null);
    await expect(service.editVersion('nope', { notes: 'x' }, 'usr_owner')).rejects.toBeInstanceOf(NotFoundException);
    expect(audit.append).not.toHaveBeenCalled();
  });
});
