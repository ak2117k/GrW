import { FloorStateBoard, type FloorState } from './floor-state.board';

const s = (over: Partial<FloorState> = {}): FloorState => ({
  trackerId: 't1', userId: 'u1', symbol: 'NIFTY09NOV2624650CE', exchange: 'NFO', ownership: 'SENTINEL', side: 'LONG',
  entryPrice: 150, ltp: 186, floor: { basis: 'noise', armed: true, level: 180.74 }, at: 1_000, ...over,
});

describe('FloorStateBoard', () => {
  it('keeps the latest pass per tracker and hands out copies', () => {
    const b = new FloorStateBoard();
    b.publish(s());
    b.publish(s({ ltp: 190, at: 2_000 }));
    const got = b.get('t1')!;
    expect(got).toMatchObject({ ltp: 190, at: 2_000 });
    got.floor!.level = 1;
    expect(b.get('t1')!.floor!.level).toBe(180.74);
  });
  it('fresh() drops stale entries; forget() removes one', () => {
    const b = new FloorStateBoard();
    b.publish(s({ trackerId: 'old', at: 10 }));
    b.publish(s({ trackerId: 'new', at: 5_000 }));
    expect(b.fresh(1_000).map((x) => x.trackerId)).toEqual(['new']);
    b.forget('new');
    expect(b.get('new')).toBeNull();
  });
  it('publish never throws on garbage', () => {
    const b = new FloorStateBoard();
    expect(() => b.publish(null as never)).not.toThrow();
    expect(() => b.publish({} as never)).not.toThrow();
  });
});
