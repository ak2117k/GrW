import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { AuthenticatedUser } from '../decorators';
import { TenantContextService } from './tenant-context.service';

/**
 * Global interceptor (TDA-003 §3) that copies the authenticated principal into
 * the request-scoped tenant context. It runs AFTER `JwtAuthGuard`, so `req.user`
 * — `{ userId, role, email }` from `JwtStrategy.validate` — is already present
 * for protected routes.
 *
 * Public/unauthenticated routes have no `req.user`, so the context is left unset
 * (system/background scope) and Prisma queries run unscoped.
 */
@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  constructor(private readonly tenantContext: TenantContextService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest();
    const user: AuthenticatedUser | undefined = request?.user;
    if (user) {
      this.tenantContext.set({ userId: user.userId, role: user.role });
    }
    return next.handle();
  }
}
