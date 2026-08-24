import { HealthDetailService } from './health-detail.service';

describe('HealthDetailService', () => {
  it('collects memory, jobs and slot pressure', async () => {
    const runs = { lastRunPerJob: jest.fn().mockResolvedValue([]) };
    const feed = {
      getSlotPressure: jest
        .fn()
        .mockReturnValue({ primaryHighWater: 30, primaryMax: 30, rejections: 4, saturated: true }),
    };
    const svc = new HealthDetailService(runs as never, feed as never);

    const out = await svc.check();

    expect(out.memory.available).toBe(true);
    expect(out.slots.available).toBe(true);
    if (out.slots.available) expect(out.slots.value.rejections).toBe(4);
    expect(out.jobs.available).toBe(true);
  });

  it('degrades the jobs signal alone when the query fails', async () => {
    const runs = { lastRunPerJob: jest.fn().mockRejectedValue(new Error('db down')) };
    const feed = { getSlotPressure: jest.fn().mockReturnValue({}) };
    const svc = new HealthDetailService(runs as never, feed as never);

    const out = await svc.check();

    expect(out.jobs.available).toBe(false);
    expect(out.memory.available).toBe(true); // unaffected
  });

  it('never rejects', async () => {
    const runs = { lastRunPerJob: jest.fn().mockRejectedValue(new Error('x')) };
    const feed = {
      getSlotPressure: jest.fn(() => {
        throw new Error('feed exploded');
      }),
    };
    const svc = new HealthDetailService(runs as never, feed as never);
    await expect(svc.check()).resolves.toBeDefined();
  });
});
