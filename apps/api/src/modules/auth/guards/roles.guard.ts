import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../../../common/decorators';
import { Role, ROLES_KEY } from '../../../common/decorators/roles.decorator';

/**
 * Global role-based authorisation guard (registered as an `APP_GUARD` AFTER
 * {@link JwtAuthGuard}, so it runs second and `req.user` is already populated).
 *
 * Decision order:
 *   1. `@Public()` route        → allow (auth/authorisation both skipped).
 *   2. No `@Roles()` metadata    → allow (any authenticated user).
 *   3. `req.user.role` in the    → allow.
 *      required role set
 *   4. otherwise                 → 403 Forbidden.
 *
 * `JwtAuthGuard` already guarantees `req.user` exists for non-public routes; if
 * it is somehow absent on a role-restricted route we fail closed (deny).
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const requiredRoles = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    // No @Roles metadata → route is open to any authenticated user.
    if (!requiredRoles || requiredRoles.length === 0) return true;

    const { user } = context.switchToHttp().getRequest();
    if (user && requiredRoles.includes(user.role)) return true;

    throw new ForbiddenException('Insufficient role');
  }
}
