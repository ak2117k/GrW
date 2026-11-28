import { parseDeskManagerConfig } from '../desk-manager.config';
import type { ClosedTrade } from '../domain/desk.types';
import type { GuardDayPath, GuardOpenTrade } from '../domain/pnl-path';
import { DeskGuardService } from './desk-guard.service';

const NOW = new Date('2026-11-26T06:00:00Z');
const cfg = parseDeskManagerConfig({});
const loser = (id: string, min: number, pnl = -500, origin: ClosedTrade['origin'] = 'manager', symbol = 'NIFTY02DEC2625000CE'): ClosedTrade => ({
  trackerId: id, symbol, underlying: 'NIFTY', exitAt: new Date(NOW.getTime() - min * 60_000), pnl, origin,
});
const openPos = (id: string, pnl: number, origin: GuardOpenTrade['origin'] = 'manager', symbol = 'NIFTY02DEC2625000CE', todayPnl = pnl): GuardOpenTrade => ({
  trackerId: id, symbol, pnl, todayPnl, origin,
});

const HOLD_ENV = process.env.AI_AUTO_EXIT_HOLD;
afterEach(() => {
  if (HOLD_ENV === undefined) delete process.env.AI_AUTO_EXIT_HOLD;
  else process.env.AI_AUTO_EXIT_HOLD = HOLD_ENV;
});

function make(closed: ClosedTrade[] = [], open: GuardOpenTrade[] = []) {
  let day = { pausedUntil: null as Date | null, pauseScope: null as string | null, resetAt: null as Date | null };
  const repo = {
    closedToday: jest.fn(async () => closed),
    openTrades: jest.fn(async () => open),
    guardDay: jest.fn(async () => ({ ...day })),
    savePause: jest.fn(async (_u: string, _n: Date, until: Date | null, scope: string | null) => void (day = { ...day, pausedUntil: until, pauseScope: scope })),
    saveReset: jest.fn(async (_u: string, n: Date) => void (day = { pausedUntil: null, pauseScope: null, resetAt: n })),
    recordEvent: jest.fn(async () => undefined),
  };
  return { svc: new DeskGuardService(repo as never, cfg), repo, day: () => day };
}

describe('DeskGuardService', () => {
  it('a third app loser (signal, reentry, manager) blocks and the block is recorded', async () => {
    const t = make([loser('a', 30, -500, 'signal'), loser('b', 20, -500, 'reentry'), loser('c', 10)]);
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
    const t = make([loser('a', 10, -6000)], [openPos('o', -2000)]);
    expect((await t.svc.state('owner', NOW)).reasons).toContain('day loss ₹8000 ≥ ₹8000');
  });

  it("a carried counted position adds only today's move (todayPnl), not its since-entry pnl", async () => {
    const t = make([], [openPos('c', -9000, 'signal', 'NIFTY02DEC2625000CE', -1000)]);
    const g = await t.svc.state('owner', NOW);
    expect(g.path).toEqual(expect.objectContaining({ open: -1000, drawdownFromPeak: 1000 }));
    expect(g.blocked).toBe(false);
  });

  describe("owner manual and held trades never count (2026-11-27 prod day)", () => {
    // Desk realised +2,409; the owner's held MAZDOCK put (carried from 11-25) −4,399 and 3 owner manual losers.
    const day = () => {
      process.env.AI_AUTO_EXIT_HOLD = 'MAZDOCK29DEC261760PE';
      return make(
        [loser('desk1', 200, 2409), loser('own1', 120, -900, 'manual'), loser('own2', 90, -1100, 'manual'), loser('own3', 60, -800, 'manual')],
        [openPos('maz', -4399, 'manual', 'MAZDOCK29DEC261760PE')],
      );
    };

    it('owner manual losers ×3 and a held MAZDOCK −₹4.4k → not blocked, streak 0', async () => {
      const g = await day().svc.check('owner', 'manager', 'NIFTY', NOW);
      expect(g.blocked).toBe(false);
      expect(g.reasons).toEqual([]);
      expect(g.path).toEqual(expect.objectContaining({ realised: 2409, open: 0, total: 2409, drawdownFromPeak: 0, lossStreak: 0 }));
    });

    it('the excluded P&L is reported as ownerPnl on the path the pnl block shows', async () => {
      const g = await day().svc.state('owner', NOW);
      expect((g.path as GuardDayPath).ownerPnl).toEqual({ realised: -2800, open: -4399 });
    });

    it('held and owner trades are never in the streak or the closed list', async () => {
      const g = await day().svc.state('owner', NOW);
      expect(g.path.closed.map((c) => c.trackerId)).toEqual(['desk1']);
      expect(g.path.lossStreak).toBe(0);
    });

    it('a held MANAGER position is excluded too', async () => {
      process.env.AI_AUTO_EXIT_HOLD = 'HELDX';
      const t = make([loser('a', 30, -500, 'manager', 'HELDX'), loser('b', 20, -500, 'manager', 'HELDX'), loser('c', 10, -500, 'manager', 'HELDX')], [openPos('h', -9000, 'manager', 'HELDX')]);
      const g = await t.svc.state('owner', NOW);
      expect(g.blocked).toBe(false);
      expect((g.path as GuardDayPath).ownerPnl).toEqual({ realised: -1500, open: -9000 });
    });

    it('manager trades with a −₹5.1k drawdown → blocked', async () => {
      const t = make([loser('a', 30, -2600)], [openPos('m', -2500)]);
      const g = await t.svc.check('owner', 'manager', 'NIFTY', NOW);
      expect(g.path).toEqual(expect.objectContaining({ peak: 0, total: -5100, drawdownFromPeak: 5100 }));
      expect(g.blocked).toBe(true);
      expect(g.reasons).toEqual(['drawdown ₹5100 ≥ ₹5000']);
    });
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
