import type { PrismaService } from '../../../common/prisma/prisma.service';
import { AiCallRepository, type AiCallRow } from './ai-call.repository';

const row = (): AiCallRow => ({
  job: 'sentinel.judge',
  provider: 'anthropic-api',
  model: 'claude-opus-5',
  effort: 'high',
  priority: 0,
  userId: null,
  positionId: null,
  setupId: null,
  decisionRecordId: null,
  requestHash: 'abc',
  request: { model: 'claude-opus-5' },
  response: { content: [], stop_reason: 'end_turn' },
  errorClass: null,
  errorMessage: null,
  stopReason: 'end_turn',
  inputTokens: 10,
  outputTokens: 2,
  costInr: 0.0123,
  latencyMs: 5,
  queuedMs: 0,
  fallbackFrom: null,
});

function repo(create: jest.Mock, aggregate = jest.fn()) {
  const prisma = { aiCall: { create, aggregate } } as unknown as PrismaService;
  return new AiCallRepository(prisma);
}

describe('AiCallRepository', () => {
  it('insert writes the row as-is via prisma.aiCall.create (number costInr accepted)', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'x' });
    const r = row();
    await repo(create).insert(r);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({ data: r });
    expect(typeof create.mock.calls[0][0].data.costInr).toBe('number');
  });

  it('insert propagates a write failure (the gateway, not the repository, fails open)', async () => {
    const err = new Error('db down');
    await expect(repo(jest.fn().mockRejectedValue(err)).insert(row())).rejects.toBe(err);
  });

  it('spentSince sums costInr from the given instant and converts Decimal to number', async () => {
    const aggregate = jest.fn().mockResolvedValue({ _sum: { costInr: { toString: () => '12.5' } } });
    const since = new Date('2026-10-11T18:30:00Z');
    await expect(repo(jest.fn(), aggregate).spentSince(since)).resolves.toBe(12.5);
    expect(aggregate).toHaveBeenCalledWith({
      _sum: { costInr: true },
      where: { createdAt: { gte: since } },
    });
  });

  it('spentSince is 0 when there are no rows', async () => {
    const aggregate = jest.fn().mockResolvedValue({ _sum: { costInr: null } });
    await expect(repo(jest.fn(), aggregate).spentSince(new Date())).resolves.toBe(0);
  });
});
