import type { PrismaService } from '../../common/prisma/prisma.service';
import { NewsAiRepository } from './news-ai.repository';

/** A Prisma stand-in that records SQL and answers the information_schema probe. */
function fakePrisma(hasFiltered: boolean | 'error') {
  const sql: string[] = [];
  const probe = jest.fn();
  const prisma = {
    $queryRawUnsafe: jest.fn(async (q: string) => {
      sql.push(q);
      if (q.includes('information_schema')) {
        probe();
        if (hasFiltered === 'error') throw new Error('no access');
        return [{ n: hasFiltered ? 1 : 0 }];
      }
      return [];
    }),
    $executeRawUnsafe: jest.fn(async (q: string) => {
      sql.push(q);
      return 1;
    }),
  };
  return { prisma: prisma as unknown as PrismaService, sql, probe };
}

describe('NewsAiRepository (filtered-column tolerance)', () => {
  it('skips filtered rows when news_articles.filtered exists, and probes only once', async () => {
    const { prisma, sql, probe } = fakePrisma(true);
    const repo = new NewsAiRepository(prisma);
    await repo.readCandidates(new Date(), 3, 10);
    await repo.readsSince(new Date());
    expect(probe).toHaveBeenCalledTimes(1);
    const cand = sql.find((q) => q.includes('LEFT JOIN "news_ai_reads"'))!;
    expect(cand).toContain('a."filtered" IS NOT TRUE');
    expect(cand).toContain('r."article_id" IS NULL'); // already-read skipped
    expect(cand).toContain('COALESCE(f."attempts", 0) < $2'); // retries capped
    expect(cand).toContain('a."fetchedAt" >= $1');
    expect(cand).toMatch(/ORDER BY COALESCE\(f\."attempts", 0\) ASC, a\."publishedAt" DESC/);
    expect(sql.find((q) => q.includes('JOIN "news_articles" a ON'))).toContain('a."filtered" IS NOT TRUE');
  });

  it('works without the column (filter not migrated yet)', async () => {
    const { prisma, sql } = fakePrisma(false);
    const repo = new NewsAiRepository(prisma);
    await repo.readCandidates(new Date(), 3, 10);
    expect(sql.join('\n')).not.toContain('"filtered"');
  });

  it('a failed probe falls back to no clause and is retried next time', async () => {
    const { prisma, probe } = fakePrisma('error');
    const repo = new NewsAiRepository(prisma);
    expect(await repo.visibleClause()).toBe('');
    expect(await repo.visibleClause()).toBe('');
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('saveRead writes once per article (ON CONFLICT DO NOTHING); failures increment attempts', async () => {
    const { prisma, sql } = fakePrisma(true);
    const repo = new NewsAiRepository(prisma);
    await repo.saveRead('a', 'claude-sonnet-5', { direction: 'BULL', strength: 1, importance: 2, takeaway: 't', affected: [] });
    await repo.recordFailure('a', 'x'.repeat(900));
    expect(sql[0]).toContain('ON CONFLICT ("article_id") DO NOTHING');
    expect(sql[1]).toContain('"attempts" = "news_ai_read_failures"."attempts" + 1');
    const args = (prisma.$executeRawUnsafe as jest.Mock).mock.calls[1];
    expect((args[2] as string).length).toBe(500);
  });

  it('owner holdings are scoped to the user and OPEN', async () => {
    const { prisma, sql } = fakePrisma(true);
    await new NewsAiRepository(prisma).ownerHoldings('u1');
    expect(sql[0]).toContain('"userId" = $1 AND "status" = \'OPEN\'');
  });
});

describe('NewsAiRepository.tablesReady (migration not applied yet)', () => {
  const probe = (answers: Array<number | Error>) => {
    const calls: unknown[][] = [];
    const prisma = {
      $queryRawUnsafe: jest.fn(async (...args: unknown[]) => {
        calls.push(args);
        const a = answers.shift();
        if (a instanceof Error) throw a;
        return [{ n: a ?? 0 }];
      }),
    };
    return { repo: new NewsAiRepository(prisma as unknown as PrismaService), calls };
  };

  it('a yes is cached for good', async () => {
    const { repo, calls } = probe([3]);
    expect(await repo.tablesReady(0)).toBe(true);
    expect(await repo.tablesReady(10 ** 9)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toEqual(['news_ai_reads', 'news_ai_read_failures', 'news_briefs']);
  });

  it('a no (or a failed lookup) is re-checked only after 10 min, then picks up the applied migration', async () => {
    const { repo, calls } = probe([2, new Error('boom'), 3]);
    expect(await repo.tablesReady(0)).toBe(false);
    expect(await repo.tablesReady(5 * 60_000)).toBe(false);
    expect(calls).toHaveLength(1);
    expect(await repo.tablesReady(10 * 60_000)).toBe(false);
    expect(await repo.tablesReady(20 * 60_000)).toBe(true);
    expect(calls).toHaveLength(3);
  });
});
