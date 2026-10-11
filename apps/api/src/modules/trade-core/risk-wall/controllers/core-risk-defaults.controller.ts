import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AdminOnly, CurrentUser, type AuthenticatedUser } from '../../../../common/decorators';
import { ChangeLimitDto } from '../dto/core-risk.dto';
import { CoreRiskDefaultsService, type CoreRiskDefaultView } from '../services/core-risk-defaults.service';

/** Owner-only editing of the global seed defaults (decision 20). The service re-checks the role. */
@ApiTags('Trade core: risk defaults')
@AdminOnly()
@Controller('api/trade-core/risk/defaults')
export class CoreRiskDefaultsController {
  constructor(private readonly defaults: CoreRiskDefaultsService) {}

  @Get()
  async list(): Promise<{ defaults: CoreRiskDefaultView[] }> {
    return { defaults: await this.defaults.list() };
  }

  @Put(':key/:scope')
  change(
    @CurrentUser() user: AuthenticatedUser,
    @Param('key') key: string,
    @Param('scope') scope: string,
    @Body() dto: ChangeLimitDto,
  ): Promise<CoreRiskDefaultView> {
    return this.defaults.change({ userId: user.userId, role: user.role }, { key, scope, value: dto.value, reason: dto.reason });
  }
}
