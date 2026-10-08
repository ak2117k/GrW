import { HealthDetailService } from './health-detail.service';

function makePrisma(create: jest.Mock = jest.fn().mockResolvedValue({ id: 'r1' })) {
  return { clientFeedReport: { create } };
}

describe('HealthDetailService', () => {
  it('collects memory, jobs and slot pressure', async () => {
    const runs = { lastRunPerJob: jest.fn().mockResolvedValue([]) };
    const feed = {
      getSlotPressure: jest
        .fn()
        .mockReturnValue({ primaryHighWater: 30, primaryMax: 30, rejections: 4, saturated: true }),
    };
    const svc = new HealthDetailService(makePrisma() as never, runs as never, feed as never);

    const out = await svc.check();

    expect(out.memory.available).toBe(true);
    expect(out.slots.available).toBe(true);
    if (out.slots.available) expect(out.slots.value.rejections).toBe(4);
    expect(out.jobs.available).toBe(true);
  });

  it('lists the hub candle fix-up as an expected job even before it has ever run', async () => {
    const runs = { lastRunPerJob: jest.fn().mockResolvedValue([]) };
    const svc = new HealthDetailService(makePrisma() as never, runs as never, null);

    const out = await svc.check();

    expect(out.jobs.available).toBe(true);
    if (out.jobs.available) expect(out.jobs.value['hub-candle-fixup']).toMatchObject({ at: null, outcome: null });
  });

  it('degrades the jobs signal alone when the query fails', async () => {
    const runs = { lastRunPerJob: jest.fn().mockRejectedValue(new Error('db down')) };
    const feed = { getSlotPressure: jest.fn().mockReturnValue({}) };
    const svc = new HealthDetailService(makePrisma() as never, runs as never, feed as never);

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
    const svc = new HealthDetailService(makePrisma() as never, runs as never, feed as never);
    await expect(svc.check()).resolves.toBeDefined();
  });

  describe('recordClientReport', () => {
    const report = {
      health: 'stale' as const,
      tickSocketUp: true,
      secondsSinceLastTick: 42,
      transport: 'websocket',
      subscribedTokens: 12,
      namespaces: { '/ws': true, '/ws/telegram': true },
    };

    it('stores the report', async () => {
      const create = jest.fn().mockResolvedValue({ id: 'r1' });
      const svc = new HealthDetailService(
        makePrisma(create) as never,
        { lastRunPerJob: jest.fn() } as never,
        null as never,
      );

      await expect(svc.recordClientReport('user-1', report)).resolves.toEqual({ accepted: true });
      expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({ userId: 'user-1', health: 'stale', secondsSinceLastTick: 42 }) });
    });

    it('defaults the optional fields rather than writing undefined', async () => {
      const create = jest.fn().mockResolvedValue({ id: 'r1' });
      const svc = new HealthDetailService(
        makePrisma(create) as never,
        { lastRunPerJob: jest.fn() } as never,
        null as never,
      );

      await svc.recordClientReport(null, { health: 'offline', tickSocketUp: false, subscribedTokens: 0, namespaces: {} });

      expect(create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: null,
          secondsSinceLastTick: null,
          transport: null,
          recoveredWithoutReload: false,
        }),
      });
    });

    it('answers accepted:false instead of throwing when the insert fails', async () => {
      // The caller is a browser whose feed is ALREADY degraded. Answering its
      // diagnostic with a 500 would add a visible error to a merely-stale
      // session, and could start a retry loop against a failing endpoint.
      const svc = new HealthDetailService(
        makePrisma(jest.fn().mockRejectedValue(new Error('db down'))) as never,
        { lastRunPerJob: jest.fn() } as never,
        null as never,
      );

      await expect(svc.recordClientReport(null, report)).resolves.toEqual({ accepted: false });
    });
  });

  it('reports the market hub status when it is running', async () => {
    const runs = { lastRunPerJob: jest.fn().mockResolvedValue([]) };
    const hub = { status: () => ({ socketUp: true, watched: 5 }), disabledReason: () => null };
    const svc = new HealthDetailService(makePrisma() as never, runs as never, null, hub as never);
    const out = await svc.check();
    expect(out.hub.available).toBe(true);
    if (out.hub.available) expect(out.hub.value.watched).toBe(5);
  });

  it('says why the hub is idle instead of hiding it', async () => {
    const runs = { lastRunPerJob: jest.fn().mockResolvedValue([]) };
    const hub = { status: () => null, disabledReason: () => 'enabled but HUB_OWNER_USER_ID is not set' };
    const svc = new HealthDetailService(makePrisma() as never, runs as never, null, hub as never);
    const out = await svc.check();
    expect(out.hub).toEqual({ available: false, reason: 'enabled but HUB_OWNER_USER_ID is not set' });
  });
});
