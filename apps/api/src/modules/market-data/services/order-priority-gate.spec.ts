import { OrderPriorityGate } from './order-priority-gate';

describe('OrderPriorityGate (order calls before data reads)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const settled = async (p: Promise<void>) => {
    let done = false;
    void p.then(() => (done = true));
    await Promise.resolve();
    await Promise.resolve();
    return done;
  };

  it('a read goes ahead at once when nothing holds the gate', async () => {
    const g = new OrderPriorityGate(25_000);
    expect(await settled(g.wait())).toBe(true);
  });

  it('a read waits while an order holds the gate and goes the moment it is released', async () => {
    const g = new OrderPriorityGate(25_000);
    const release = g.begin();
    const w = g.wait();
    expect(await settled(w)).toBe(false);
    release();
    expect(await settled(w)).toBe(true);
    expect(g.held()).toBe(false);
  });

  it('waits for every overlapping hold; release is idempotent', async () => {
    const g = new OrderPriorityGate(25_000);
    const a = g.begin();
    const b = g.begin();
    const w = g.wait();
    a();
    a();
    expect(await settled(w)).toBe(false);
    b();
    expect(await settled(w)).toBe(true);
  });

  it('a hold that is never released expires after the max hold (never a stall)', async () => {
    const g = new OrderPriorityGate(25_000);
    g.begin();
    const w = g.wait();
    await jest.advanceTimersByTimeAsync(24_999);
    expect(await settled(w)).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(await settled(w)).toBe(true);
    expect(g.held()).toBe(false);
  });

  it('a waiting read goes after the max hold even while new holds keep arriving', async () => {
    const g = new OrderPriorityGate(25_000);
    g.begin();
    const w = g.wait();
    await jest.advanceTimersByTimeAsync(20_000);
    g.begin(); // a second order before the first expires
    await jest.advanceTimersByTimeAsync(5_000);
    expect(await settled(w)).toBe(true);
  });
});
