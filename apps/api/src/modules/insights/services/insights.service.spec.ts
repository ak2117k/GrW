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

  describe('findLatest', () => {
    it('answers null — not a 404 — for a key that was never asked', async () => {
      // Regression: /api/insights/options-chain/NIFTY%3A2026-10-27 404'd on every
      // Options page view just because nobody had asked for that expiry yet.
      repo.findLatestByKey.mockResolvedValue(null);
      await expect(service.findLatest('options-chain', 'NIFTY:2026-10-27')).resolves.toBeNull();
    });
  });

  describe('user-scoped sections (answers embed the requester\'s positions)', () => {
    beforeEach(() => {
      service.registerProcessor('news-feed', jest.fn().mockReturnValue(true), { userScoped: true });
    });

    it('stores the row under the requester and user B cannot read user A\'s insight', async () => {
      repo.findActiveByKey.mockResolvedValue(null);
      repo.create.mockImplementation(async (d) => mockInsight({ sectionKey: d.sectionKey, contextKey: d.contextKey }));
      await service.requestInsight('news-feed', 'a1,a2', {}, { userId: 'userA' });
      expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ contextKey: 'a1,a2@u:userA' }));

      const rows = new Map([['a1,a2@u:userA', mockInsight({ id: 'A-row', insight: 'A positions…' })]]);
      repo.findLatestByKey.mockImplementation(async (_s, key) => rows.get(key) ?? null);

      await expect(service.findLatest('news-feed', 'a1,a2', { userId: 'userB' })).resolves.toBeNull();
      await expect(service.findLatest('news-feed', 'a1,a2')).resolves.toBeNull(); // unauthenticated: own 'anon' bucket
      await expect(service.findLatest('news-feed', 'a1,a2', { userId: 'userA' })).resolves.toMatchObject({ id: 'A-row' });
    });

    it('does not hand user B the active row user A is waiting on', async () => {
      repo.findActiveByKey.mockImplementation(async (_s, key) =>
        key === 'k@u:userA' ? mockInsight({ id: 'A-active' }) : null,
      );
      repo.create.mockResolvedValue(mockInsight({ id: 'B-new' }));
      const row = await service.requestInsight('news-feed', 'k', {}, { userId: 'userB' });
      expect(row.id).toBe('B-new');
      expect(repo.findActiveByKey).toHaveBeenCalledWith('news-feed', 'k@u:userB');
    });

    it('leaves non-scoped sections keyed as before', () => {
      expect(service.scopedContextKey('options-chain', 'NIFTY:2026-10-27', { userId: 'u' })).toBe('NIFTY:2026-10-27');
    });
  });

  describe('registered processors', () => {
    it('hands a NEW row to the section processor with the requester', async () => {
      const created = mockInsight({ id: 'new', sectionKey: 'news-feed' });
      repo.findActiveByKey.mockResolvedValue(null);
      repo.create.mockResolvedValue(created);
      const processor = jest.fn().mockReturnValue(true);
      service.registerProcessor('news-feed', processor);

      const row = await service.requestInsight('news-feed', 'k', {}, { userId: 'u1', role: 'ADMIN' });

      expect(row).toBe(created);
      expect(processor).toHaveBeenCalledWith(created, { userId: 'u1', role: 'ADMIN' });
    });

    it('does not re-run the processor for an already-active row, nor for other sections', async () => {
      const processor = jest.fn().mockReturnValue(true);
      service.registerProcessor('news-feed', processor);
      repo.findActiveByKey.mockResolvedValueOnce(mockInsight({ sectionKey: 'news-feed' }));
      await service.requestInsight('news-feed', 'k', {});
      repo.findActiveByKey.mockResolvedValueOnce(null);
      repo.create.mockResolvedValueOnce(mockInsight({ sectionKey: 'options-chain' }));
      await service.requestInsight('options-chain', 'NIFTY:2026-10-27', {});
      expect(processor).not.toHaveBeenCalled();
    });
  });
});
