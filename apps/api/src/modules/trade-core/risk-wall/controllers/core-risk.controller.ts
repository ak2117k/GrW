import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../../../common/decorators';
import { ChangeLimitDto, SetKillSwitchDto } from '../dto/core-risk.dto';
import { CoreKillSwitchService, type KillSwitchSetResult, type KillSwitchView } from '../services/core-kill-switch.service';
import { CoreRiskLimitService, type CoreRiskLimitView, type LimitChangeResult } from '../services/core-risk-limit.service';

/**
 * The caller's own Risk Wall limits and kill switch (spec §5.2, §5.4, §8.4). Every
 * route is authenticated by the global JwtAuthGuard; none is @AdminOnly because
 * these are the user's own controls (plan decision 10). The user always comes from
 * the token. GET kill-switch never writes; only POST changes it.
 */
@ApiTags('Trade core: risk')
@Controller('api/trade-core/risk')
export class CoreRiskController {
  constructor(
    private readonly limits: CoreRiskLimitService,
    private readonly killSwitch: CoreKillSwitchService,
  ) {}

  @Get('limits')
  async listLimits(@CurrentUser('userId') userId: string): Promise<{ limits: CoreRiskLimitView[] }> {
    return { limits: await this.limits.list(userId) };
  }

  @Put('limits/:key/:scope')
  changeLimit(
    @CurrentUser('userId') userId: string,
    @Param('key') key: string,
    @Param('scope') scope: string,
    @Body() dto: ChangeLimitDto,
  ): Promise<LimitChangeResult> {
    return this.limits.change(userId, { key, scope, value: dto.value, reason: dto.reason });
  }

  @Get('kill-switch')
  getKillSwitch(@CurrentUser('userId') userId: string): Promise<KillSwitchView> {
    return this.killSwitch.get(userId);
  }

  @Post('kill-switch')
  @HttpCode(HttpStatus.OK)
  setKillSwitch(@CurrentUser() user: AuthenticatedUser, @Body() dto: SetKillSwitchDto): Promise<KillSwitchSetResult> {
    return this.killSwitch.set({ userId: user.userId, role: user.role }, { active: dto.active, reason: dto.reason });
  }
}
