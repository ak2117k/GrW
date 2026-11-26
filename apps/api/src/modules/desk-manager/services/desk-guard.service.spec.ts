import { parseDeskManagerConfig } from '../desk-manager.config';
import type { ClosedTrade } from '../domain/desk.types';
import { DeskGuardService } from './desk-guard.service';

const NOW = new Date('2026-11-26T06:00:00Z');
const cfg = parseDeskManagerConfig({});
const loser = (id: string, min: number, pnl = -500, origin: ClosedTrade['origin'] = 'manual'): ClosedTrade => ({
  trackerId: id, symbol: 'NIFTY02DEC2625000CE', underlying: 'NIFTY', exitAt: new Date(NOW.getTime() - min * 60_000), pnl, origin,
});

function make(closed: ClosedTrade[] = [], open = 0) {
  let day = { pausedUntil: null as Date | null, pauseScope: null as string | null, resetAt: null as Date | null };
  const repo = {
    closedToday: jest.fn(async () => closed),
    openPnl: jest.fn(async () => open),
    guardDay: jest.fn(async () => ({ ...day })),
    savePause: jest.fn(async (_u: string, _n: Date, until: Date | null, scope: string | null) => void (day = { ...day, pausedUntil: until, pauseScope: scope })),
    saveReset: jest.fn(async (_u: string, n: Date) => void (day = { pausedUntil: null, pauseScope: null, resetAt: n })),
    recordEvent: jest.fn(async () => undefined),
  };
  return { svc: new DeskGuardService(repo as never, cfg), repo, day: () => day };
}

describe('DeskGuardService', () => {
  it('a third manual loser blocks and the block is recorded', async () => {
    const t = make([loser('a', 30, -500, 'signal'), loser('b', 20), loser('c', 10)]);
    const g = await t.svc.check('owner', 'signal', 'NIFTY', NOW);
    expect(g.blocked).toBe(true);
    expect(g.reasons).toEqual(['3 losers in a row ≥ 3']);
    expect(t.repo.recordEvent).toHaveBeenCalledWith(expect.objectContaining({ userId: 'owner', source: 'signal', blocked: true, reasons: g.reasons }));
  });

  it('allowed → no event row', async () => {
    const t = make([loser('a', 10)]);
    expect((await t.svc.check('owner', 'reentry', 'NIFTY', NOW)).blocked).toBe(false);
    expect(t.repo.recordEvent).not.toHaveBeenCalled();
  });

  it('open P&L counts toward the day loss', async () => {
    const t = make([loser('a', 10, -6000)], -2000);
    expect((await t.svc.state('owner', NOW)).reasons).toContain('day loss ₹8000 ≥ ₹8000');
  });

  it('fails closed: an unreadable day blocks with DESK_GUARD_UNAVAILABLE', async () => {
    const t = make();
    t.repo.closedToday.mockRejectedValueOnce(new Error('db down'));
    const g = await t.svc.check('owner', 'manager', 'BSE', NOW);
    expect(g.blocked).toBe(true);
    expect(g.reasons[0]).toBe('DESK_GUARD_UNAVAILABLE: db down');
  });

  it('a failure to record the event does not unblock', async () => {
    const t = make([loser('a', 30), loser('b', 20), loser('c', 10)]);
    t.repo.recordEvent.mockRejectedValueOnce(new Error('insert failed'));
    expect((await t.svc.check('owner', 'signal', null, NOW)).blocked).toBe(true);
  });

  it('pause blocks its scope; a shorter or narrower pause never loosens it', async () => {
    const t = make();
    await t.svc.pause('owner', 'nifty', 60, NOW);
    expect((await t.svc.check('owner', 'manager', 'NIFTY', NOW)).blocked).toBe(true);
    expect((await t.svc.check('owner', 'manager', 'BANKNIFTY', NOW)).blocked).toBe(false);
    await t.svc.pause('owner', 'NIFTY', 5, NOW);
    expect(t.day().pausedUntil).toEqual(new Date(NOW.getTime() + 60 * 60_000));
    await t.svc.pause('owner', 'BANKNIFTY', 10, NOW);
    expect(t.day().pauseScope).toBe('all');
    await t.svc.pause('owner', 'NIFTY', 30, NOW);
    expect(t.day()).toMatchObject({ pauseScope: 'all', pausedUntil: new Date(NOW.getTime() + 60 * 60_000) });
  });

  it('pause minutes are clamped to 1–390', async () => {
    const t = make();
    await t.svc.pause('owner', 'all', 10_000, NOW);
    expect(t.day().pausedUntil).toEqual(new Date(NOW.getTime() + 390 * 60_000));
  });

  it('resume lifts the pause; reset clears the pause and stamps resetAt', async () => {
    const t = make();
    await t.svc.pause('owner', 'all', 30, NOW);
    expect((await t.svc.resume('owner', NOW)).blocked).toBe(false);
    await t.svc.pause('owner', 'all', 30, NOW);
    const g = await t.svc.reset('owner', NOW);
    expect(g.blocked).toBe(false);
    expect(t.day()).toEqual({ pausedUntil: null, pauseScope: null, resetAt: NOW });
  });
});
