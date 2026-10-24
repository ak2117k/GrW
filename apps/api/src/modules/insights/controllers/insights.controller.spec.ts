import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { InsightsController } from './insights.controller';
import { TelegramController } from '../../telegram/controllers/telegram.controller';

/** Runs the production RolesGuard against a handler as a given role. */
function canCall(cls: any, handler: string, role: 'USER' | 'ADMIN'): boolean {
  const guard = new RolesGuard(new Reflector());
  const ctx = {
    getHandler: () => cls.prototype[handler],
    getClass: () => cls,
    switchToHttp: () => ({ getRequest: () => ({ user: { userId: 'u1', role } }) }),
  } as unknown as ExecutionContext;
  try {
    return guard.canActivate(ctx);
  } catch (e) {
    if (e instanceof ForbiddenException) return false;
    throw e;
  }
}

describe('legacy MCP / insight endpoints are owner-only', () => {
  it.each(['claimPending', 'completeMcp', 'failMcp'])('POST /api/insights/mcp/* (%s): USER 403, ADMIN allowed', (h) => {
    expect(() => {
      const guard = new RolesGuard(new Reflector());
      guard.canActivate({
        getHandler: () => (InsightsController.prototype as any)[h],
        getClass: () => InsightsController,
        switchToHttp: () => ({ getRequest: () => ({ user: { userId: 'u1', role: 'USER' } }) }),
      } as unknown as ExecutionContext);
    }).toThrow(ForbiddenException);
    expect(canCall(InsightsController, h, 'ADMIN')).toBe(true);
  });

  it('per-user insight read/request stay open to any signed-in user', () => {
    expect(canCall(InsightsController, 'request', 'USER')).toBe(true);
    expect(canCall(InsightsController, 'getLatest', 'USER')).toBe(true);
  });

  it('/api/telegram/* (TelegramController) is ADMIN-only', () => {
    const handlers = Object.getOwnPropertyNames(TelegramController.prototype).filter((n) => n !== 'constructor');
    expect(handlers.length).toBeGreaterThan(0);
    for (const h of handlers) {
      expect(canCall(TelegramController, h, 'USER')).toBe(false);
      expect(canCall(TelegramController, h, 'ADMIN')).toBe(true);
    }
  });
});
