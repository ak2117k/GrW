import { Reflector } from '@nestjs/core';
import { HealthController } from './health.controller';
import type { HealthService } from './health.service';
import type { HealthDetailService } from './health-detail.service';
import { IS_PUBLIC_KEY, ROLES_KEY } from '../../common/decorators';

describe('HealthController', () => {
  function build(check: jest.Mock, detail: jest.Mock = jest.fn()): HealthController {
    return new HealthController(
      { check } as unknown as HealthService,
      { check: detail } as unknown as HealthDetailService,
    );
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

  describe('route protection', () => {
    // Both guards resolve this metadata as getAllAndOverride(key, [handler, class]),
    // so the lookups below are the exact question production asks. A class-level
    // @Public() would answer 'true' for BOTH routes -- and RolesGuard short-circuits
    // on isPublic, so @AdminOnly() on the detail route would never even be read.
    const reflector = new Reflector();

    it('keeps GET /healthz unauthenticated', () => {
      // Render probes this to decide whether to kill the container, and the
      // keep-warm cron hits it anonymously. Requiring a JWT here brings back the
      // cold-start that presented to users as "unable to sign in".
      expect(
        reflector.getAllAndOverride(IS_PUBLIC_KEY, [HealthController.prototype.check, HealthController]),
      ).toBe(true);
    });

    it('does not expose /healthz/detail to anonymous callers', () => {
      expect(
        reflector.getAllAndOverride(IS_PUBLIC_KEY, [HealthController.prototype.detail, HealthController]),
      ).toBeUndefined();
      expect(
        reflector.getAllAndOverride(ROLES_KEY, [HealthController.prototype.detail, HealthController]),
      ).toEqual(['ADMIN']);
    });
  });

  describe('clientReport', () => {
    it('files the report under the authenticated user id', async () => {
      // JwtStrategy attaches { userId, role, email }. Reading user.id here
      // would compile fine against a loose annotation and file every report as
      // anonymous -- a silent absence, which is the thing this branch exists to
      // stamp out.
      const record = jest.fn().mockResolvedValue({ accepted: true });
      const controller = new HealthController(
        { check: jest.fn() } as unknown as HealthService,
        { recordClientReport: record } as unknown as HealthDetailService,
      );
      const body = { health: 'stale', tickSocketUp: true, subscribedTokens: 0, namespaces: {} } as never;

      await controller.clientReport({ userId: 'u-1', role: 'USER', email: 'a@b.c' }, body);

      expect(record).toHaveBeenCalledWith('u-1', body);
    });

    it('accepts an unauthenticated principal as a null user rather than throwing', async () => {
      const record = jest.fn().mockResolvedValue({ accepted: true });
      const controller = new HealthController(
        { check: jest.fn() } as unknown as HealthService,
        { recordClientReport: record } as unknown as HealthDetailService,
      );

      await controller.clientReport(undefined, {} as never);

      expect(record).toHaveBeenCalledWith(null, {});
    });
  });
});
