import type { FixTicketDraft } from './decision-loop';
import type { FixTicketRecord } from './fix-queue';
import { FixTicketRepository, mergeTicket } from './fix-ticket.repository';

const draft = (refIds: string[], over: Partial<FixTicketDraft> = {}): FixTicketDraft => ({
  key: 'code-bug:risk-manager-risk-manager.service',
  cause: 'CODE_BUG',
  title: 'Paper trades counted against the live position limit',
  proposedChange: 'Count only isPaperTrade=false trades in the live limit.',
  files: ['apps/api/src/modules/risk-manager/risk-manager.service.ts'],
  testDescription: 'paper trades do not block a live order',
  refIds,
  costRupees: refIds.length * 1000,
  refCosts: Object.fromEntries(refIds.map((r) => [r, 1000])),
  evidence: { cause: 'risk_manager blocked 12 live calls', sessions: ['2026-11-03'], kinds: ['DECISION:DETECTOR'], symbols: ['NIFTY'] },
  sessionDate: '2026-11-03',
  ...over,
});

/** An in-memory fix_tickets table keyed by `key` (unique). */
function memoryRepo() {
  const rows = new Map<string, FixTicketRecord>();
  let n = 0;
  const fixTicket = {
    findUnique: jest.fn(async ({ where }: { where: { key: string } }) => rows.get(where.key) ?? null),
    findMany: jest.fn(async () => [...rows.values()]),
    create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
      if (rows.has(data.key as string)) throw new Error('P2002 unique');
      const r = { id: `t${++n}`, ...data } as unknown as FixTicketRecord;
      rows.set(r.key, r);
      return r;
    }),
    update: jest.fn(async ({ where, data }: { where: { key: string }; data: Record<string, unknown> }) => {
      const r = { ...(rows.get(where.key) as FixTicketRecord), ...data } as FixTicketRecord;
      rows.set(where.key, r);
      return r;
    }),
  };
  return { repo: new FixTicketRepository({ fixTicket } as never), rows, fixTicket };
}

describe('FixTicketRepository', () => {
  it('same ticket key upserts: one row, occurrences and lastSeen grow, never a duplicate', async () => {
    const { repo, rows, fixTicket } = memoryRepo();
    const d1 = new Date('2026-11-03T13:15:00Z');
    const d2 = new Date('2026-11-04T13:15:00Z');
    const a = await repo.upsert(draft(['dg:1', 'dg:2']), d1);
    expect(a).toMatchObject({ status: 'OPEN', occurrences: 2, costRupees: 2000 });
    const b = await repo.upsert(draft(['dg:2', 'dg:3'], { sessionDate: '2026-11-04', evidence: { cause: 'again', sessions: ['2026-11-04'], kinds: ['DECISION:DETECTOR'], symbols: ['GOLD'] } }), d2);
    expect(rows.size).toBe(1);
    expect(fixTicket.create).toHaveBeenCalledTimes(1);
    expect(b).toMatchObject({ id: a.id, occurrences: 3, costRupees: 3000, lastSeen: d2, firstSeen: d1, title: a.title });
    expect(b.evidence).toMatchObject({ sessions: ['2026-11-03', '2026-11-04'], symbols: ['GOLD', 'NIFTY'], refIds: ['dg:1', 'dg:2', 'dg:3'] });
  });

  it('a re-run of the same night adds no occurrence and no cost', async () => {
    const { repo } = memoryRepo();
    await repo.upsert(draft(['dg:1']), new Date('2026-11-04T13:15:00Z'));
    const again = await repo.upsert(draft(['dg:1']), new Date('2026-11-05T03:30:00Z'));
    expect(again).toMatchObject({ occurrences: 1, costRupees: 1000 });
  });

  it('a DONE ticket that recurs with new misses reopens; WONTFIX stays', () => {
    const base: FixTicketRecord = {
      id: 't1', key: 'k', cause: 'CODE_BUG', title: 't', evidence: { refIds: ['dg:1'] }, proposedChange: 'p', files: [], testDescription: '',
      status: 'DONE', occurrences: 1, costRupees: 0, firstSeen: new Date(0), lastSeen: new Date(0),
    };
    expect(mergeTicket(base, draft(['dg:9']), new Date()).update).toMatchObject({ status: 'OPEN', occurrences: 2 });
    expect(mergeTicket({ ...base, status: 'WONTFIX' }, draft(['dg:9']), new Date()).update?.status).toBeUndefined();
    expect(mergeTicket(base, draft(['dg:1']), new Date()).update?.status).toBeUndefined();
  });

  it('a lost create race merges into the winner', async () => {
    const { repo, fixTicket, rows } = memoryRepo();
    fixTicket.findUnique.mockResolvedValueOnce(null);
    rows.set('code-bug:risk-manager-risk-manager.service', { ...draft([]), id: 'w', status: 'OPEN', occurrences: 1, costRupees: 0, evidence: { refIds: [] }, firstSeen: new Date(0), lastSeen: new Date(0) } as FixTicketRecord);
    const r = await repo.upsert(draft(['dg:5']), new Date());
    expect(r).toMatchObject({ id: 'w', occurrences: 2 });
    expect(rows.size).toBe(1);
  });
});
