import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { NewsAggregatorService } from '../services/news-aggregator.service';
import { NewsFilterDto } from '../dto/news.dto';

@ApiTags('News')
@Controller('api/news')
export class NewsController {
  constructor(
    private readonly newsAggregatorService: NewsAggregatorService,
    @InjectQueue('news-fetch') private readonly newsFetchQueue: Queue,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Get paginated news with filters' })
  @ApiResponse({ status: 200, description: 'Paginated news articles' })
  async getNews(@Query() filters: NewsFilterDto) {
    return this.newsAggregatorService.getNews(filters);
  }

  @Get('symbol/:symbol')
  @ApiOperation({ summary: 'Get news related to a specific symbol' })
  @ApiParam({ name: 'symbol', description: 'Stock symbol (e.g., RELIANCE)' })
  @ApiResponse({ status: 200, description: 'News articles for symbol' })
  async getNewsForSymbol(@Param('symbol') symbol: string) {
    return this.newsAggregatorService.getNewsForSymbol(symbol);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single news article by ID' })
  @ApiParam({ name: 'id', description: 'Article ID' })
  @ApiResponse({ status: 200, description: 'Single news article' })
  @ApiResponse({ status: 404, description: 'Article not found' })
  async getArticle(@Param('id') id: string) {
    const article = await this.newsAggregatorService.getArticleById(id);
    if (!article) {
      throw new NotFoundException(`Article with id "${id}" not found`);
    }
    return article;
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Trigger a manual news fetch' })
  @ApiResponse({ status: 200, description: 'News fetch triggered' })
  async triggerRefresh() {
    await this.newsFetchQueue.add({}, { removeOnComplete: true });
    return { message: 'News fetch job queued' };
  }
}
