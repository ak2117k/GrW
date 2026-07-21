import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  UnauthorizedException,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';
import { Public } from '../../../common/decorators';
import { TelegramIngestService } from '../services/telegram-ingest.service';
import { TelegramRepository } from '../repositories/telegram.repository';
import { TelegramIngestDto } from '../dto/telegram-ingest.dto';

export const TELEGRAM_INGEST_SECRET_HEADER = 'x-telegram-ingest-secret';

@Public()
@Controller('webhooks/telegram')
export class TelegramIngestController {
  private readonly logger = new Logger(TelegramIngestController.name);

  constructor(
    private readonly ingest: TelegramIngestService,
    private readonly repo: TelegramRepository,
    private readonly config: ConfigService,
  ) {}

  @Post('ingest')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
  async receive(
    @Headers(TELEGRAM_INGEST_SECRET_HEADER) secret: string | undefined,
    @Body() body: TelegramIngestDto,
  ) {
    this.assertAuthorized(secret);
    return this.ingest.ingest(body);
  }

  @Get('last-seen')
  async lastSeen(@Headers(TELEGRAM_INGEST_SECRET_HEADER) secret: string | undefined) {
    this.assertAuthorized(secret);
    return this.repo.lastSeenByChannel();
  }

  private assertAuthorized(provided: string | undefined): void {
    const expected = this.config.get<string>('TELEGRAM_INGEST_SECRET');
    if (!expected) {
      // Fail closed: never accept ingest when the shared secret is unconfigured.
      this.logger.warn('TELEGRAM_INGEST_SECRET unset — rejecting');
      throw new UnauthorizedException();
    }
    const p = provided ?? '';
    if (p.length !== expected.length || !timingSafeEqual(Buffer.from(p), Buffer.from(expected))) {
      this.logger.warn(`Telegram ingest auth failed (len=${p.length})`);
      throw new UnauthorizedException();
    }
  }
}
