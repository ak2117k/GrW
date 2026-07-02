import { Body, Controller, Post } from '@nestjs/common';
import { AdminOnly, CurrentUser } from '../../common/decorators';
import type { AuthenticatedUser } from '../../common/decorators';
import { RISK_DISCLOSURE } from './consent.constants';
import { ConsentService } from './consent.service';
import { PublishConsentDto } from './dto/consent.dto';

/**
 * ADMIN-only consent version management (spec §7). Publishing a new version is
 * the ONLY path that mints a new "current version" and thus forces global
 * re-consent. `@AdminOnly()` is enforced by the global RolesGuard.
 */
@AdminOnly()
@Controller('api/admin/consent')
export class AdminConsentController {
  constructor(private readonly consent: ConsentService) {}

  @Post('publish')
  publish(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: PublishConsentDto,
  ) {
    return this.consent.publish(
      dto.kind ?? RISK_DISCLOSURE,
      dto.version,
      dto.body,
      actor.userId,
    );
  }
}
