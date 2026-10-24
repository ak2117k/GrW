import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { CurrentUser, type AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import { StrategyCheckDto, StrategyReviewDto, StrategySuggestDto } from '../dto/strategy-ai.dto';
import { StrategyAiService } from '../services/strategy-ai.service';

/**
 * Strategy Builder validation + AI.
 *
 *   POST /api/strategy-builder/check        deterministic checklist (any signed-in user, no model call)
 *   GET  /api/strategy-builder/ai/status    may this user use Claude here, and calls left today
 *   POST /api/strategy-builder/ai/review    owner only — Claude review of a strategy that passes the checks
 *   POST /api/strategy-builder/ai/suggest   owner only — Claude proposals for EMPTY fields only
 *
 * The AI routes answer 403 for non-owners; blocked / busy / cached outcomes are
 * 200 with a `status` field so the builder can show them inline.
 */
@Controller('api/strategy-builder')
export class StrategyBuilderAiController {
  constructor(private readonly ai: StrategyAiService) {}

  @Post('check')
  @HttpCode(HttpStatus.OK)
  check(@Body() dto: StrategyCheckDto, @CurrentUser() user?: AuthenticatedUser) {
    return this.ai.check(dto.state, user);
  }

  @Get('ai/status')
  status(@CurrentUser() user?: AuthenticatedUser) {
    return this.ai.status(user);
  }

  @Post('ai/review')
  @HttpCode(HttpStatus.OK)
  review(@Body() dto: StrategyReviewDto, @CurrentUser() user?: AuthenticatedUser) {
    return this.ai.review(dto.state, dto.backtest, user);
  }

  @Post('ai/suggest')
  @HttpCode(HttpStatus.OK)
  suggest(@Body() dto: StrategySuggestDto, @CurrentUser() user?: AuthenticatedUser) {
    return this.ai.suggest(dto.state, user);
  }
}
