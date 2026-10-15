// apps/api/src/modules/sentinel-executor/domain/trigger-book.spec.ts
import { EMPTY_CONFIRM } from './confirmation';
import { TriggerBook, type ArmedTrigger } from './trigger-book';

const T0 = 1_760_000_000_000;
const KEY = 'MCX:472789';
const trig = (over: Partial<ArmedTrigger> = {}): ArmedTrigger => ({
  id: 'trg1', userId: 'owner', trackerId: 't1', symbol: 'CRUDEOIL19NOV268950CE', verdictId: 'v1',
  instrument: 'UNDERLYING', op: 'BELOW', price: 8930,
  watch: { key: KEY, exchange: 'MCX', token: '472789', symbol: 'CRUDEOIL19NOV26FUT' },
  trackerExchange: 'MCX', armedAt: T0, confirm: EMPTY_CONFIRM, ...over,
});
const tick = (ltp: number, at: number, source = 'ws', key = KEY) => ({ key, exchange: 'MCX', ltp, at, source });

function book(open = true) {
  const isOpen = jest.fn(() => open);
  return { b: new TriggerBook({ ticks: 2, ms: 1000 }, isOpen), isOpen };
}

describe('TriggerBook', () => {
  it('a confirmed cross fires ONCE and removes the trigger before returning (R7 layer 1)', () => {
    const { b } = book();
    b.add(trig());
    expect(b.onTick(tick(8920, T0), T0)).toEqual([]);
    const fires = b.onTick(tick(8919, T0 + 1100), T0 + 1100);
    expect(fires).toHaveLength(1);
    expect(fires[0].tick).toEqual({ price: 8919, at: T0 + 1100, count: 2, heldMs: 1100 });
    expect(b.size()).toBe(0);
    expect(b.onTick(tick(8918, T0 + 1200), T0 + 1200)).toEqual([]);   // the concurrent next tick
  });

  it('a tick for an unwatched key does nothing (and touches no state)', () => {
    const { b, isOpen } = book();
    b.add(trig());
    expect(b.onTick(tick(1, T0, 'ws', 'NSE:26000'), T0)).toEqual([]);
    expect(isOpen).not.toHaveBeenCalled();
  });

  it.each([
    ['a db-sourced price', tick(8920, T0 + 1100, 'db')],
    ['a zero price', tick(0, T0 + 1100)],
    ['a NaN price', tick(Number.NaN, T0 + 1100)],
    ['a tick received 6 s ago', tick(8920, T0 + 1100 - 6000)],
    ['a tick stamped 6 s in the future', tick(8920, T0 + 1100 + 6000)],
  ])('bad ticks are ignored and leave confirmation untouched: %s', (_l, bad) => {
    const { b } = book();
    b.add(trig());
    b.onTick(tick(8920, T0), T0);
    expect(b.onTick(bad, T0 + 1100)).toEqual([]);
    expect(b.get('trg1')?.confirm.count).toBe(1);
  });

  it('ticks while the exchange is closed never fire', () => {
    const { b } = book(false);
    b.add(trig());
    b.onTick(tick(8920, T0), T0);
    expect(b.onTick(tick(8920, T0 + 2000), T0 + 2000)).toEqual([]);
    expect(b.size()).toBe(1);
  });

  it('a critical-lane quote counts like a live tick (slot exhaustion still fires, R9)', () => {
    const { b } = book();
    b.add(trig());
    b.onTick(tick(8920, T0, 'quote'), T0);
    expect(b.onTick(tick(8920, T0 + 2000, 'quote'), T0 + 2000)).toHaveLength(1);
  });

  it('one armed trigger per tracker: add replaces and returns the old one', () => {
    const { b } = book();
    b.add(trig());
    const replaced = b.add(trig({ id: 'trg2', price: 8940 }));
    expect(replaced?.id).toBe('trg1');
    expect(b.byTracker('t1')?.id).toBe('trg2');
    expect(b.size()).toBe(1);
  });

  it('remove drops the key when its last trigger goes; lastSeen tracks accepted ticks only', () => {
    const { b } = book();
    b.add(trig());
    b.onTick(tick(8950, T0), T0);
    expect(b.lastSeen(KEY)).toBe(T0);
    b.remove('trg1');
    expect(b.hasKey(KEY)).toBe(false);
    expect(b.lastSeen(KEY)).toBeUndefined();
  });

  it('two trackers on one key are judged independently', () => {
    const { b } = book();
    b.add(trig());
    b.add(trig({ id: 'trg2', trackerId: 't2', price: 8900 }));
    b.onTick(tick(8920, T0), T0);
    const fires = b.onTick(tick(8920, T0 + 1000), T0 + 1000);
    expect(fires.map((f) => f.trigger.id)).toEqual(['trg1']);
    expect(b.byTracker('t2')?.id).toBe('trg2');
  });
});
