import { lateBand, lateEntryOf, lateRoom, targetsAhead, type LateRoomInput } from './late-entry';

const room = (over: Partial<LateRoomInput> = {}) =>
  lateRoom({
    kind: 'CE',
    side: 'BUY',
    ltp: 308.5,
    sl: 250,
    targets: [350, 400],
    spot: 10560,
    nearestSupport: 10500,
    nearestResistance: 10640,
    callWall: 10700,
    putWall: 10400,
    delta: 0.5,
    ...over,
  });

describe('late entries', () => {
  it('lateEntryOf: past the channel price on the trade side only, measured from the channel', () => {
    const s = { side: 'BUY' as const, entryLow: 270, entryHigh: 270, targets: [320, 350, 400] };
    expect(lateEntryOf(s, 308.5, { low: 261.9, high: 278.1 })).toEqual({ channelEntry: 270, ltp: 308.5, chasePct: 14.26, targetsPassed: [] });
    expect(lateEntryOf(s, 330, { low: 261.9, high: 278.1 })?.targetsPassed).toEqual([320]);
    // below the band for a BUY is "not reached / cheaper", never late
    expect(lateEntryOf(s, 250, { low: 261.9, high: 278.1 })).toBeNull();
    expect(lateEntryOf(s, 275, { low: 261.9, high: 278.1 })).toBeNull();
  });

  it('lateBand / targetsAhead follow the side', () => {
    expect(lateBand('BUY', 100, 3)).toEqual({ low: 100, high: 103 });
    expect(lateBand('SELL', 100, 3)).toEqual({ low: 97, high: 100 });
    expect(targetsAhead('BUY', 330, [320, 350, 400])).toEqual([350, 400]);
    expect(targetsAhead('SELL', 90, [95, 80])).toEqual([80]);
  });

  it('a long option: the nearest of resistance / call wall above spot, priced with delta, against the stop from here', () => {
    const r = room();
    expect(r).toMatchObject({ needs: 'UP', obstacle: { price: 10640, source: 'level book' }, roomPoints: 80, contractRoom: 40, risk: 58.5, nextTarget: 350, toNextTarget: 41.5, missing: [] });
    expect(r.roomToRisk).toBeCloseTo(0.68, 2);
    expect(r.roomPct).toBeCloseTo(0.76, 2);
  });

  it('a long PE needs the underlying DOWN: support / put wall below', () => {
    const r = room({ kind: 'PE', spot: 54250, nearestSupport: 54100, putWall: 54000, nearestResistance: 54400, callWall: 55000, delta: -0.4, ltp: 372.85, sl: 300, targets: [] });
    expect(r).toMatchObject({ needs: 'DOWN', obstacle: { price: 54100, source: 'level book' }, roomPoints: 150, contractRoom: 60, nextTarget: null });
  });

  it('a wall nearer than the level wins; a level behind the price is ignored', () => {
    expect(room({ nearestResistance: 10500, callWall: 10600 }).obstacle).toEqual({ price: 10600, source: 'call wall' });
  });

  it('missing inputs are named, never turned into "no room"', () => {
    const r = room({ nearestResistance: null, callWall: null, delta: null });
    expect(r.obstacle).toBeNull();
    expect(r.roomPoints).toBeNull();
    expect(r.roomToRisk).toBeNull();
    expect(r.missing).toEqual(['level book resistance', 'chain call wall']);
    expect(room({ delta: null }).missing).toEqual(['option delta']);
    expect(room({ spot: null }).missing).toEqual(['underlying price']);
  });

  it('cash / futures: the contract IS the underlying, so room is in its own points', () => {
    const r = room({ kind: 'EQ', ltp: 2490, sl: 2430, spot: 2490, nearestResistance: 2550, callWall: null, delta: null, targets: [3550] });
    expect(r).toMatchObject({ contractRoom: 60, risk: 60, roomToRisk: 1, missing: [] });
  });
});
