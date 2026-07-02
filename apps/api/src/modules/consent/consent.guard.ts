import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { AuthenticatedUser } from '../../common/decorators';
import { CONSENT_ERRORS } from './consent.constants';
import { ConsentService } from './consent.service';

/**
 * TDA-009 enforcement gate (spec §5) — the HTTP half of the TDA-011 seam.
 *
 * Reads `req.user` (populated by `JwtStrategy`; this guard MUST run AFTER
 * `JwtAuthGuard`), calls {@link ConsentService.hasAcceptedCurrent} for that
 * user, and on `false` throws `403 { code: 'CONSENT_REQUIRED', currentVersion }`.
 *
 * It does NOT special-case ADMIN — consent is about the account being traded,
 * so an ADMIN auto-trading their own account must consent too. TDA-009 ships
 * the guard but attaches it to NO route; TDA-011 annotates its execution routes
 * with `@RequiresConsent()`.
 */
@Injectable()
export class ConsentGuard implements CanActivate {
  constructor(private readonly consent: ConsentService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const user: AuthenticatedUser | undefined = req.user;
    const userId = user?.userId;

    if (!userId || !(await this.consent.hasAcceptedCurrent(userId))) {
      const current = await this.consent.getCurrent();
      throw new ForbiddenException({
        code: CONSENT_ERRORS.CONSENT_REQUIRED,
        currentVersion: current?.version ?? null,
      });
    }
    return true;
  }
}
