import { createHash } from 'crypto';
import { ContextPacketService, type TickSnapshot } from './context-packet.service';
import { parseNewsEventsConfig } from '../../news-events/config';
import { fakeEvents, fakeNewsIndex } from '../../news-events/testing';
import type { EventsPeek, NewsPeek } from '../../news-events/types';

const T0 = new Date('2026-10-16T05:00:00.000Z'); // 10:30 IST, a Friday
const entry = (exchange: string, symbol: string) => ({
  exchange, userId: 'u1', trackerId: 't1', symbol, kind: 'POSITION' as const, ownership: 'SENTINEL' as const, watched: true, reason: '',
});
const baseTick: TickSnapshot = {
  segment: 'EQ_INTRADAY', side: 'LONG', structureSymbol: 'INFY', entryPrice: 100, qty: 100, ltp: 120, underlyingLtp: 120,
  underlyingLtpAt: null, underlyingLtpSource: 'market-data (underlying spot — live feed tick)', underlyingLtpReason: null,
  nearestSupport: null, nearestResistance: null, structureReason: null, structureAt: null, structureSource: 'signal-generator.analyze (15m level book)',
  holdingHigh: 125, holdingLow: 98, entryTime: new Date('2026-10-16T04:00:00Z'), expiry: null, volumeRatio: null, freshNewsCount: 1,
  factorValues: {}, factorsReason: null, oiWallNow: null, oiWallPrev: null, oiWallsAt: null, greenFloorArmedLatched: false,
} as TickSnapshot;
export const FIXTURES: Array<[string, ReturnType<typeof entry>, TickSnapshot]> = [
  ['cash INFY', entry('NSE', 'INFY'), baseTick],
  ['NFO NIFTY option', entry('NFO', 'NIFTY28OCT2625000CE'), { ...baseTick, segment: 'OPT', structureSymbol: 'NIFTY', expiry: '2026-10-28', underlyingLtp: 25100 } as TickSnapshot],
  ['MCX CRUDEOILM future', entry('MCX', 'CRUDEOILM19NOV26FUT'), { ...baseTick, segment: 'FUT', structureSymbol: 'CRUDEOILM', expiry: '2026-11-19', ltp: 5900, underlyingLtp: 5900 } as TickSnapshot],
  ['unresolved underlying', entry('NFO', 'XYZ28OCT26100CE'), { ...baseTick, segment: 'OPT', structureSymbol: null } as TickSnapshot],
];
export const legacyRecentFor = () =>
  jest.fn().mockResolvedValue({ value: [{ title: 'legacy headline' }], source: 'news-aggregator.service (published within 6h)', at: '2026-10-16T04:00:00.000Z' });
export const sha = (x: unknown) => createHash('sha256').update(JSON.stringify(x), 'utf8').digest('hex');

beforeEach(() => jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] }).setSystemTime(T0));
afterEach(() => jest.useRealTimers());

/** sha256(JSON) of each fixture's packet on main @ 7b976b3 — recorded in Task D1 Step 1, never re-recorded. */
const MAIN_PACKET_SHA256: Record<string, string> = {
  'cash INFY': 'f3e1f449acc86e931d3a3a7214fb7bdb2c1d77f5f0a563d3099ffef9bca87853',
  'NFO NIFTY option': '3872b33cebb0355efe92000997bd71c88db0a3750b75d643814321f7a0063e12',
  'MCX CRUDEOILM future': 'b50f341524948d72b1bd9729e3216977af5f9c93381589cc8d7f5e4d747a1719',
  'unresolved underlying': '6baf97b8b7cd611e7e4a519ba4aa7d9d8bcdf7dc9924586fb6549e3d98e1bd83',
};

it('FLAG OFF IS MAIN, BYTE FOR BYTE (hashes recorded on main @ 7b976b3)', async () => {
  const out: Record<string, string> = {};
  for (const [name, e, t] of FIXTURES) {
    const svc = new ContextPacketService({ recentForTracker: jest.fn().mockResolvedValue([]) } as never, { levelsFor: jest.fn().mockResolvedValue(null) } as never, { recentFor: legacyRecentFor() } as never);
    out[name] = sha(await svc.build(e as never, t));
  }
  expect(out).toEqual(MAIN_PACKET_SHA256);
});

const OK_NEWS: NewsPeek = {
  status: 'ok',
  headlines: [
    { title: 'Infosys wins $1.5bn deal', source: 'ET', sentiment: 'bullish', publishedAt: '2026-10-16T04:50:00.000Z', layer: 'instrument', key: 'INFY', ageMin: 10 },
    { title: 'IT stocks drag Nifty', source: 'LiveMint', sentiment: 'bearish', publishedAt: '2026-10-16T03:00:00.000Z', layer: 'sector', key: 'NIFTY IT', ageMin: 120 },
  ],
  newestAt: '2026-10-16T04:50:00.000Z', freshCount: 1, fresh: [{ id: 'a1', title: 'Infosys wins $1.5bn deal' }],
  asOf: { lastIngestAt: '2026-10-16T04:55:00.000Z', downSources: [], stale: false },
};
const OK_EVENTS: EventsPeek = {
  status: 'ok',
  events: [{ id: 'fomc:US:x', kind: 'fomc', scope: 'market', title: 'FOMC rate decision', atIst: '2026-10-29 00:30 IST', minutesAway: 42, impact: 'high', source: 'config/market-events.json', allDay: false }],
  minutesToNextHighImpact: 42, noHighImpactReason: null, notes: [], fetchedAt: '2026-10-16T02:45:00.000Z',
};
function make(mode: string | undefined, news: NewsPeek | (() => never) = OK_NEWS, events: EventsPeek | (() => never) = OK_EVENTS) {
  const recentFor = legacyRecentFor();
  const index = fakeNewsIndex(() => (typeof news === 'function' ? news() : news));
  const cal = fakeEvents(() => (typeof events === 'function' ? events() : events));
  const svc = new ContextPacketService(
    { recentForTracker: jest.fn().mockResolvedValue([]) } as never, { levelsFor: jest.fn().mockResolvedValue(null) } as never, { recentFor } as never,
    undefined, mode === undefined ? undefined : parseNewsEventsConfig({ NEWS_EVENTS_V2_ENABLED: mode }), index as never, cal as never,
  );
  return { svc, recentFor, index, cal };
}
const boom = (): never => {
  throw new Error('must not be called');
};

describe('news & events v2 in the live packet', () => {
  it.each(['false', 'observe', 'ture'])('NEWS_EVENTS_V2_ENABLED=%s builds exactly the flag-off packet (main hashes) and never peeks', async (mode) => {
    for (const [name, e, t] of FIXTURES) {
      const m = make(mode, boom, boom);
      expect(sha(await m.svc.build(e as never, t))).toBe(MAIN_PACKET_SHA256[name]);
      expect(m.index.peek).not.toHaveBeenCalled();
      expect(m.cal.peek).not.toHaveBeenCalled();
    }
  });

  it('true: layered news + events replace the legacy blocks; the legacy news shim is never called; key order', async () => {
    const m = make('true');
    const p = await m.svc.build(FIXTURES[0][1] as never, FIXTURES[0][2]);
    expect(m.recentFor).not.toHaveBeenCalled();
    expect(Object.keys(p)).toEqual(['position', 'money', 'thesis', 'structure', 'flow', 'macro', 'news', 'events', 'session', 'trigger', 'memory']);
    expect(Object.keys(p.news)).toEqual(['headlines', 'freshCount', 'asOf']);
    expect(p.news.headlines).toEqual({ available: true, value: OK_NEWS.status === 'ok' ? OK_NEWS.headlines : [], source: 'news-index (own → sector → index → market, published within 6h)', at: '2026-10-16T04:50:00.000Z' });
    expect(p.news.freshCount).toMatchObject({ available: true, value: 1 });
    expect(p.news.asOf).toMatchObject({ available: true, value: { lastIngestAt: '2026-10-16T04:55:00.000Z', downSources: [], stale: false } });
    expect(p.events?.upcoming).toMatchObject({ available: true, value: [{ kind: 'fomc', scope: 'market', title: 'FOMC rate decision', atIst: '2026-10-29 00:30 IST', minutesAway: 42, impact: 'high', source: 'config/market-events.json' }] });
    expect((p.events?.upcoming as { value: Array<Record<string, unknown>> }).value[0]).not.toHaveProperty('id');
    expect((p.events?.upcoming as { value: Array<Record<string, unknown>> }).value[0]).not.toHaveProperty('allDay');
    expect(p.events?.minutesToNextHighImpact).toMatchObject({ available: true, value: 42 });
  });

  it('true: the peeks get the resolved position (index option, MCX mini → benchmark)', async () => {
    const m = make('true');
    await m.svc.build(FIXTURES[1][1] as never, FIXTURES[1][2]);
    expect(m.index.peek.mock.calls[0][0]).toEqual({ kind: 'INDEX', underlying: 'NIFTY', key: 'NIFTY', exchange: 'NFO', expiry: '2026-10-28' });
    expect(m.index.peek.mock.calls[0][1]).toEqual(T0);
    const c = make('true');
    await c.svc.build(FIXTURES[2][1] as never, FIXTURES[2][2]);
    expect(c.cal.peek.mock.calls[0][0]).toMatchObject({ kind: 'COMMODITY', key: 'CRUDEOIL', expiry: '2026-11-19' });
  });

  it('true: an MCX underlying with no mapping → news absent WITH the reason (never 0), events still computed', async () => {
    const m = make('true');
    const p = await m.svc.build(entry('MCX', 'STEELREBAR19NOV26FUT') as never, { ...baseTick, segment: 'FUT', structureSymbol: 'STEELREBAR', expiry: '2026-11-19' } as TickSnapshot);
    for (const b of [p.news.headlines, p.news.freshCount, p.news.asOf]) expect(b).toEqual({ available: false, reason: expect.stringMatching(/STEELREBAR.*NOT a finding/) });
    expect(m.index.peek).not.toHaveBeenCalled();
    expect(m.cal.peek.mock.calls[0][0]).toMatchObject({ kind: 'COMMODITY', key: 'STEELREBAR' });
  });

  it('true: an unresolved underlying → all five blocks absent, nothing peeked', async () => {
    const m = make('true');
    const p = await m.svc.build(FIXTURES[3][1] as never, FIXTURES[3][2]);
    for (const b of [p.news.headlines, p.news.freshCount, p.news.asOf, p.events?.upcoming, p.events?.minutesToNextHighImpact]) {
      expect(b).toEqual({ available: false, reason: expect.stringMatching(/could not be resolved/) });
    }
    expect(m.index.peek).not.toHaveBeenCalled();
    expect(m.cal.peek).not.toHaveBeenCalled();
  });

  it('true: a warming index is "cannot see" on every news block — freshCount is NOT 0', async () => {
    const m = make('true', { status: 'warming', reason: 'the news index is still loading after a restart — headlines exist that this process cannot see yet; this is NOT a finding that nothing was published' });
    const p = await m.svc.build(FIXTURES[0][1] as never, FIXTURES[0][2]);
    expect(p.news.freshCount).toEqual({ available: false, reason: expect.stringMatching(/still loading/) });
    expect(p.news.headlines).toEqual({ available: false, reason: expect.stringMatching(/still loading/) });
    expect(p.news.asOf).toEqual({ available: false, reason: expect.stringMatching(/still loading/) });
  });

  it('true: a throwing peek becomes an absence naming the failed read', async () => {
    const m = make('true', boom, boom);
    const p = await m.svc.build(FIXTURES[0][1] as never, FIXTURES[0][2]);
    expect(p.news.headlines).toEqual({ available: false, reason: 'news index could not be read: must not be called' });
    expect(p.events?.upcoming).toEqual({ available: false, reason: 'events calendar could not be read: must not be called' });
  });

  it('true with no index/calendar wired: stated absences, not zeros', async () => {
    const svc = new ContextPacketService(
      { recentForTracker: jest.fn().mockResolvedValue([]) } as never, { levelsFor: jest.fn().mockResolvedValue(null) } as never, { recentFor: legacyRecentFor() } as never,
      undefined, parseNewsEventsConfig({ NEWS_EVENTS_V2_ENABLED: 'true' }),
    );
    const p = await svc.build(FIXTURES[0][1] as never, FIXTURES[0][2]);
    expect(p.news.freshCount).toEqual({ available: false, reason: expect.stringMatching(/not wired/) });
    expect(p.events?.upcoming).toEqual({ available: false, reason: expect.stringMatching(/not wired/) });
  });

  it('shadowNewsEvents: the would-be blocks in observe only', () => {
    const o = make('observe');
    expect(o.svc.shadowNewsEvents(FIXTURES[0][1] as never, FIXTURES[0][2], T0)).toMatchObject({ news: { freshCount: { value: 1 } }, events: { minutesToNextHighImpact: { value: 42 } } });
    for (const mode of [undefined, 'false', 'true']) expect(make(mode).svc.shadowNewsEvents(FIXTURES[0][1] as never, FIXTURES[0][2], T0)).toBeNull();
  });

  it('shadowNewsEvents never throws, even when both peeks do', () => {
    const o = make('observe', boom, boom);
    expect(o.svc.shadowNewsEvents(FIXTURES[0][1] as never, FIXTURES[0][2], T0)).toMatchObject({ news: { headlines: { available: false } }, events: { upcoming: { available: false } } });
  });
});
