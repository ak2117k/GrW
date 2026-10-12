import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AdminOnly, CurrentUser, type AuthenticatedUser } from '../../../../common/decorators';
import { ChangeLimitDto } from '../../risk-wall/dto/core-risk.dto';
import { CorePaperDefaultsService, type CorePaperDefaultView } from '../services/core-paper-defaults.service';

/** Owner-only editing of the paper defaults (spec §4.5). The service re-checks the role. UI is M5. */
@ApiTags('Trade core: paper defaults')
@AdminOnly()
@Controller('api/trade-core/paper/defaults')
export class CorePaperDefaultsController {
  constructor(private readonly defaults: CorePaperDefaultsService) {}

  @Get()
  async list(): Promise<{ defaults: CorePaperDefaultView[] }> {
    return { defaults: await this.defaults.list() };
  }

  @Put(':key/:scope')
  change(
    @CurrentUser() user: AuthenticatedUser,
    @Param('key') key: string,
    @Param('scope') scope: string,
    @Body() dto: ChangeLimitDto,
  ): Promise<CorePaperDefaultView> {
    return this.defaults.change({ userId: user.userId, role: user.role }, { key, scope, value: dto.value, reason: dto.reason });
  }
}
