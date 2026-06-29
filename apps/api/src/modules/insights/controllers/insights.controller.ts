import { Controller, Post, Get, Body, Param } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { InsightsService } from '../services/insights.service';
import { RequestInsightDto } from '../dto/request-insight.dto';

@ApiTags('insights')
@Controller('api/insights')
export class InsightsController {
  constructor(private readonly service: InsightsService) {}

  @Post('request')
  @ApiOperation({ summary: 'Request an AI insight for a section (idempotent)' })
  async request(@Body() dto: RequestInsightDto) {
    const row = await this.service.requestInsight(
      dto.sectionKey,
      dto.contextKey,
      dto.contextData as object,
    );
    return row;
  }

  @Get(':sectionKey/:contextKey')
  @ApiOperation({ summary: 'Get latest insight for a section + context' })
  async getLatest(
    @Param('sectionKey') sectionKey: string,
    @Param('contextKey') contextKey: string,
  ) {
    return this.service.getLatest(sectionKey, contextKey);
  }

  @Post('mcp/claim-pending')
  @ApiOperation({ summary: '[MCP] Claim up to 10 pending insights, marking them in_progress' })
  async claimPending() {
    const claimed = await this.service.claimPending();
    return { insights: claimed };
  }

  @Post('mcp/:id/complete')
  @ApiOperation({ summary: '[MCP] Mark an insight completed with content' })
  async completeMcp(
    @Param('id') id: string,
    @Body() body: { content: string; confidence: number },
  ) {
    return this.service.completeInsight(id, body.content, body.confidence);
  }

  @Post('mcp/:id/fail')
  @ApiOperation({ summary: '[MCP] Mark an insight failed with error message' })
  async failMcp(
    @Param('id') id: string,
    @Body() body: { errorMessage: string },
  ) {
    return this.service.failInsight(id, body.errorMessage);
  }
}
