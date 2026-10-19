// apps/api/src/modules/mbm/controllers/mbm.controller.ts
import { Controller, ForbiddenException, Get, Inject, Param } from '@nestjs/common';
import { CurrentUser } from '../../../common/decorators';
import type { AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import { parseAutoExitConfig } from '../../sentinel-executor/domain/auto-exit.config';
import { MBM_CONFIG, type MbmConfig } from '../mbm.config';
import { MbmClient, type MbmBehaviour } from '../services/mbm-client.service';

/**
 * Observe-only read of the market-behaviour model (plan §4). Global JWT guard; like the other owner
 * endpoints the caller must be ADMIN, the MBM feed user or AI-auto-exit allow-listed. No trade path reads this in M2.
 */
@Controller('api/mbm')
export class MbmController {
  constructor(
    private readonly client: MbmClient,
    @Inject(MBM_CONFIG) private readonly config: MbmConfig,
  ) {}

  @Get('behaviour/:instrument')
  behaviour(@CurrentUser() user: AuthenticatedUser, @Param('instrument') instrument: string): Promise<MbmBehaviour> {
    const allowed = new Set(parseAutoExitConfig(process.env).userIds);
    if (this.config.feedUserId) allowed.add(this.config.feedUserId);
    if (!user?.userId || (user.role !== 'ADMIN' && !allowed.has(user.userId))) {
      throw new ForbiddenException('The market-behaviour model is not enabled for this account');
    }
    return this.client.behaviour(instrument);
  }
}
