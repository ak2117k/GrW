// apps/api/src/modules/sentinel-executor/domain/guards.spec.ts
import { evaluateGuards, type GuardInput } from './guards';
import { parseAutoExitConfig } from './auto-exit.config';

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
