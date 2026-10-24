import { AdvisorMemoryRepository, renderAdvisorHistory, trimAdvisorHistory, type AdvisorTurn } from './advisor-memory';

const t = (role: 'user' | 'assistant', content: string): AdvisorTurn => ({ role, content });

describe('trimAdvisorHistory', () => {
  it('keeps only the last 8 messages', () => {
    const turns = Array.from({ length: 12 }, (_, i) => t(i % 2 ? 'assistant' : 'user', `m${i}`));
    const out = trimAdvisorHistory(turns);
    expect(out).toHaveLength(8);
    expect(out[0].content).toBe('m4');
    expect(out[7].content).toBe('m11');
  });

  it('drops the oldest messages to fit the 3,000-char budget', () => {
    const turns = [t('user', 'a'.repeat(1500)), t('assistant', 'b'.repeat(1500)), t('user', 'c'.repeat(1000))];
    const out = trimAdvisorHistory(turns);
    expect(out.map((x) => x.content[0])).toEqual(['b', 'c']);
    expect(out.reduce((s, x) => s + x.content.length, 0)).toBeLessThanOrEqual(3000);
  });

  it('tail-clips a single message longer than the whole budget', () => {
    const out = trimAdvisorHistory([t('assistant', 'x'.repeat(5000))]);
    expect(out).toHaveLength(1);
    expect(out[0].content.length).toBe(3000);
  });

  it('renders Owner/Advisor lines', () => {
    expect(renderAdvisorHistory([t('user', 'q'), t('assistant', 'a')])).toBe('Owner: q\n\nAdvisor: a');
  });
});

describe('AdvisorMemoryRepository', () => {
  function fakePrisma() {
    let rows: Array<{ id: string; userId: string; role: string; content: string; createdAt: Date }> = [];
    let n = 0;
    const byUserDesc = (userId: string) =>
      rows.filter((r) => r.userId === userId).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const advisorChatTurn = {
      createMany: jest.fn(async ({ data }: any) => {
        for (const d of data) rows.push({ id: `r${++n}`, ...d });
        return { count: data.length };
      }),
      findMany: jest.fn(async ({ where, take }: any) => byUserDesc(where.userId).slice(0, take)),
      deleteMany: jest.fn(async ({ where }: any) => {
        const before = rows.length;
        rows = rows.filter((r) => !(r.userId === where.userId && (!where.id || !where.id.notIn.includes(r.id))));
        return { count: before - rows.length };
      }),
    };
    return { prisma: { advisorChatTurn } as any, rows: () => rows };
  }

  it('appends exchanges, prunes to the last 8 per user, returns oldest-first, clears per user', async () => {
    const f = fakePrisma();
    const repo = new AdvisorMemoryRepository(f.prisma);
    const t0 = Date.parse('2026-10-24T10:00:00Z');
    for (let i = 0; i < 6; i++) await repo.append('owner', `q${i}`, `a${i}`, new Date(t0 + i * 1000));
    await repo.append('other', 'oq', 'oa', new Date(t0));
    expect(f.rows().filter((r) => r.userId === 'owner')).toHaveLength(8);
    const hist = await repo.recent('owner');
    expect(hist.map((h) => h.content)).toEqual(['q2', 'a2', 'q3', 'a3', 'q4', 'a4', 'q5', 'a5']);
    expect(await repo.clear('owner')).toBe(8);
    expect(await repo.recent('owner')).toEqual([]);
    expect((await repo.recent('other')).map((h) => h.content)).toEqual(['oq', 'oa']);
  });

  it('fails soft: a read error is an empty history, a write error is swallowed', async () => {
    const boom = jest.fn(async () => {
      throw new Error('db down');
    });
    const repo = new AdvisorMemoryRepository({ advisorChatTurn: { findMany: boom, createMany: boom, deleteMany: boom } } as any);
    await expect(repo.recent('u')).resolves.toEqual([]);
    await expect(repo.append('u', 'q', 'a')).resolves.toBeUndefined();
  });
});
