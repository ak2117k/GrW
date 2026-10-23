import { SessionClock } from '../../market-hub/session-clock';
import { MARKET_HOLIDAYS } from '../../market-data/services/market-holidays.service';
import type { UnfilledSignal } from '../repositories/signal-intake.repository';
import { parseSignalIntakeConfig } from '../signal-intake.config';
import { SignalOutcomeService } from './signal-outcome.service';

const clock = new SessionClock({ holidays: MARKET_HOLIDAYS });
const POSTED = new Date('2026-10-23T04:30:00Z'); // Fri 10:00 IST
const NOW = new Date('2026-10-23T10:50:00Z'); // Fri 16:20 IST

const sig = (over: Partial<UnfilledSignal> = {}): UnfilledSignal => ({
  id: 's1', channelId: 'A', receivedAt: POSTED, sessionDate: '2026-10-23', underlying: 'NIFTY', instrumentKind: 'CE', exchange: 'NFO', token: '111',
  side: 'BUY', entryType: 'ABOVE', entryLow: 120, entryHigh: 120, sl: 100, targets: [140, 160], horizon: 'INTRADAY', ...over,
});

function make(rows: UnfilledSignal[], bars: Array<{ ts: number; high: number; low: number; close: number }>) {
  const fills: Array<[string, Record<string, unknown>]> = [];
  const repo = { unfilled: jest.fn(async () => rows), fillOutcome: jest.fn(async (id: string, o: Record<string, unknown>) => void fills.push([id, o])) };
  const feed = { fetch: jest.fn(async () => bars) };
  const svc = new SignalOutcomeService(repo as never, feed, clock, parseSignalIntakeConfig({}));
  return { svc, fills, feed };
}

const at = (hhmm: string) => new Date(`2026-10-23T${hhmm}:00+05:30`).getTime();

describe('SignalOutcomeService', () => {
  it('intraday: replays the session after the post; T1 before SL → TARGET1 on that session', async () => {
    const { svc, fills, feed } = make([sig()], [
      { ts: at('09:55'), low: 90, high: 150, close: 120 }, // before the post: ignored
      { ts: at('10:05'), low: 118, high: 125, close: 124 },
      { ts: at('10:30'), low: 124, high: 141, close: 140 },
    ]);
    expect(await svc.fillOutcomes(NOW)).toEqual({ filled: 1, pending: 0 });
    expect(feed.fetch).toHaveBeenCalledWith('NFO', '111', POSTED, new Date('2026-10-23T10:00:00Z'));
    expect(fills[0]).toEqual(['s1', expect.objectContaining({ status: 'TARGET1', session: '2026-10-23', entryAt: new Date(at('10:05')) })]);
  });

  it('BTST waits for 3 sessions; a missing token is UNRESOLVED (scored null)', async () => {
    const { svc, fills } = make([sig({ id: 'b', horizon: 'BTST' }), sig({ id: 'u', token: null })], []);
    expect(await svc.fillOutcomes(NOW)).toEqual({ filled: 1, pending: 1 });
    expect(fills).toEqual([['u', expect.objectContaining({ status: 'UNRESOLVED', session: '2026-10-23' })]]);
  });

  it('no bars → NO_DATA; SIGNAL_OUTCOMES=off → nothing', async () => {
    const a = make([sig()], []);
    await a.svc.fillOutcomes(NOW);
    expect(a.fills[0][1]).toMatchObject({ status: 'NO_DATA' });
    const off = new SignalOutcomeService({ unfilled: jest.fn(), fillOutcome: jest.fn() } as never, { fetch: jest.fn() }, clock, parseSignalIntakeConfig({ SIGNAL_OUTCOMES: 'off' }));
    expect(await off.fillOutcomes(NOW)).toEqual({ filled: 0, pending: 0 });
  });
});
