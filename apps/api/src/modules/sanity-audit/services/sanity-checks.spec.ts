import { SENTINEL_CLOCK } from '../../trade-sentinel/overnight/overnight-calendar';
import type { SanityAuditRepository } from '../repositories/sanity-audit.repository';
import { SANITY_CHECKS, type CheckContext } from './sanity-checks';

const entry = (id: string) => SANITY_CHECKS.find((c) => c.id === id)!;
const ctx = (now: string, env: Record<string, string> = {}): CheckContext => ({ now: new Date(now), from: new Date(new Date(now).getTime() - 7 * 86_400_000), clock: SENTINEL_CLOCK, env });

describe('SANITY_CHECKS (registry, real calendar)', () => {
  it('has unique entry ids', () => {
    expect(new Set(SANITY_CHECKS.map((c) => c.id)).size).toBe(SANITY_CHECKS.length);
  });

  it('oi-feed: only in the NFO session after the 10-min grace (Fri 30 Oct 2026)', async () => {
    const nfoOiBeat = jest.fn(async () => ({ lastAny: new Date('2026-10-30T05:58:00Z'), lastFutLtp: new Date('2026-10-30T05:40:00Z') }));
    const repo = { nfoOiBeat } as unknown as SanityAuditRepository;
    expect(await entry('oi-feed').load(repo, ctx('2026-10-30T03:50:00Z'))).toEqual([]); // 09:20 IST: grace
    expect(await entry('oi-feed').load(repo, ctx('2026-10-30T10:05:00Z'))).toEqual([]); // 15:35 IST: closed
    expect(await entry('oi-feed').load(repo, ctx('2026-10-31T06:00:00Z'))).toEqual([]); // Saturday
    const c = ctx('2026-10-30T06:00:00Z');
    const rows = await entry('oi-feed').load(repo, c);
    const found = rows.map((r) => entry('oi-feed').evaluate(r, c));
    expect(found[0]).toBeNull(); // any NFO row 2 min old
    expect(found[1]!.subjectId).toBe('oi-nfo-fut:2026-10-30'); // futures ltp 20 min old
  });

  it('noise-follow: an NSE exit whose +30 min is after the close is not judged; an MCX one is', async () => {
    const unfilledNoiseFollows = jest.fn(async () => [
      { id: 'wipro', symbol: 'WIPRO-EQ', exitAt: new Date('2026-10-30T09:53:03Z'), after30m: null, underlyingExchange: 'NSE' },
      { id: 'crude', symbol: 'CRUDEOIL17NOV2610500CE', exitAt: new Date('2026-10-30T09:59:56Z'), after30m: null, underlyingExchange: 'MCX' },
    ]);
    const c = ctx('2026-10-30T16:51:00Z');
    const rows = await entry('noise-follow').load({ unfilledNoiseFollows } as unknown as SanityAuditRepository, c);
    const found = rows.map((r) => entry('noise-follow').evaluate(r, c)).filter(Boolean);
    expect(found.map((f) => f!.subjectId)).toEqual(['noise-follow:crude']);
  });

  it('self-review: off with SELF_REVIEW_ENABLED=false; else judges the last due session', async () => {
    const firstDoneReview = jest.fn(async () => new Date('2026-10-30T13:15:00Z'));
    const repo = { firstDoneReview } as unknown as SanityAuditRepository;
    expect(await entry('self-review').load(repo, ctx('2026-10-30T20:00:00Z', { SELF_REVIEW_ENABLED: 'false' }))).toEqual([]);
    const c = ctx('2026-10-30T20:00:00Z');
    const rows = await entry('self-review').load(repo, c);
    expect(firstDoneReview).toHaveBeenCalledWith('2026-10-30');
    expect(entry('self-review').evaluate(rows[0], c)).toBeNull();
  });
});
