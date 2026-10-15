// apps/api/src/modules/sentinel-executor/domain/guards.spec.ts
import { evaluateGuards, type GuardInput } from './guards';
import { parseAutoExitConfig } from './auto-exit.config';
import { SessionClock } from '../../market-hub/session-clock';
import { MARKET_HOLIDAYS } from '../../market-data/services/market-holidays.service';

const NOW = new Date('2026-10-12T10:00:00Z');
function input(over: Partial<GuardInput> = {}): GuardInput {
  return {
    config: parseAutoExitConfig({ AI_AUTO_EXIT_ENABLED: 'true', AI_AUTO_EXIT_USER_IDS: 'owner' }),
    now: NOW,
    verdict: { userId: 'owner', createdAt: new Date(NOW.getTime() - 10_000) },
    tracker: { userId: 'owner', status: 'OPEN', kind: 'POSITION', exchange: 'MCX' },
    isOpen: () => true,
    countedToday: 0,
    inFlight: false,
    ...over,
  };
}

describe('evaluateGuards', () => {
  it('all clear', () => expect(evaluateGuards(input())).toEqual({ ok: true }));

  it.each<[string, Partial<GuardInput>]>([
    ['DISABLED', { config: parseAutoExitConfig({ AI_AUTO_EXIT_USER_IDS: 'owner' }) }],
    ['NOT_ALLOWED_USER', { verdict: { userId: 'other', createdAt: NOW } }],
    ['STALE_VERDICT', { verdict: { userId: 'owner', createdAt: new Date(NOW.getTime() - 91_000) } }],
    ['TRACKER_MISSING', { tracker: null }],
    ['TRACKER_USER_MISMATCH', { tracker: { userId: 'other', status: 'OPEN', kind: 'POSITION', exchange: 'MCX' } }],
    ['TRACKER_CLOSED', { tracker: { userId: 'owner', status: 'CLOSED', kind: 'POSITION', exchange: 'MCX' } }],
    ['NOT_POSITION', { tracker: { userId: 'owner', status: 'OPEN', kind: 'HOLDING', exchange: 'NSE' } }],
    ['EXCHANGE_NOT_FNO', { tracker: { userId: 'owner', status: 'OPEN', kind: 'POSITION', exchange: 'NSE' } }],
    ['EXCHANGE_CLOSED', { isOpen: () => false }],
    ['EXIT_IN_FLIGHT', { inFlight: true }],
    ['DAILY_CAP', { countedToday: 5 }],
  ])('%s', (reason, over) => {
    expect(evaluateGuards(input(over))).toEqual({ ok: false, reason });
  });

  it('a verdict exactly at the age limit still passes', () => {
    const at = new Date(NOW.getTime() - 90_000);
    expect(evaluateGuards(input({ verdict: { userId: 'owner', createdAt: at } }))).toEqual({ ok: true });
  });

  it('exchange match is case-insensitive and asks the clock with the tracker exchange', () => {
    const isOpen = jest.fn().mockReturnValue(true);
    evaluateGuards(input({ isOpen, tracker: { userId: 'owner', status: 'OPEN', kind: 'POSITION', exchange: 'nfo' } }));
    expect(isOpen).toHaveBeenCalledWith('NFO', NOW);
  });

  it('cap 0 skips everything', () => {
    const config = parseAutoExitConfig({ AI_AUTO_EXIT_ENABLED: 'true', AI_AUTO_EXIT_USER_IDS: 'owner', AI_AUTO_EXIT_DAILY_CAP: '0' });
    expect(evaluateGuards(input({ config }))).toEqual({ ok: false, reason: 'DAILY_CAP' });
  });

  it('a verdict from the future (clock skew) is not stale', () => {
    expect(evaluateGuards(input({ verdict: { userId: 'owner', createdAt: new Date(NOW.getTime() + 5_000) } }))).toEqual({ ok: true });
  });
});

/**
 * The executor's EXCHANGE_CLOSED guard asks the same SessionClock the module
 * builds (MARKET_HOLIDAYS + MCX's own calendar). An NSE holiday is, by default,
 * an MCX evening session — an MCX exit must be allowed then, and refused on a
 * full MCX holiday.
 */
describe('evaluateGuards — MCX holidays through the real SessionClock', () => {
  const DUSSEHRA_EVENING = new Date('2026-10-20T19:00:00+05:30');
  const at = (clock: { isOpen: (e: string, a: Date) => boolean }, exchange: string) =>
    evaluateGuards(
      input({
        now: DUSSEHRA_EVENING,
        verdict: { userId: 'owner', createdAt: new Date(DUSSEHRA_EVENING.getTime() - 10_000) },
        tracker: { userId: 'owner', status: 'OPEN', kind: 'POSITION', exchange },
        isOpen: (e, a) => clock.isOpen(e, a),
      }),
    );

  it('allows an MCX exit in the evening session of an NSE holiday; NFO stays closed', () => {
    const clock = new SessionClock({ holidays: MARKET_HOLIDAYS });
    expect(at(clock, 'MCX')).toEqual({ ok: true });
    expect(at(clock, 'NFO')).toEqual({ ok: false, reason: 'EXCHANGE_CLOSED' });
  });

  it('refuses an MCX exit on a full MCX holiday', () => {
    const clock = new SessionClock({
      holidays: MARKET_HOLIDAYS,
      mcxHolidays: { 2026: [{ date: '2026-10-20', name: 'test full close', session: 'CLOSED' }] },
    });
    expect(at(clock, 'MCX')).toEqual({ ok: false, reason: 'EXCHANGE_CLOSED' });
  });
});

describe('PRICE_TRIGGER takes every AI guard (ruling R13)', () => {
  const t = { trigger: 'PRICE_TRIGGER' as const };
  it.each([
    ['disabled', { config: { ...input().config, enabled: false } }, 'DISABLED'],
    ['not allow-listed', { verdict: { ...input().verdict, userId: 'stranger' } }, 'NOT_ALLOWED_USER'],
    ['fired 91 s ago', { verdict: { ...input().verdict, createdAt: new Date(input().now.getTime() - 91_000) } }, 'STALE_VERDICT'],
    ['cap reached', { countedToday: input().config.dailyCap }, 'DAILY_CAP'],
  ])('%s → %s', (_l, over, reason) => {
    expect(evaluateGuards({ ...input(), ...over, ...t } as never)).toEqual({ ok: false, reason });
  });
});
