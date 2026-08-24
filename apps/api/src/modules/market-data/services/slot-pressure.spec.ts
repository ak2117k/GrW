import { SlotPressureTracker } from './slot-pressure';

describe('SlotPressureTracker', () => {
  it('starts with no pressure recorded', () => {
    expect(new SlotPressureTracker(30).snapshot()).toEqual({
      primaryHighWater: 0,
      primaryMax: 30,
      rejections: 0,
      saturated: false,
    });
  });

  it('keeps the high-water mark, not the latest reading', () => {
    const t = new SlotPressureTracker(30);
    t.observe(29);
    t.observe(4);
    expect(t.snapshot().primaryHighWater).toBe(29);
  });

  it('reports saturated once the cap is reached', () => {
    const t = new SlotPressureTracker(30);
    t.observe(30);
    expect(t.snapshot().saturated).toBe(true);
  });

  it('counts rejections', () => {
    const t = new SlotPressureTracker(30);
    t.reject();
    t.reject();
    expect(t.snapshot().rejections).toBe(2);
  });
});
