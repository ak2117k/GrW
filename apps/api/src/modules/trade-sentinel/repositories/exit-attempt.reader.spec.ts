import { PrismaExitAttemptReader } from './exit-attempt.reader';

describe('PrismaExitAttemptReader', () => {
  const since = new Date('2026-10-19T05:45:00.000Z');

  it('reads the latest attempt per tracker in ONE query and maps it by tracker id', async () => {
    const rows = [
      { id: 'a', trackerId: 't1', status: 'FAILED', reason: 'BROKER_AUTH', createdAt: new Date() },
      { id: 'b', trackerId: 't2', status: 'SKIPPED', reason: 'OWNER_HOLD', createdAt: new Date() },
    ];
    const $queryRaw = jest.fn().mockResolvedValue(rows);
    const reader = new PrismaExitAttemptReader({ $queryRaw } as never);
    const out = await reader.latestSince(['u1'], ['t1', 't2', 't3'], since);
    expect($queryRaw).toHaveBeenCalledTimes(1);
    const sql = $queryRaw.mock.calls[0][0] as { sql: string; values: unknown[] };
    expect(sql.sql).toContain('DISTINCT ON (e."trackerId")');
    expect(sql.sql).toContain('FROM "ai_exit_executions"');
    expect(sql.sql).not.toMatch(/\b(UPDATE|INSERT|DELETE)\b/);
    expect(sql.values).toEqual(['u1', since, 't1', 't2', 't3']);
    expect([...out.keys()]).toEqual(['t1', 't2']);
    expect(out.get('t2')?.reason).toBe('OWNER_HOLD');
  });

  it('issues no query for an empty roster', async () => {
    const $queryRaw = jest.fn();
    const reader = new PrismaExitAttemptReader({ $queryRaw } as never);
    expect((await reader.latestSince([], [], since)).size).toBe(0);
    expect($queryRaw).not.toHaveBeenCalled();
  });
});
