import type { ManagerDecision } from '../domain/desk.types';
import { DeskManagerRepository } from './desk-manager.repository';

const NOW = new Date('2026-11-26T04:30:00Z');

function make() {
  const prisma = {
    deskManagerRun: { create: jest.fn(async () => ({ id: 'run1' })), update: jest.fn(async () => ({})), count: jest.fn(async () => 7) },
    deskManagerDecision: { create: jest.fn(async () => ({ id: 'dec1' })), update: jest.fn(async () => ({})) },
  };
  return { repo: new DeskManagerRepository(prisma as never), prisma };
}
const arg = (m: jest.Mock) => (m.mock.calls[0] as unknown as [Record<string, Record<string, unknown>>])[0];

describe('DeskManagerRepository', () => {
  it('createRun stores user, start, reasons and mode', async () => {
    const { repo, prisma } = make();
    expect(await repo.createRun({ userId: 'u', startedAt: NOW, wakeReasons: ['cadence', 'manual'], mode: 'shadow' })).toBe('run1');
    expect(arg(prisma.deskManagerRun.create).data).toEqual({ userId: 'u', startedAt: NOW, wakeReasons: ['cadence', 'manual'], mode: 'shadow' });
  });

  it('finishRun writes only the fields given', async () => {
    const { repo, prisma } = make();
    await repo.finishRun('run1', { finishedAt: NOW, error: 'boom', aiMs: 12 });
    expect(arg(prisma.deskManagerRun.update)).toEqual({ where: { id: 'run1' }, data: { finishedAt: NOW, error: 'boom', aiMs: 12 } });
  });

  it('insertDecision: VALID without problems, INVALID with them; underlying / trackerId lifted from the payload', async () => {
    const { repo, prisma } = make();
    const exit: ManagerDecision = { action: 'EXIT', trackerId: 't1', reason: 'r', evidence: ['1'] };
    await repo.insertDecision({ runId: 'run1', userId: 'u', decision: exit, problems: [] });
    expect(arg(prisma.deskManagerDecision.create).data).toMatchObject({ action: 'EXIT', trackerId: 't1', underlying: null, status: 'VALID', validation: { ok: true, problems: [] } });
    const watch: ManagerDecision = { action: 'WATCH', underlying: 'BSE', note: 'n', recheckMin: 5, reason: 'r', evidence: [] };
    await repo.insertDecision({ runId: 'run1', userId: 'u', decision: watch, problems: ['no evidence'] });
    expect((prisma.deskManagerDecision.create.mock.calls[1] as unknown as [{ data: Record<string, unknown> }])[0].data).toMatchObject({ underlying: 'BSE', trackerId: null, status: 'INVALID', validation: { ok: false, problems: ['no evidence'] } });
  });

  it('setDecisionResult stores the status, result and refs', async () => {
    const { repo, prisma } = make();
    await repo.setDecisionResult('dec1', { result: { status: 'DONE', detail: 'placed', ref: 'o1' }, orderRowId: 'o1' });
    expect(arg(prisma.deskManagerDecision.update)).toEqual({ where: { id: 'dec1' }, data: { status: 'DONE', result: { status: 'DONE', detail: 'placed', ref: 'o1' }, orderRowId: 'o1' } });
  });

  it('countAiCallsSince counts runs that reached the AI', async () => {
    const { repo, prisma } = make();
    expect(await repo.countAiCallsSince('u', NOW)).toBe(7);
    expect(arg(prisma.deskManagerRun.count).where).toEqual({ userId: 'u', startedAt: { gte: NOW }, aiMs: { not: null } });
  });
});
