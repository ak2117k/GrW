import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Post,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { CurrentUser } from '../../common/decorators';
import type { AuthenticatedUser } from '../../common/decorators';
import { CONSENT_ERRORS } from './consent.constants';
import { ConsentService } from './consent.service';
import { AcceptConsentDto } from './dto/consent.dto';

/**
 * USER-facing consent surface (spec §7). All routes are under the global
 * `JwtAuthGuard` (authenticated); no special role required — each user manages
 * their own consent. IP + user-agent for `accept` are captured server-side from
 * the request (mirroring `AuthController.ctx`), never trusted from the body.
 */
@Controller('api/consent')
export class ConsentController {
  constructor(private readonly consent: ConsentService) {}

  @Get('current')
  async current(@CurrentUser() _user: AuthenticatedUser) {
    const doc = await this.consent.getCurrent();
    if (!doc) {
      throw new NotFoundException({ code: CONSENT_ERRORS.NO_ACTIVE_CONSENT });
    }
    return doc;
  }

  @Get('status')
  status(@CurrentUser() user: AuthenticatedUser) {
    return this.consent.getStatus(user.userId);
  }

  @Post('accept')
  accept(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: AcceptConsentDto,
    @Req() req: Request,
  ) {
    return this.consent.accept(
      user.userId,
      dto.version,
      dto.contentHash,
      req.ip ?? null,
      req.headers['user-agent'] ?? null,
    );
  }

  @Post('revoke')
  async revoke(@CurrentUser() user: AuthenticatedUser) {
    await this.consent.revoke(user.userId);
    return { ok: true };
  }
}
