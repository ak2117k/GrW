import { ForbiddenException } from '@nestjs/common';
import { TelegramOwnerGuard, isTelegramOwner } from '../guards/telegram-owner.guard';

function ctx(user: unknown) {
  return { switchToHttp: () => ({ getRequest: () => ({ user }) }) } as any;
}

describe('TelegramOwnerGuard', () => {
  it('with HUB_OWNER_USER_ID set, only that user passes (even an ADMIN is refused)', () => {
    const g = new TelegramOwnerGuard({ get: () => 'owner' } as any);
    expect(g.canActivate(ctx({ userId: 'owner', role: 'USER' }))).toBe(true);
    expect(() => g.canActivate(ctx({ userId: 'other', role: 'ADMIN' }))).toThrow(ForbiddenException);
    expect(() => g.canActivate(ctx(undefined))).toThrow(ForbiddenException);
  });

  it('without it, ADMIN only', () => {
    expect(isTelegramOwner({ userId: 'a', role: 'ADMIN' }, '')).toBe(true);
    expect(isTelegramOwner({ userId: 'a', role: 'USER' }, '')).toBe(false);
  });
});
