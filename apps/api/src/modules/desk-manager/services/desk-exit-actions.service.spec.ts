import { Logger, UnprocessableEntityException } from '@nestjs/common';
import { parseDeskManagerConfig } from '../desk-manager.config';
import type { ActionContext, DeskPacket, PositionView } from '../domain/desk.types';
import { DeskExitActions, bullishExposure, isTighter } from './desk-exit-actions.service';

const NOW = new Date('2026-11-26T05:30:00Z'); // 11:00 IST
const OWNER = 'owner';
const none = { status: 'unavailable' as const, reason: 'spec', source: 'spec' };

const pos = (over: Partial<PositionView> = {}): PositionView => ({
  trackerId: 't1', symbol: 'BSE30DEC253900CE', exchange: 'NFO', underlying: 'BSE', qty: 375, entry: 80, ltp: 90, pnl: 3750,
  ageMin: 20, origin: 'manager', held: false, sentinel: null, managerStop: 3863, managerTargets: [3950, 4000], ...over,
});

const packet = (positions: PositionView[]): DeskPacket => ({
  at: NOW.toISOString(), mode: 'live', day: none, pnl: none, guard: none,
  positions: { status: 'present', value: positions, source: 'spec' },
  recentExits: none, proposals: none, instruments: none, health: none, memory: none,
});

const ctx = (mode: 'off' | 'shadow' | 'live', positions: PositionView[] = [pos()], env: Record<string, string> = {}): ActionContext => ({
  runId: 'run1', decisionId: 'dec1', now: NOW, packet: packet(positions),
  cfg: parseDeskManagerConfig({ DESK_MANAGER: mode, HUB_OWNER_USER_ID: OWNER, ...env }),
});

function harness(o: { exitsToday?: number; trade?: unknown; managerOrders?: Array<{ trackerId: string | null }>; market?: boolean } = {}) {
  const prisma = {
    deskManagerDecision: { count: jest.fn(async () => o.exitsToday ?? 0) },
    sentinelVerdict: { create: jest.fn(async () => ({ id: 'v-desk-1' })) },
    trade: { findUnique: jest.fn(async () => o.trade ?? null) },
    signalOrder: {
      count: jest.fn(async () => (o.managerOrders ?? []).length),
      findMany: jest.fn(async () => o.managerOrders ?? []),
    },
  };
  const done = Promise.resolve({ status: 'FILLED' });
  const manual = {
    request: jest.fn(async () => ({ row: { id: 'exec1', verdictId: 'man_t1_1', status: 'CLAIMED' }, started: true, done })),
  };
  const paper = { closeTrade: jest.fn(async () => ({ status: 'CLOSED', pnl: 1200 })) };
  const market = {
    underlyingRef: jest.fn(async (u: string) => ({ exchange: 'NSE', token: '19585', symbol: u })),
    ltps: jest.fn(async () => new Map([['NSE:19585', 3901.5]])),
  };
  const svc = new DeskExitActions(prisma as never, manual as never, paper as never, o.market === false ? undefined : (market as never));
  return { svc, prisma, manual, paper, market };
}

describe('DeskExitActions', () => {
  const ENV = { ...process.env };
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    delete process.env.AI_AUTO_EXIT_HOLD;
  });
  afterEach(() => {
    process.env = { ...ENV };
    jest.restoreAllMocks();
  });

  describe('EXIT / BOOK', () => {
    it('EXIT calls manual exit with the system caller and reason', async () => {
      const h = harness();
      const r = await h.svc.exit('t1', 'EXIT', 'thesis broken: BSE 3858 below the 3863 invalidation', ctx('live'));
      expect(h.manual.request).toHaveBeenCalledWith(
        { userId: OWNER, role: 'ADMIN', email: 'desk-manager' },
        't1',
        { now: NOW, reason: 'DESK_MANAGER EXIT: thesis broken: BSE 3858 below the 3863 invalidation' },
      );
      expect(r).toEqual({ status: 'DONE', detail: expect.stringContaining('man_t1_1'), ref: 'exec1' });
    });

    it('BOOK is the same path, named BOOK', async () => {
      const h = harness();
      await h.svc.exit('t1', 'BOOK', 'target 1 reached', ctx('live'));
      expect((h.manual.request.mock.calls[0] as unknown[])[2]).toEqual({ now: NOW, reason: 'DESK_MANAGER BOOK: target 1 reached' });
    });

    it('EXIT refused on HOLD-listed tracker (packet held, or AI_AUTO_EXIT_HOLD by symbol)', async () => {
      const h = harness();
      const a = await h.svc.exit('t1', 'EXIT', 'x', ctx('live', [pos({ held: true })]));
      process.env.AI_AUTO_EXIT_HOLD = 'bse30dec253900ce';
      const b = await h.svc.exit('t1', 'EXIT', 'x', ctx('live'));
      expect(a.status).toBe('REFUSED');
      expect(b.status).toBe('REFUSED');
      expect(b.detail).toMatch(/OWNER_HOLD/);
      expect(h.manual.request).not.toHaveBeenCalled();
    });

    it('exits capped at maxExits per day', async () => {
      const h = harness({ exitsToday: 20 });
      const r = await h.svc.exit('t1', 'EXIT', 'x', ctx('live'));
      expect(r.status).toBe('REFUSED');
      expect(r.detail).toMatch(/EXIT_CAP: 20 manager exits today/);
      expect(h.manual.request).not.toHaveBeenCalled();
      // The count is today's (IST) EXIT/BOOK that acted or are working.
      expect(h.prisma.deskManagerDecision.count).toHaveBeenCalledWith({
        where: { userId: OWNER, action: { in: ['EXIT', 'BOOK'] }, status: { in: ['DONE', 'PENDING'] }, createdAt: { gte: new Date('2026-11-25T18:30:00.000Z') } },
      });
      const lower = harness({ exitsToday: 2 });
      expect((await lower.svc.exit('t1', 'EXIT', 'x', ctx('live', [pos()], { DESK_MANAGER_MAX_EXITS: '2' }))).status).toBe('REFUSED');
    });

    describe('trade agent exit authority', () => {
      const withAuthority = (live: boolean, raise: jest.Mock = jest.fn(async () => ({ id: 'alarm-1' }))) => {
        const h = harness();
        const svc = new DeskExitActions(h.prisma as never, h.manual as never, h.paper as never, h.market as never, { raise }, { isLive: () => live });
        return { ...h, svc, raise };
      };

      it('live: a live EXIT / BOOK raises a SUPREME_EXIT alarm and does NOT call manual exit', async () => {
        const h = withAuthority(true);
        const r = await h.svc.exit('t1', 'BOOK', 'target 1 reached', ctx('live'));
        expect(r).toEqual({ status: 'PENDING', detail: 'asked the trade agent' });
        expect(h.manual.request).not.toHaveBeenCalled();
        expect(h.raise).toHaveBeenCalledTimes(1);
        expect(h.raise.mock.calls[0][0]).toEqual(
          expect.objectContaining({ userId: OWNER, trackerId: 't1', symbol: 'BSE30DEC253900CE', rule: 'SUPREME_EXIT', urgency: 'normal', reason: 'supreme asks BOOK: target 1 reached', sourceRef: 'dec1' }),
        );
        const e = await h.svc.exit('t1', 'EXIT', 'thesis broken', ctx('live'));
        expect(e.status).toBe('PENDING');
        expect(h.raise.mock.calls[1][0].reason).toBe('supreme asks EXIT: thesis broken');
      });

      it('live: an alarm already open (deduped, null) is still PENDING', async () => {
        const h = withAuthority(true, jest.fn(async () => null));
        expect(await h.svc.exit('t1', 'EXIT', 'x', ctx('live'))).toEqual({ status: 'PENDING', detail: 'asked the trade agent' });
        expect(h.manual.request).not.toHaveBeenCalled();
      });

      it('live: the alarm failing falls back to the manual exit (the supreme wins)', async () => {
        const h = withAuthority(true, jest.fn(async () => { throw new Error('db down'); }));
        const r = await h.svc.exit('t1', 'EXIT', 'x', ctx('live'));
        expect(r.status).toBe('DONE');
        expect(h.manual.request).toHaveBeenCalledTimes(1);
      });

      it('off (isLive false, or no ports): today\'s manual exit, no alarm', async () => {
        const h = withAuthority(false);
        expect((await h.svc.exit('t1', 'EXIT', 'x', ctx('live'))).status).toBe('DONE');
        expect(h.manual.request).toHaveBeenCalledTimes(1);
        expect(h.raise).not.toHaveBeenCalled();
      });

      it('live: paper trackers and the hold list keep today\'s rules', async () => {
        const h = withAuthority(true);
        h.prisma.trade.findUnique.mockResolvedValueOnce({ id: 'tr1', isPaperTrade: true, strategy: 'DESK_MANAGER', status: 'OPEN' } as never);
        expect((await h.svc.exit('paper:tr1', 'EXIT', 'x', ctx('live', [pos({ trackerId: 'paper:tr1' })]))).status).toBe('DONE');
        expect(h.paper.closeTrade).toHaveBeenCalled();
        expect((await h.svc.exit('t1', 'EXIT', 'x', ctx('live', [pos({ held: true })]))).status).toBe('REFUSED');
        expect(h.raise).not.toHaveBeenCalled();
      });
    });

    it('an attempt already working is PENDING, not a second order', async () => {
      const h = harness();
      h.manual.request.mockResolvedValueOnce({ row: { id: 'exec0', verdictId: 'man_t1_1', status: 'PLACED' }, started: false, done: Promise.resolve(null) } as never);
      expect(await h.svc.exit('t1', 'EXIT', 'x', ctx('live'))).toEqual(expect.objectContaining({ status: 'PENDING', ref: 'exec0' }));
    });

    it('a manual-exit refusal (closed tracker, 422) is REFUSED with its message', async () => {
      const h = harness();
      h.manual.request.mockRejectedValueOnce(new UnprocessableEntityException('TRACKER_CLOSED: this position is already closed'));
      expect(await h.svc.exit('t1', 'EXIT', 'x', ctx('live'))).toEqual({ status: 'REFUSED', detail: 'TRACKER_CLOSED: this position is already closed' });
    });

    it('shadow: a live position is recorded only; the manager paper trade closes through the paper path', async () => {
      const h = harness({ trade: { id: 'tr1', isPaperTrade: true, strategy: 'DESK_MANAGER', status: 'OPEN' } });
      expect((await h.svc.exit('t1', 'EXIT', 'x', ctx('shadow'))).status).toBe('RECORDED');
      expect(h.manual.request).not.toHaveBeenCalled();
      const r = await h.svc.exit('paper:tr1', 'BOOK', 'target 1', ctx('shadow', [pos({ trackerId: 'paper:tr1' })]));
      expect(r.status).toBe('DONE');
      expect(h.paper.closeTrade).toHaveBeenCalledWith('tr1', expect.objectContaining({ exitReasonTag: 'DESK_MANAGER_BOOK', reason: 'DESK_MANAGER BOOK: target 1' }));
    });

    it('never closes a paper trade that is not the manager’s own', async () => {
      const h = harness({ trade: { id: 'tr2', isPaperTrade: true, strategy: 'AI_SETUP', status: 'OPEN' } });
      const r = await h.svc.exit('paper:tr2', 'EXIT', 'x', ctx('shadow', [pos({ trackerId: 'paper:tr2' })]));
      expect(r.status).toBe('REFUSED');
      expect(h.paper.closeTrade).not.toHaveBeenCalled();
    });

    it('mode off refuses', async () => {
      const h = harness();
      expect((await h.svc.exit('t1', 'EXIT', 'x', ctx('off'))).status).toBe('REFUSED');
      expect(h.manual.request).not.toHaveBeenCalled();
    });
  });

  describe('TIGHTEN', () => {
    it('TIGHTEN writes a HOLD verdict with an UNDERLYING BELOW trigger for a CE', async () => {
      const h = harness();
      const r = await h.svc.tighten('t1', 3880, 'BSE held 3880 on the 15m close', ctx('live'));
      expect(r).toEqual({ status: 'RECORDED', detail: expect.stringContaining('BSE BELOW 3880'), ref: 'v-desk-1' });
      const data = (h.prisma.sentinelVerdict.create.mock.calls[0] as any)[0].data;
      expect(data).toEqual(expect.objectContaining({
        userId: OWNER, trackerId: 't1', symbol: 'BSE30DEC253900CE', verdict: 'HOLD', confidence: 'high',
        reason: 'DESK_MANAGER TIGHTEN: BSE held 3880 on the 15m close', promptVersion: 'desk-manager/1', triggeredBy: ['desk-manager'],
      }));
      expect(data.exitTrigger).toEqual({
        v: 1, instrument: 'UNDERLYING', op: 'BELOW', price: 3880,
        watch: { exchange: 'NSE', token: '19585', symbol: 'BSE' }, seen: { price: 3901.5, at: NOW.toISOString() },
      });
    });

    it('PE gets ABOVE', async () => {
      const h = harness();
      const pe = pos({ symbol: 'BSE30DEC253900PE', managerStop: 3950 });
      await h.svc.tighten('t1', 3920, 'lower high', ctx('live', [pe]));
      expect((h.prisma.sentinelVerdict.create.mock.calls[0] as any)[0].data.exitTrigger).toEqual(expect.objectContaining({ op: 'ABOVE', price: 3920 }));
    });

    it('never loosens the manager stop (CE lower, PE higher, equal)', async () => {
      const h = harness();
      expect((await h.svc.tighten('t1', 3850, 'x', ctx('live'))).detail).toMatch(/^LOOSENS/);
      expect((await h.svc.tighten('t1', 3863, 'x', ctx('live'))).status).toBe('REFUSED');
      const pe = pos({ symbol: 'BSE30DEC253900PE', managerStop: 3950 });
      expect((await h.svc.tighten('t1', 3960, 'x', ctx('live', [pe]))).status).toBe('REFUSED');
      expect(h.prisma.sentinelVerdict.create).not.toHaveBeenCalled();
    });

    it('refused on a HOLD-listed tracker and on a tracker not in the packet', async () => {
      const h = harness();
      expect((await h.svc.tighten('t1', 3880, 'x', ctx('live', [pos({ held: true })]))).detail).toMatch(/OWNER_HOLD/);
      expect((await h.svc.tighten('t9', 3880, 'x', ctx('live'))).detail).toMatch(/NOT_IN_PACKET/);
      expect(h.prisma.sentinelVerdict.create).not.toHaveBeenCalled();
    });

    it('shadow: recorded, nothing armed; paper trade: recorded for the target watch', async () => {
      const h = harness();
      expect((await h.svc.tighten('t1', 3880, 'x', ctx('shadow'))).status).toBe('RECORDED');
      const p = await h.svc.tighten('paper:tr1', 3880, 'x', ctx('live', [pos({ trackerId: 'paper:tr1' })]));
      expect(p).toEqual({ status: 'RECORDED', detail: expect.stringContaining('target watch') });
      expect(h.prisma.sentinelVerdict.create).not.toHaveBeenCalled();
    });

    it('no market wired: FAILED loudly, never a silent no-op', async () => {
      const h = harness({ market: false });
      expect(await h.svc.tighten('t1', 3880, 'x', ctx('live'))).toEqual({ status: 'FAILED', detail: expect.stringMatching(/^NO_MARKET/) });
    });
  });

  describe('manager trackers', () => {
    it('isManagerTracker: signal_orders.source = manager (live), DESK_MANAGER strategy (paper)', async () => {
      const yes = harness({ managerOrders: [{ trackerId: 't1' }] });
      expect(await yes.svc.isManagerTracker('t1')).toBe(true);
      expect(yes.prisma.signalOrder.count).toHaveBeenCalledWith({ where: { trackerId: 't1', source: 'manager' } });
      expect(await harness().svc.isManagerTracker('t1')).toBe(false);
      expect(await harness({ trade: { strategy: 'DESK_MANAGER' } }).svc.isManagerTracker('paper:tr1')).toBe(true);
    });

    it('managerTrackerIds: one query for the live ids, paper ids ignored', async () => {
      const h = harness({ managerOrders: [{ trackerId: 't1' }, { trackerId: null }] });
      expect([...(await h.svc.managerTrackerIds(['t1', 't2', 'paper:x']))]).toEqual(['t1']);
      expect(h.prisma.signalOrder.findMany).toHaveBeenCalledWith({ where: { trackerId: { in: ['t1', 't2'] }, source: 'manager' }, select: { trackerId: true } });
      expect((await h.svc.managerTrackerIds(['paper:x'])).size).toBe(0);
    });
  });

  it('exposure helpers', () => {
    expect(bullishExposure('NIFTY02DEC2524000CE', 75)).toBe(true);
    expect(bullishExposure('NIFTY02DEC2524000PE', 75)).toBe(false);
    expect(bullishExposure('GOLDM05DEC25FUT', 10)).toBe(true);
    expect(bullishExposure('NIFTY02DEC2524000PE', -75)).toBe(true);
    expect(isTighter(true, 101, 100)).toBe(true);
    expect(isTighter(false, 101, 100)).toBe(false);
    expect(isTighter(true, 1, null)).toBe(true);
  });
});
