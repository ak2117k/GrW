import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Owner-only gate (same rule as the other owner features, cf. assistAllowed): when
 * HUB_OWNER_USER_ID is set only that user passes; otherwise an ADMIN. Runs after the global
 * JwtAuthGuard, so req.user is populated.
 */
export function isTelegramOwner(user: { userId?: string; role?: string } | undefined, ownerUserId: string): boolean {
  if (!user?.userId) return false;
  if (ownerUserId) return user.userId === ownerUserId;
  return user.role === 'ADMIN';
}

@Injectable()
export class TelegramOwnerGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{ user?: { userId?: string; role?: string } }>();
    const owner = this.config.get<string>('HUB_OWNER_USER_ID')?.trim() ?? '';
    if (!isTelegramOwner(req.user, owner)) throw new ForbiddenException('Telegram signals are owner-only');
    return true;
  }
}
