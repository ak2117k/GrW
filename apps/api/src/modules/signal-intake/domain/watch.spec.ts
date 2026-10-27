import { makeSentinelClock } from '../../trade-sentinel/overnight/overnight-calendar';
import { watchCrossed, watchesFromItems, watchExpiry, watchSignal } from './watch';

const classOf = (u: string) => (({ RADICO: 'STOCK', BSE: 'STOCK', NIFTY: 'INDEX', CRUDEOIL: 'COMMODITY' }) as Record<string, 'STOCK' | 'INDEX' | 'COMMODITY'>)[u];
const item = (over: Record<string, unknown>) => ({ underlying: 'RADICO', bias: 'BULL', levels: [4330], targetLevel: null, oi: null, condition: null, horizon: null, kind: 'WATCH', ...over });

describe('watched breakout levels', () => {
  it('a WATCH item with a level and a direction becomes a watch; the outermost level is the breakout', () => {
    expect(watchesFromItems([item({}), item({ underlying: 'BSE', levels: [3289, 3476.2, 3500] }), item({ underlying: 'NIFTY', bias: 'BEAR', levels: [22800, 22650] })], classOf)).toEqual([
      { itemIndex: 0, underlying: 'RADICO', instrumentKind: 'EQ', side: 'BUY', level: 4330 },
      { itemIndex: 1, underlying: 'BSE', instrumentKind: 'EQ', side: 'BUY', level: 3500 },
      { itemIndex: 2, underlying: 'NIFTY', instrumentKind: 'FUT', side: 'SELL', level: 22650 },
    ]);
  });

  it('no level, no direction, not a WATCH, or an unknown name: no watch', () => {
    expect(watchesFromItems([item({ levels: [] }), item({ bias: 'NEUTRAL' }), item({ kind: 'VIEW' }), item({ underlying: 'ZZZ' })], classOf)).toEqual([]);
    expect(watchesFromItems('not items', classOf)).toEqual([]);
  });

  it('crossed: at or past the level in the watch direction only', () => {
    expect(watchCrossed('BUY', 4330, 4330)).toBe(true);
    expect(watchCrossed('BUY', 4330, 4329.9)).toBe(false);
    expect(watchCrossed('SELL', 22650, 22640)).toBe(true);
    expect(watchCrossed('SELL', 22650, 22700)).toBe(false);
    expect(watchCrossed('BUY', 4330, null)).toBe(false);
  });

  it('lives for the rest of this session plus the next one (holiday-aware)', () => {
    const clock = makeSentinelClock();
    // Tue 27 Oct 11:52 IST, NSE open → expires at Wed 28 Oct 15:30 IST.
    expect(watchExpiry(clock, 'NSE', new Date('2026-10-27T06:22:00Z'))?.toISOString()).toBe('2026-10-28T10:00:00.000Z');
    // Fri after the close → Monday's session, then Tuesday's close.
    expect(watchExpiry(clock, 'NSE', new Date('2026-10-30T12:00:00Z'))?.toISOString()).toBe('2026-11-03T10:00:00.000Z');
  });

  it('the fired signal is an ABOVE entry at the level, tagged WATCH, with the post behind it', () => {
    const s = watchSignal(
      { messageId: 'm1', itemIndex: 0, channelId: 'c1', underlying: 'RADICO', instrumentKind: 'EQ', side: 'BUY', level: 4330 },
      { at: new Date('2026-10-27T07:00:00Z'), ltp: 4336, sessionDate: '2026-10-27', postText: 'Radico breakout above 4330' },
    );
    expect(s).toMatchObject({ messageId: 'm1:watch:0', parser: 'watch', underlying: 'RADICO', instrumentKind: 'EQ', side: 'BUY', direction: 'BULL', entryType: 'ABOVE', entryLow: 4330, sl: 4286.7, targets: [], tags: ['WATCH'] });
    expect(s.rawText).toMatch(/^\[watch fired: RADICO crossed above 4330, LTP 4336\]\nRadico breakout above 4330/);
  });
});
