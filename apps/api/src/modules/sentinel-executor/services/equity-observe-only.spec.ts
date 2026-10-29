// apps/api/src/modules/sentinel-executor/services/equity-observe-only.spec.ts
import { evaluateGuards, type GuardInput } from '../domain/guards';
import { parseAutoExitConfig } from '../domain/auto-exit.config';
import { AUTO_EXIT_EXCHANGES } from '../domain/auto-exit.types';
import type { PendingVerdict } from '../repositories/ai-exit-execution.repository';
import { SentinelExitExecutor } from './sentinel-exit-executor.service';
import { TriggerWatchService } from './trigger-watch.service';

/**
 * EQUITY IS WATCHED, NEVER CLOSED (2026-10-29).
 *
 * The live sentinel now watches intraday cash-equity positions (the owner's
 * JPL-EQ, NSE) — observe-only. Nothing in the sentinel marks them so: the
 * guarantee is THIS module's exchange gate (`AUTO_EXIT_EXCHANGES` = NFO/BFO/MCX),
 * applied by evaluateGuards on every EXIT_NOW (AI, PRICE_TRIGGER and MANUAL) and
 * by TriggerWatchService before an exitTrigger is ever armed. These tests pin
 * that gate for an equity tracker with every other switch set to "go": live
 * mode, allow-listed owner, fresh verdict, open market, no cap. If one fails,
 * an equity verdict can reach a broker order — fix the gate, not the test.
 */

const NOW = new Date('2026-10-29T05:00:00Z'); // 10:30 IST, NSE open
const LIVE = parseAutoExitConfig({
  AI_AUTO_EXIT_ENABLED: 'true', AI_AUTO_EXIT_MODE: 'live', AI_AUTO_EXIT_USER_IDS: 'owner',
});
const JPL = { id: 'jpl', userId: 'owner', symbol: 'JPL-EQ', status: 'OPEN', kind: 'POSITION', exchange: 'NSE', token: '11111', qty: 40 };

describe('equity observe-only — the roster/executor contract', () => {
  it('the executable exchanges are exactly the F&O ones — never a cash exchange', () => {
    // The roster admits a tracker as equity only when trade-sentinel's
    // segmentFor says EQ_INTRADAY, which it never does on NFO/BFO/MCX (that
    // side is pinned in trade-sentinel's roster.service.spec.ts; this module may not
    // import trade-sentinel — see sentinel-executor.structure.spec.ts). So the
    // two sets are disjoint as long as this list stays F&O-only.
    expect([...AUTO_EXIT_EXCHANGES].sort()).toEqual(['BFO', 'MCX', 'NFO']);
    expect(AUTO_EXIT_EXCHANGES).not.toContain('NSE');
    expect(AUTO_EXIT_EXCHANGES).not.toContain('BSE');
  });
});

describe('equity observe-only — evaluateGuards', () => {
  const input = (tracker: GuardInput['tracker'], trigger?: GuardInput['trigger']): GuardInput => ({
    config: LIVE, now: NOW, verdict: { userId: 'owner', createdAt: new Date(NOW.getTime() - 5_000) },
    tracker, isOpen: () => true, countedToday: 0, inFlight: false, ...(trigger ? { trigger } : {}),
  });

  it.each([
    ['AI EXIT_NOW', undefined],
    ['PRICE_TRIGGER (exitTrigger crossed)', 'PRICE_TRIGGER' as const],
    ['MANUAL', 'MANUAL' as const],
  ])('%s on JPL-EQ (NSE) and a BSE cash position → EXCHANGE_NOT_FNO', (_l, trigger) => {
    expect(evaluateGuards(input(JPL, trigger))).toEqual({ ok: false, reason: 'EXCHANGE_NOT_FNO' });
    expect(evaluateGuards(input({ ...JPL, symbol: 'JPL', exchange: 'BSE' }, trigger))).toEqual({ ok: false, reason: 'EXCHANGE_NOT_FNO' });
    expect(evaluateGuards(input({ ...JPL, exchange: 'nse' }, trigger))).toEqual({ ok: false, reason: 'EXCHANGE_NOT_FNO' });
  });

  it('control: the same inputs on an NFO contract pass — the exchange alone refuses the equity', () => {
    expect(evaluateGuards(input({ ...JPL, symbol: 'JPL25NOV26FUT', exchange: 'NFO' }))).toEqual({ ok: true });
  });
});

describe('equity observe-only — SentinelExitExecutor', () => {
  const V: PendingVerdict = {
    id: 'cm9verdictjpl00000000001', userId: 'owner', trackerId: 'jpl', symbol: 'JPL-EQ',
    reason: 'thesis broken', createdAt: new Date(NOW.getTime() - 5_000),
  };

  function harness() {
    const session = {
      getPositionsEnvelope: jest.fn(), getOrderBookEnvelope: jest.fn(),
      placeOrderClassified: jest.fn(), cancelOrderClassified: jest.fn(),
    };
    const repo = {
      claim: jest.fn(async () => 'row1'),
      update: jest.fn(async () => undefined),
      countCountedSince: jest.fn(async () => 0),
      hasInFlight: jest.fn(async () => false),
    };
    const prisma = {
      tradeTracker: { findUnique: jest.fn(async () => JPL) },
      instrument: { findFirst: jest.fn(async () => ({ tickSize: 5, lotSize: 1 })) },
    };
    const sessions = { withOwnerSession: jest.fn(async (_u: string, fn: any) => fn(session, 'user-feed')), reloginOwner: jest.fn() };
    const gate = { enabled: () => false, load: jest.fn(), decide: jest.fn() };
    const clock = { isOpen: jest.fn(() => true), minutesToClose: jest.fn(() => 300), tradingWindow: jest.fn(() => null) };
    const ex = new SentinelExitExecutor(repo as never, prisma as never, sessions as never, clock as never, jest.fn(async () => undefined), gate as never);
    return { ex, session, sessions, repo };
  }

  it('an EXIT_NOW on JPL-EQ in LIVE mode is SKIPPED: EXCHANGE_NOT_FNO with no broker session at all', async () => {
    const h = harness();
    await expect(h.ex.process(V, LIVE, NOW)).resolves.toEqual({ status: 'SKIPPED', reason: 'EXCHANGE_NOT_FNO' });
    expect(h.sessions.withOwnerSession).not.toHaveBeenCalled();
    expect(h.session.placeOrderClassified).not.toHaveBeenCalled();
  });

  it.each([['PRICE_TRIGGER' as const], ['MANUAL' as const]])('%s on JPL-EQ is refused the same way', async (trigger) => {
    const h = harness();
    await expect(h.ex.execute('row1', V, LIVE, NOW, trigger)).resolves.toEqual({ status: 'SKIPPED', reason: 'EXCHANGE_NOT_FNO' });
    expect(h.sessions.withOwnerSession).not.toHaveBeenCalled();
    expect(h.session.placeOrderClassified).not.toHaveBeenCalled();
  });
});

describe('equity observe-only — TriggerWatchService', () => {
  const ENV = { SENTINEL_TRIGGERS_ENABLED: 'true', AI_AUTO_EXIT_ENABLED: 'true', AI_AUTO_EXIT_USER_IDS: 'owner' };

  function harness(exitTrigger: unknown) {
    const hub = {
      price: jest.fn(() => ({ kind: 'fresh', price: { ref: { exchange: 'NSE', token: '11111', symbol: 'JPL-EQ' }, ltp: 512, at: NOW.getTime(), source: 'ws' } })),
      prices: jest.fn(), watch: jest.fn(async () => undefined), unwatch: jest.fn(async () => undefined),
      onPrice: jest.fn(() => () => undefined),
    };
    const source = { hubFor: jest.fn(() => hub), record: jest.fn() };
    const repo = {
      pendingProposals: jest.fn(async () => [
        { id: 'v1', userId: 'owner', trackerId: 'jpl', symbol: 'JPL-EQ', verdict: 'EXIT_ARMED', exitTrigger, createdAt: NOW },
      ]),
      trackerFor: jest.fn(async () => JPL),
      reject: jest.fn(async (..._a: any[]) => true),
      arm: jest.fn(async () => ({ id: 'trg1', superseded: [] as string[] })),
      claimFire: jest.fn(async () => true),
      expire: jest.fn(async (ids: string[]) => ids.length),
      loadArmed: jest.fn(async () => []),
      trackerExchanges: jest.fn(async () => new Map([['jpl', 'NSE']])),
      closedTrackerIds: jest.fn(async () => [] as string[]),
    };
    const executor = { execute: jest.fn() };
    const svc = new TriggerWatchService(
      repo as never, { claim: jest.fn() } as never, executor as never, { get: jest.fn(() => source) } as never, { isOpen: jest.fn(() => true) } as never,
    );
    return { svc, repo, hub, executor };
  }

  beforeEach(() => {
    jest.spyOn(global, 'setInterval').mockReturnValue({ unref: () => undefined } as never);
  });
  afterEach(() => jest.restoreAllMocks());

  it.each([
    ['PREMIUM (the stock price itself)', { v: 1, instrument: 'PREMIUM', op: 'BELOW', price: 500, watch: null }],
    ['UNDERLYING watched on NSE', { v: 1, instrument: 'UNDERLYING', op: 'BELOW', price: 500, watch: { exchange: 'NSE', token: '11111', symbol: 'JPL-EQ' }, seen: { price: 512, at: NOW.toISOString() } }],
  ])('an exitTrigger on JPL-EQ — %s — is REJECTED: EXCHANGE_NOT_FNO, never armed, never executed', async (_l, stored) => {
    const h = harness(stored);
    expect(h.svc.start(ENV)).toBe(true);
    await h.svc.pass(NOW);
    expect(h.repo.reject).toHaveBeenCalledTimes(1);
    expect(h.repo.reject.mock.calls[0][2]).toBe('EXCHANGE_NOT_FNO');
    expect(h.repo.arm).not.toHaveBeenCalled();
    expect(h.hub.watch).not.toHaveBeenCalled();
    expect(h.executor.execute).not.toHaveBeenCalled();
  });
});
