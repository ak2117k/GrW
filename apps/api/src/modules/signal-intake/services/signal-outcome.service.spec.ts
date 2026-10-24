import { SessionClock } from '../../market-hub/session-clock';
import { MARKET_HOLIDAYS } from '../../market-data/services/market-holidays.service';
import type { UnfilledSignal } from '../repositories/signal-intake.repository';
import { parseSignalIntakeConfig } from '../signal-intake.config';
import { buildVocabulary } from '../domain/vocabulary';
import { infoRefOf, SignalOutcomeService } from './signal-outcome.service';

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

describe('SignalOutcomeService — CHANNEL_INFO (INFO items on daily bars)', () => {
  const day = (d: string, close: number, high = close + 50, low = close - 50) => ({ day: d, high, low, close });
  // NIFTY daily: flat 22400 (range 100) then 10-23 closes 22250.
  const nifty = [...Array.from({ length: 15 }, (_, i) => day(`2026-10-${String(i + 1).padStart(2, '0')}`, 22400)), day('2026-10-22', 22400), day('2026-10-23', 22250)];
  const POST = new Date('2026-10-23T04:30:00Z'); // Fri 10:00 IST → base 10-22, judged 10-23
  const row = (id: string, items: unknown[], postedAt = POST) => ({ id, channelId: 'A', postedAt, items, extractor: 'rule' });
  const vocab = buildVocabulary(['RELIANCE-EQ']);
  const master = [
    { exch_seg: 'MCX', name: 'CRUDEOIL', instrumenttype: 'FUTCOM', symbol: 'CRUDEOIL19NOV26FUT', expiry: '19NOV2026', strike: '-1', token: 'c1' },
    { exch_seg: 'NSE', name: 'RELIANCE', instrumenttype: '', symbol: 'RELIANCE-EQ', expiry: '', strike: '-1', token: 'r1' },
  ];

  function makeInfo(rows: unknown[], daily: Record<string, unknown[]>) {
    const fills: Array<[string, unknown[], string | null]> = [];
    const repo = {
      unfilled: jest.fn(async () => []),
      fillOutcome: jest.fn(),
      unfilledInfos: jest.fn(async () => rows),
      fillInfoOutcome: jest.fn(async (id: string, o: unknown[], session: string | null) => void fills.push([id, o, session])),
    };
    const bars = { daily: jest.fn(async (_ex: string, token: string) => (daily[token] ?? []) as never) };
    const svc = new SignalOutcomeService(repo as never, { fetch: jest.fn() }, clock, parseSignalIntakeConfig({}), bars, { rows: async () => master }, { get: async () => vocab });
    return { svc, fills, bars };
  }

  it('judges each item on its underlying (index / MCX future / NSE cash), fills the row with the latest session', async () => {
    const items = [
      { underlying: 'NIFTY', bias: 'BEAR', levels: [22000], targetLevel: null, oi: null, condition: { driver: 'CRUDE', direction: 'UP' }, horizon: null },
      { underlying: 'CRUDEOIL', bias: 'BULL', levels: [110, 120], targetLevel: 110, oi: null, condition: null, horizon: null },
    ];
    const { svc, fills, bars } = makeInfo([row('i1', items)], { '99926000': nifty, c1: [day('2026-10-22', 6000), day('2026-10-23', 6100)] });
    expect(await svc.fillInfoOutcomes(new Date('2026-10-23T10:50:00Z'))).toEqual({ filled: 1, pending: 0 });
    expect(bars.daily.mock.calls.map((c) => [c[0], c[1]])).toEqual([['NSE', '99926000'], ['MCX', 'c1']]);
    expect(fills[0][0]).toBe('i1');
    expect(fills[0][2]).toBe('2026-10-23');
    expect(fills[0][1]).toEqual([
      expect.objectContaining({ status: 'RIGHT', session: '2026-10-23', ret: -150, levelHit: false }),
      expect.objectContaining({ status: 'RIGHT', session: '2026-10-23', ret: 100, levelHit: false }),
    ]);
  });

  it('a WEEKS item waits (row pending) until its 5th session; after 15 days it is filled as NO_DATA', async () => {
    const weeks = [{ underlying: 'NIFTY', bias: 'BULL', levels: [], targetLevel: null, oi: null, condition: null, horizon: 'WEEKS' }];
    const a = makeInfo([row('w1', weeks)], { '99926000': nifty });
    expect(await a.svc.fillInfoOutcomes(new Date('2026-10-23T10:50:00Z'))).toEqual({ filled: 0, pending: 1 });
    const b = makeInfo([row('w1', weeks, new Date('2026-10-05T04:30:00Z'))], { '99926000': nifty.slice(0, 6) });
    expect(await b.svc.fillInfoOutcomes(new Date('2026-10-23T10:50:00Z'))).toEqual({ filled: 1, pending: 0 });
    expect(b.fills[0][1]).toEqual([expect.objectContaining({ status: 'NO_DATA' })]);
  });

  it('infoRefOf: index, MCX nearest future, NSE cash; unknown → null', () => {
    expect(infoRefOf('NIFTY', vocab, null, POST)).toEqual({ exchange: 'NSE', token: '99926000' });
    expect(infoRefOf('CRUDEOIL', vocab, master, POST)).toEqual({ exchange: 'MCX', token: 'c1' });
    expect(infoRefOf('RELIANCE', vocab, master, POST)).toEqual({ exchange: 'NSE', token: 'r1' });
    expect(infoRefOf('RELIANCE', vocab, null, POST)).toBeNull();
  });

  it('inert without the daily-bars port (older wiring) or with SIGNAL_OUTCOMES=off', async () => {
    const repo = { unfilled: jest.fn(async () => []), fillOutcome: jest.fn(), unfilledInfos: jest.fn(async () => []), fillInfoOutcome: jest.fn() };
    expect(await new SignalOutcomeService(repo as never, { fetch: jest.fn() }, clock, parseSignalIntakeConfig({})).fillInfoOutcomes()).toEqual({ filled: 0, pending: 0 });
    expect(repo.unfilledInfos).not.toHaveBeenCalled();
  });
});
