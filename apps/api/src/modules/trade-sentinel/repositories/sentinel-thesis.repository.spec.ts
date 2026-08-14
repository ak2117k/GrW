import { BadRequestException, NotFoundException } from '@nestjs/common';
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
    it('stamps the correction as USER, scoped to the owning tenant', async () => {
      updateMany.mockResolvedValue({ count: 1 });
      findUnique.mockResolvedValue(row({ source: 'USER', reason: 'momentum breakout' }));

      const result = await repo.overrideByUser('t1', 'u1', { reason: 'momentum breakout' });

      expect(updateMany).toHaveBeenCalledWith({
        where: { trackerId: 't1', userId: 'u1' },
        data: { reason: 'momentum breakout', source: 'USER' },
      });
      expect(result.source).toBe('USER');
    });

    it('writes nothing when another tenant asks to correct this thesis', async () => {
      // IDOR. `trackerId` is a cuid on the wire; scoping only by it lets any
      // account rewrite the thesis every later exit decision is measured
      // against. The predicate must simply match zero rows.
      updateMany.mockResolvedValue({ count: 0 });

      await expect(
        repo.overrideByUser('t1', 'attacker', { reason: 'sell it all' }),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(updateMany).toHaveBeenCalledWith({
        where: { trackerId: 't1', userId: 'attacker' },
        data: { reason: 'sell it all', source: 'USER' },
      });
      expect(update).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
    });

    it('always carries the tenant in the write predicate', async () => {
      // Guard against the guard: both tests above stub `count` regardless of
      // the predicate, so neither would notice `userId` being dropped from it.
      updateMany.mockResolvedValue({ count: 1 });
      findUnique.mockResolvedValue(row({ source: 'USER' }));
      await repo.overrideByUser('t1', 'u1', { reason: 'x' });
      expect(updateMany.mock.calls[0][0].where).toEqual({ trackerId: 't1', userId: 'u1' });
    });

    it('answers a missing row and another tenant’s row identically', async () => {
      // Distinguishable errors would confirm that a given trackerId exists.
      updateMany.mockResolvedValue({ count: 0 });
      const mine = repo.overrideByUser('t-absent', 'u1', { reason: 'x' });
      const theirs = repo.overrideByUser('t1', 'attacker', { reason: 'x' });
      await expect(mine).rejects.toThrow(/no thesis on record/i);
      await expect(theirs).rejects.toThrow(/no thesis on record/i);
    });

    it('cannot be talked out of the USER stamp by the patch', async () => {
      updateMany.mockResolvedValue({ count: 1 });
      findUnique.mockResolvedValue(row({ source: 'USER' }));
      await repo.overrideByUser('t1', 'u1', {
        reason: 'momentum breakout',
        source: 'INFERRED',
      } as never);
      // `source` is applied last over a whitelisted patch. A patch that could
      // downgrade its own row would re-open a correction to inference.
      expect(updateMany.mock.calls[0][0].data).toEqual({
        reason: 'momentum breakout',
        source: 'USER',
      });
    });

    it('cannot re-attribute the row to a different tenant', async () => {
      updateMany.mockResolvedValue({ count: 1 });
      findUnique.mockResolvedValue(row({ source: 'USER' }));
      // Excluded by type AND stripped at runtime: `UserThesisPatch` is a
      // compile-time claim about JSON that arrived over the wire.
      await repo.overrideByUser('t1', 'u1', {
        reason: 'momentum breakout',
        userId: 'attacker',
      } as never);
      expect(updateMany.mock.calls[0][0].data.userId).toBeUndefined();
    });

    it('drops keys that are not the user’s to set', async () => {
      updateMany.mockResolvedValue({ count: 1 });
      findUnique.mockResolvedValue(row({ source: 'USER' }));
      await repo.overrideByUser('t1', 'u1', {
        reason: 'momentum breakout',
        id: 'forged',
        createdAt: new Date(0),
      } as never);
      // The update is rebuilt from a whitelist, never spread from the caller.
      expect(updateMany.mock.calls[0][0].data).toEqual({
        reason: 'momentum breakout',
        source: 'USER',
      });
    });

    it.each([
      ['a direction outside the enum', { direction: 'FLAT' }],
      ['a price as a string', { levelPrice: '1450' }],
      ['a price as an object', { targetPrice: { v: 1 } }],
      ['a non-finite price', { invalidation: Number.NaN }],
      ['a blank reason', { reason: '   ' }],
      ['a reason that is not a string', { reason: 42 }],
      ['nothing at all', {}],
    ])('refuses %s before it reaches the database', async (_label, patch) => {
      await expect(repo.overrideByUser('t1', 'u1', patch as never)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      // A 400, not a 500 and not a corrupt row: the endpoint takes untrusted
      // JSON, and `UserThesisPatch` guarantees nothing at runtime.
      expect(updateMany).not.toHaveBeenCalled();
    });

    it('accepts an explicit null price as a real correction', async () => {
      // "I had no target" is a legitimate thing to state, and must not be
      // rejected alongside the malformed values above.
      updateMany.mockResolvedValue({ count: 1 });
      findUnique.mockResolvedValue(row({ source: 'USER', targetPrice: null }));

      await repo.overrideByUser('t1', 'u1', { targetPrice: null });

      expect(updateMany.mock.calls[0][0].data).toEqual({ targetPrice: null, source: 'USER' });
    });

    it('trims the corrected reason', async () => {
      updateMany.mockResolvedValue({ count: 1 });
      findUnique.mockResolvedValue(row({ source: 'USER' }));
      await repo.overrideByUser('t1', 'u1', { reason: '  momentum breakout  ' });
      expect(updateMany.mock.calls[0][0].data.reason).toBe('momentum breakout');
    });

    it('reports a row that vanished between the write and the read', async () => {
      updateMany.mockResolvedValue({ count: 1 });
      findUnique.mockResolvedValue(null);
      await expect(repo.overrideByUser('t1', 'u1', { reason: 'x' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
