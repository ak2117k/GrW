import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AdminOnly, CurrentUser, type AuthenticatedUser } from '../../../../common/decorators';
import {
  CoreStrategyCatalogueService,
  type Actor,
  type EditVersionResult,
} from '../services/core-strategy-catalogue.service';
import { CoreStrategySelectionService } from '../services/core-strategy-selection.service';
import {
  CreateDraftDto,
  EditVersionDto,
  SetSelectionDto,
  SetVersionStatusDto,
  type CoreSelectionDto,
  type CoreStrategyDto,
  type CoreStrategyVersionDto,
} from '../dto/core-strategy.dto';

const actorOf = (u: AuthenticatedUser): Actor => ({ userId: u.userId, role: u.role });

/**
 * SP2 strategy catalogue and per-user selections (spec §4.2–4.3). Every route is
 * authenticated by the global JwtAuthGuard. Catalogue writes are owner-only
 * (@AdminOnly, and the service re-checks for mode changes). Selection routes act
 * on the caller only: the user comes from the token, never the path or body.
 * Drafts and edits are audited with the token user as the actor (ruling P6).
 */
@ApiTags('Trade core: strategies')
@Controller('api/trade-core')
export class CoreStrategiesController {
  constructor(
    private readonly catalogue: CoreStrategyCatalogueService,
    private readonly selections: CoreStrategySelectionService,
  ) {}

  @Get('strategies')
  async list(@CurrentUser() user: AuthenticatedUser): Promise<{ strategies: CoreStrategyDto[] }> {
    return { strategies: await this.catalogue.list(actorOf(user)) };
  }

  @AdminOnly()
  @Post('strategies/:strategyId/versions')
  createDraft(
    @CurrentUser('userId') userId: string,
    @Param('strategyId') strategyId: string,
    @Body() dto: CreateDraftDto,
  ): Promise<CoreStrategyVersionDto> {
    return this.catalogue.createDraft(strategyId, { blocks: dto.blocks, notes: dto.notes ?? null }, 'OWNER', userId);
  }

  @AdminOnly()
  @Patch('strategy-versions/:versionId')
  edit(
    @CurrentUser('userId') userId: string,
    @Param('versionId') versionId: string,
    @Body() dto: EditVersionDto,
  ): Promise<EditVersionResult> {
    return this.catalogue.editVersion(versionId, { blocks: dto.blocks, notes: dto.notes }, userId);
  }

  @AdminOnly()
  @Post('strategy-versions/:versionId/approve')
  @HttpCode(HttpStatus.OK)
  approve(@CurrentUser() user: AuthenticatedUser, @Param('versionId') versionId: string): Promise<CoreStrategyVersionDto> {
    return this.catalogue.approve(versionId, actorOf(user));
  }

  @AdminOnly()
  @Post('strategy-versions/:versionId/status')
  @HttpCode(HttpStatus.OK)
  setStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Param('versionId') versionId: string,
    @Body() dto: SetVersionStatusDto,
  ): Promise<CoreStrategyVersionDto> {
    return this.catalogue.setStatus(versionId, dto.status, actorOf(user));
  }

  @Get('strategy-selections')
  async listSelections(@CurrentUser('userId') userId: string): Promise<{ selections: CoreSelectionDto[] }> {
    return { selections: await this.selections.list(userId) };
  }

  @Put('strategy-selections/:strategyId')
  setSelection(
    @CurrentUser('userId') userId: string,
    @Param('strategyId') strategyId: string,
    @Body() dto: SetSelectionDto,
  ): Promise<CoreSelectionDto> {
    return this.selections.set(userId, strategyId, dto);
  }
}
