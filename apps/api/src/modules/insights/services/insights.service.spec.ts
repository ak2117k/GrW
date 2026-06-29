import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { InsightsService } from './insights.service';
import { InsightsRepository } from '../repositories/insights.repository';
import { AIInsight } from '@prisma/client';

const mockInsight = (overrides: Partial<AIInsight> = {}): AIInsight => ({
  id: 'cuid_1',
  sectionKey: 'market-breadth',
  contextKey: 'default',
  status: 'pending',
  contextData: {},
  insight: null,
  confidence: null,
  errorMessage: null,
  requestedAt: new Date(),
  startedAt: null,
  completedAt: null,
  ...overrides,
});

describe('InsightsService', () => {
  let service: InsightsService;
  let repo: jest.Mocked<InsightsRepository>;

  beforeEach(async () => {
    const repoMock: Partial<jest.Mocked<InsightsRepository>> = {
      findActiveByKey: jest.fn(),
      findLatestByKey: jest.fn(),
      create: jest.fn(),
      findPending: jest.fn(),
      markInProgress: jest.fn(),
      markCompleted: jest.fn(),
      markFailed: jest.fn(),
      revertStaleInProgress: jest.fn(),
      findById: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InsightsService,
        { provide: InsightsRepository, useValue: repoMock },
      ],
    }).compile();

    service = module.get(InsightsService);
    repo = module.get(InsightsRepository);
  });

  describe('requestInsight (idempotency)', () => {
    it('returns existing active row if one exists', async () => {
      const existing = mockInsight({ id: 'existing' });
      repo.findActiveByKey.mockResolvedValue(existing);

      const result = await service.requestInsight('market-breadth', 'default', { x: 1 });

      expect(result).toBe(existing);
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('creates new row if no active row exists', async () => {
      repo.findActiveByKey.mockResolvedValue(null);
      const created = mockInsight({ id: 'new' });
      repo.create.mockResolvedValue(created);

      const result = await service.requestInsight('market-breadth', 'default', { x: 1 });

      expect(result).toBe(created);
      expect(repo.create).toHaveBeenCalledWith({
        sectionKey: 'market-breadth',
        contextKey: 'default',
        contextData: { x: 1 },
      });
    });
  });

  describe('claimPending', () => {
    it('reverts stale rows then claims pending ones', async () => {
      repo.revertStaleInProgress.mockResolvedValue(2);
      const pending = [mockInsight({ id: 'p1' }), mockInsight({ id: 'p2' })];
      repo.findPending.mockResolvedValue(pending);
      repo.markInProgress.mockImplementation(async (id) =>
        mockInsight({ id, status: 'in_progress' }),
      );

      const result = await service.claimPending();

      expect(repo.revertStaleInProgress).toHaveBeenCalled();
      expect(result).toHaveLength(2);
      expect(result[0].status).toBe('in_progress');
    });

    it('skips rows that fail to claim (race condition)', async () => {
      repo.revertStaleInProgress.mockResolvedValue(0);
      repo.findPending.mockResolvedValue([mockInsight({ id: 'p1' }), mockInsight({ id: 'p2' })]);
      repo.markInProgress
        .mockResolvedValueOnce(mockInsight({ id: 'p1', status: 'in_progress' }))
        .mockRejectedValueOnce(new Error('row already claimed'));

      const result = await service.claimPending();

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('p1');
    });
  });

  describe('completeInsight', () => {
    it('marks completed when row is in_progress', async () => {
      repo.findById.mockResolvedValue(mockInsight({ status: 'in_progress' }));
      const completed = mockInsight({ status: 'completed', insight: 'analysis', confidence: 80 });
      repo.markCompleted.mockResolvedValue(completed);

      const result = await service.completeInsight('cuid_1', 'analysis', 80);

      expect(result).toBe(completed);
    });

    it('throws BadRequest if row is not in_progress', async () => {
      repo.findById.mockResolvedValue(mockInsight({ status: 'pending' }));

      await expect(service.completeInsight('cuid_1', 'x', 50)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws NotFound if row does not exist', async () => {
      repo.findById.mockResolvedValue(null);

      await expect(service.completeInsight('missing', 'x', 50)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws BadRequest if confidence is out of range', async () => {
      repo.findById.mockResolvedValue(mockInsight({ status: 'in_progress' }));

      await expect(service.completeInsight('cuid_1', 'x', 0)).rejects.toThrow(BadRequestException);
      await expect(service.completeInsight('cuid_1', 'x', 101)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('failInsight', () => {
    it('marks failed', async () => {
      repo.findById.mockResolvedValue(mockInsight({ status: 'in_progress' }));
      const failed = mockInsight({ status: 'failed', errorMessage: 'oops' });
      repo.markFailed.mockResolvedValue(failed);

      const result = await service.failInsight('cuid_1', 'oops');

      expect(result).toBe(failed);
    });

    it('throws NotFound if row does not exist', async () => {
      repo.findById.mockResolvedValue(null);

      await expect(service.failInsight('missing', 'oops')).rejects.toThrow(NotFoundException);
    });
  });
});
