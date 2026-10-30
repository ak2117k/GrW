import { SENTINEL_CLOCK } from '../../trade-sentinel/overnight/overnight-calendar';
import type { Finding } from '../domain/checks';
import type { SanityAuditRepository } from '../repositories/sanity-audit.repository';
import { sanityAuditEnabled } from './sanity-audit.cron';
import { SanityAuditService, sanityAuditSince } from './sanity-audit.service';
import type { SanityCheck } from './sanity-checks';

/** In-memory sanity_violations with the repository's upsert / claim semantics. */
function fakeRepo() {
  const rows = new Map<string, { id: string; severity: string; alertedAt: Date | null; lastSeenAt: Date }>();
  let n = 0;
  const repo = {
    rows,
    upsertViolation: jest.fn(async (v: { check: string; subjectId: string; severity: string; at: Date }) => {
      const key = `${v.check}|${v.subjectId}`;
      const had = rows.get(key);
      if (had) {
        had.lastSeenAt = v.at;
        return { ...had, inserted: false };
      }
      const row = { id: `v${++n}`, severity: v.severity, alertedAt: null, lastSeenAt: v.at };
      rows.set(key, row);
      return { ...row, inserted: true };
    }),
    claimAlert: jest.fn(async (id: string, at: Date) => {
      const r = [...rows.values()].find((x) => x.id === id);
      if (!r || r.alertedAt) return false;
      r.alertedAt = at;
      return true;
    }),
    releaseAlert: jest.fn(async (id: string) => {
      const r = [...rows.values()].find((x) => x.id === id);
      if (r) r.alertedAt = null;
    }),
  };
  return repo;
}

const finding = (subjectId: string, subjectAt: string): Finding => ({ subjectId, subjectAt: new Date(subjectAt), message: `${subjectId} broke`, detail: {} });

function check(rows: Finding[], over: Partial<SanityCheck> = {}): SanityCheck {
  return { check: 'PAPER_FILL_VS_LTP', id: 'test', severity: 'error', load: async () => rows, evaluate: (r) => r as Finding, ...over };
}

describe('SanityAuditService', () => {
  const now = new Date('2026-10-30T16:00:00Z');
  const env = { SANITY_AUDIT_SINCE: '2026-10-30T09:30:00Z' };

  it('alerts a new violation once, stores older subjects as known without alerting', async () => {
    const repo = fakeRepo();
    const svc = new SanityAuditService(repo as unknown as SanityAuditRepository, SENTINEL_CLOCK);
    const alert = jest.fn(async () => true);
    const checks = [check([finding('old', '2026-10-30T04:02:19Z'), finding('new', '2026-10-30T11:58:11Z')])];

    const first = await svc.run(now, { env, alert, checks });
    expect(first.found).toEqual([
      { check: 'PAPER_FILL_VS_LTP', subjectId: 'old', severity: 'known' },
      { check: 'PAPER_FILL_VS_LTP', subjectId: 'new', severity: 'error' },
    ]);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledWith('sanity:PAPER_FILL_VS_LTP:new', 'Sanity PAPER_FILL_VS_LTP: new broke');

    const second = await svc.run(new Date(now.getTime() + 300_000), { env, alert, checks });
    expect(second.alerted).toBe(0);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(repo.rows.size).toBe(2);
  });

  it('retries an alert whose send failed', async () => {
    const repo = fakeRepo();
    const svc = new SanityAuditService(repo as unknown as SanityAuditRepository, SENTINEL_CLOCK);
    const alert = jest.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const checks = [check([finding('new', '2026-10-30T11:58:11Z')])];
    expect((await svc.run(now, { env, alert, checks })).alerted).toBe(0);
    expect((await svc.run(now, { env, alert, checks })).alerted).toBe(1);
  });

  it('a failing check is reported and skipped; the others still run', async () => {
    const repo = fakeRepo();
    const svc = new SanityAuditService(repo as unknown as SanityAuditRepository, SENTINEL_CLOCK);
    const alert = jest.fn(async () => true);
    const broken = check([], { id: 'broken', load: async () => { throw new Error('relation does not exist'); } });
    const report = await svc.run(now, { env, alert, checks: [broken, check([finding('new', '2026-10-30T11:58:11Z')])] });
    expect(report.failed).toEqual(['broken']);
    expect(report.found).toHaveLength(1);
    expect(alert).toHaveBeenCalledWith('sanity:check-failed:broken', expect.stringContaining('relation does not exist'));
  });

  it('reads SANITY_AUDIT_SINCE (bad value → default) and SANITY_AUDIT=off', () => {
    expect(sanityAuditSince({}).toISOString()).toBe('2026-10-30T09:30:00.000Z');
    expect(sanityAuditSince({ SANITY_AUDIT_SINCE: 'nope' }).toISOString()).toBe('2026-10-30T09:30:00.000Z');
    expect(sanityAuditSince({ SANITY_AUDIT_SINCE: '2026-11-01T00:00:00Z' }).toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(sanityAuditEnabled({})).toBe(true);
    expect(sanityAuditEnabled({ SANITY_AUDIT: 'off' })).toBe(false);
  });
});
