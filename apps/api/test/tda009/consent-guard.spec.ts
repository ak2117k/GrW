/**
 * TDA-009 Task 5 — ConsentGuard (unit, no DB).
 *
 * The guard reads `req.user` (populated by JwtStrategy), calls
 * `hasAcceptedCurrent(user.userId)`, and on `false` throws
 * `403 { code: 'CONSENT_REQUIRED', currentVersion }`. `ConsentService` is
 * stubbed, so this is pure. TDA-011 attaches the guard to its execution routes.
 *
 * Run from apps/api:
 *   npx jest --config test/tda009/jest.config.js consent-guard --verbose
 */

import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { ConsentGuard } from '../../src/modules/consent/consent.guard';
import { ConsentService } from '../../src/modules/consent/consent.service';

const ctxFor = (user: unknown): ExecutionContext =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  }) as unknown as ExecutionContext;

describe('TDA-009 Task 5 — ConsentGuard', () => {
  it('passes when the caller has accepted the current version', async () => {
    const svc = {
      hasAcceptedCurrent: jest.fn().mockResolvedValue(true),
      getCurrent: jest.fn(),
    } as unknown as ConsentService;
    const guard = new ConsentGuard(svc);

    await expect(
      guard.canActivate(ctxFor({ userId: 'u1', role: 'USER' })),
    ).resolves.toBe(true);
    expect((svc as any).hasAcceptedCurrent).toHaveBeenCalledWith('u1');
  });

  it('throws 403 CONSENT_REQUIRED with currentVersion when not accepted', async () => {
    const svc = {
      hasAcceptedCurrent: jest.fn().mockResolvedValue(false),
      getCurrent: jest.fn().mockResolvedValue({ version: '2026-07-02.1' }),
    } as unknown as ConsentService;
    const guard = new ConsentGuard(svc);

    await expect(
      guard.canActivate(ctxFor({ userId: 'u1', role: 'USER' })),
    ).rejects.toBeInstanceOf(ForbiddenException);

    try {
      await guard.canActivate(ctxFor({ userId: 'u1', role: 'USER' }));
      fail('expected ForbiddenException');
    } catch (e) {
      const res = (e as ForbiddenException).getResponse() as any;
      expect(res.code).toBe('CONSENT_REQUIRED');
      expect(res.currentVersion).toBe('2026-07-02.1');
    }
  });

  it('does not special-case ADMIN (consent is about the account being traded)', async () => {
    const svc = {
      hasAcceptedCurrent: jest.fn().mockResolvedValue(false),
      getCurrent: jest.fn().mockResolvedValue({ version: 'v9' }),
    } as unknown as ConsentService;
    const guard = new ConsentGuard(svc);

    await expect(
      guard.canActivate(ctxFor({ userId: 'admin1', role: 'ADMIN' })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
