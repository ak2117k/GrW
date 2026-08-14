import { Prisma } from '@prisma/client';
import {
  SentinelThesisRepository,
  type ThesisDraft,
} from './sentinel-thesis.repository';

const draft: ThesisDraft = {
  userId: 'u1',
  direction: 'LONG',
  reason: 'bought the demand zone',
  levelPrice: 1450,
  targetPrice: 1520,
  invalidation: 1440,
};

/** A row as Prisma hands it back — extra columns included, as the real one has. */
const row = (over: Record<string, unknown> = {}) => ({
  id: 'th1',
  userId: 'u1',
  trackerId: 't1',
  direction: 'LONG',
  reason: 'bought the demand zone',
  levelPrice: 1450,
  targetPrice: 1520,
  invalidation: 1440,
  source: 'INFERRED',
  createdAt: new Date('2026-08-14T04:00:00.000Z'),
  updatedAt: new Date('2026-08-14T04:00:00.000Z'),
  ...over,
});

describe('SentinelThesisRepository', () => {
  const findUnique = jest.fn();
  const updateMany = jest.fn();
  const create = jest.fn();
  const update = jest.fn();
  const prisma = {
    sentinelThesis: { findUnique, updateMany, create, update },
  } as never;
  const repo = new SentinelThesisRepository(prisma);

  beforeEach(() => jest.clearAllMocks());

  describe('find', () => {
    it('maps every stored column onto the thesis the packet carries', async () => {
      findUnique.mockResolvedValue(
        row({
          direction: 'SHORT',
          reason: 'faded the supply shelf',
          levelPrice: 1500,
          targetPrice: 1400,
          invalidation: 1520,
          source: 'USER',
        }),
      );

      // Spelled out field by field: six hand-mapped columns of the same two
      // types is exactly where a transposition (targetPrice <- invalidation)
      // survives a toMatchObject.
      await expect(repo.find('t1')).resolves.toEqual({
        direction: 'SHORT',
        reason: 'faded the supply shelf',
        levelPrice: 1500,
        targetPrice: 1400,
        invalidation: 1520,
        source: 'USER',
      });
      expect(findUnique).toHaveBeenCalledWith({ where: { trackerId: 't1' } });
    });

    it('returns null when this position has no thesis on record', async () => {
      findUnique.mockResolvedValue(null);
      await expect(repo.find('t1')).resolves.toBeNull();
    });

    it('carries a stated-unknown thesis through with its nulls intact', async () => {
      // The unknown thesis is the fallback the whole design leans on; if `find`
      // coerced its nulls to 0 the agent would read a level at zero.
      findUnique.mockResolvedValue(
        row({
          reason: 'thesis could not be inferred — the Anthropic API was unreachable',
          levelPrice: null,
          targetPrice: null,
          invalidation: null,
        }),
      );
      const found = await repo.find('t1');
      expect(found?.levelPrice).toBeNull();
      expect(found?.targetPrice).toBeNull();
      expect(found?.invalidation).toBeNull();
    });
  });

  describe('upsertInferred', () => {
    it('rewrites an existing inferred thesis in place', async () => {
      updateMany.mockResolvedValue({ count: 1 });

      const result = await repo.upsertInferred('t1', draft);

      expect(updateMany).toHaveBeenCalledWith({
        // The USER guard lives IN the write predicate, not in a prior read.
        where: { trackerId: 't1', source: { not: 'USER' } },
        data: { ...draft, source: 'INFERRED' },
      });
      expect(create).not.toHaveBeenCalled();
      expect(result).toEqual({
        direction: 'LONG',
        reason: 'bought the demand zone',
        levelPrice: 1450,
        targetPrice: 1520,
        invalidation: 1440,
        source: 'INFERRED',
      });
    });

    it('creates the row the first time a position is seen', async () => {
      updateMany.mockResolvedValue({ count: 0 });
      findUnique.mockResolvedValue(null);
      create.mockResolvedValue(row());

      const result = await repo.upsertInferred('t1', draft);

      expect(create).toHaveBeenCalledWith({
        data: { trackerId: 't1', ...draft, source: 'INFERRED' },
      });
      expect(result.source).toBe('INFERRED');
    });

    it('leaves a USER thesis completely untouched and returns it', async () => {
      // The predicate matches nothing, so the row was not written. This is the
      // second non-negotiable rule of the task: a correction is permanent.
      updateMany.mockResolvedValue({ count: 0 });
      findUnique.mockResolvedValue(row({ source: 'USER', reason: 'momentum breakout' }));

      const result = await repo.upsertInferred('t1', draft);

      expect(create).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
      expect(result.source).toBe('USER');
      // The caller gets the row that IS stored, not the draft it offered.
      expect(result.reason).toBe('momentum breakout');
    });

    it('does not send a write that could match a USER row', async () => {
      // Guard against the guard: if the predicate ever loses `source`, this
      // fails even though the test above would still pass (its updateMany is
      // stubbed to count 0 regardless of the predicate).
      updateMany.mockResolvedValue({ count: 1 });
      await repo.upsertInferred('t1', draft);
      const where = updateMany.mock.calls[0][0].where;
      expect(where.source).toEqual({ not: 'USER' });
    });

    it('yields to the writer that won a create race rather than throwing', async () => {
      updateMany.mockResolvedValue({ count: 0 });
      findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(row({ source: 'USER', reason: 'momentum breakout' }));
      create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('unique constraint failed', {
          code: 'P2002',
          clientVersion: '6.19.2',
        }),
      );

      // A correction landing between the updateMany and the create is exactly
      // the window the predicate cannot cover — losing the race must return the
      // winner's row, never overwrite it and never fail the watch.
      await expect(repo.upsertInferred('t1', draft)).resolves.toMatchObject({
        source: 'USER',
        reason: 'momentum breakout',
      });
    });

    it('propagates a create failure that is not a race', async () => {
      updateMany.mockResolvedValue({ count: 0 });
      findUnique.mockResolvedValue(null);
      const boom = new Prisma.PrismaClientKnownRequestError('column missing', {
        code: 'P2022',
        clientVersion: '6.19.2',
      });
      create.mockRejectedValue(boom);
      // Swallowing this would hide a schema fault behind a phantom success.
      await expect(repo.upsertInferred('t1', draft)).rejects.toBe(boom);
    });
  });

  describe('overrideByUser', () => {
    it('stamps the correction as USER', async () => {
      update.mockResolvedValue(row({ source: 'USER', reason: 'momentum breakout' }));

      const result = await repo.overrideByUser('t1', { reason: 'momentum breakout' });

      expect(update).toHaveBeenCalledWith({
        where: { trackerId: 't1' },
        data: { reason: 'momentum breakout', source: 'USER' },
      });
      expect(result.source).toBe('USER');
    });

    it('cannot be talked out of the USER stamp by the patch', async () => {
      update.mockResolvedValue(row({ source: 'USER' }));
      await repo.overrideByUser('t1', {
        reason: 'momentum breakout',
        source: 'INFERRED',
      } as never);
      // `source` is applied last. A patch that could downgrade its own row would
      // let a correction be silently re-opened to inference on the next tick.
      expect(update.mock.calls[0][0].data.source).toBe('USER');
    });

    it('states plainly that there is nothing to correct yet', async () => {
      update.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('record not found', {
          code: 'P2025',
          clientVersion: '6.19.2',
        }),
      );
      await expect(repo.overrideByUser('t1', { reason: 'x' })).rejects.toThrow(
        /no thesis on record/i,
      );
    });
  });
});
