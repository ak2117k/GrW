import { HealthController } from './health.controller';
import type { HealthService } from './health.service';

describe('HealthController', () => {
  function build(check: jest.Mock): HealthController {
    return new HealthController({ check } as unknown as HealthService);
  }

  it('passes the collected payload straight through', async () => {
    const payload = { status: 'ok', db: 'ok' };
    const controller = build(jest.fn().mockResolvedValue(payload));

    await expect(controller.check()).resolves.toBe(payload);
  });

  it('answers 200 with everything unavailable when the collector itself throws', async () => {
    // Render kills the container on a failing probe. A bug in the collector
    // must therefore degrade the BODY, never the status code — otherwise the
    // monitoring code becomes the outage it was installed to detect.
    const controller = build(jest.fn().mockRejectedValue(new Error('collector bug')));

    const payload = await controller.check();

    expect(payload.status).toBe('ok');
    expect(payload.db).toBe('error');
    expect(payload.feed).toEqual({ available: false, reason: 'collector bug' });
    expect(payload.lastCandleAt.available).toBe(false);
    expect(payload.lastTrackerUpdateAt.available).toBe(false);
    expect(payload.lastVerdictAt.available).toBe(false);
    expect(payload.openPositions.available).toBe(false);
    expect(payload.session).toBeDefined();
  });
});
