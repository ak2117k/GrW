import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Ip, Post, Put, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../../common/decorators';
import { ConfirmTelegramLoginDto, SetTelegramChannelsDto, StartTelegramLoginDto } from '../dto/telegram-reader.dto';
import { TelegramOwnerGuard } from '../guards/telegram-owner.guard';
import { TelegramAuthService } from '../services/telegram-auth.service';
import { TelegramChannelsService } from '../services/telegram-channels.service';
import { TelegramListenerService } from '../services/telegram-listener.service';
import { TelegramSessionStore } from '../services/telegram-session.store';

/**
 * Owner-only Telegram reader surface. Never returns api_hash, the session string, the phone
 * number or the login code — only masked/non-secret metadata.
 *
 *   GET    /api/telegram-reader/status
 *   POST   /api/telegram-reader/connect/start    { apiId, apiHash, phone }  -> { stage: 'code' }
 *   POST   /api/telegram-reader/connect/confirm  { code?, password? }      -> { stage: 'password' | 'connected' }
 *   POST   /api/telegram-reader/connect/cancel
 *   DELETE /api/telegram-reader/session          logs out on Telegram + deletes the sealed session
 *   GET    /api/telegram-reader/dialogs          the owner's channels/groups (+ enabled flag)
 *   PUT    /api/telegram-reader/channels         { tgChannelIds } (max 10) — the enabled set
 */
@UseGuards(TelegramOwnerGuard)
@Controller('api/telegram-reader')
export class TelegramReaderController {
  constructor(
    private readonly auth: TelegramAuthService,
    private readonly channels: TelegramChannelsService,
    private readonly listener: TelegramListenerService,
    private readonly store: TelegramSessionStore,
  ) {}

  @Get('status')
  async status(@CurrentUser('userId') userId: string) {
    const meta = await this.store.meta(userId);
    return {
      readerFlag: this.listener.flagOn ? 'on' : 'off',
      connected: !!meta,
      session: meta
        ? { phoneMasked: meta.phoneMasked, status: meta.status, lastError: meta.lastError, connectedAt: meta.connectedAt }
        : null,
      pending: this.auth.pendingStage(userId),
      listener: this.listener.status(),
      channels: await this.channels.listEnabled(userId),
    };
  }

  @Post('connect/start')
  @HttpCode(HttpStatus.OK)
  start(@CurrentUser('userId') userId: string, @Body() dto: StartTelegramLoginDto) {
    return this.auth.start(userId, { apiId: dto.apiId, apiHash: dto.apiHash, phone: dto.phone });
  }

  @Post('connect/confirm')
  @HttpCode(HttpStatus.OK)
  confirm(@CurrentUser('userId') userId: string, @Body() dto: ConfirmTelegramLoginDto, @Ip() ip: string) {
    return this.auth.confirm(userId, { code: dto.code, password: dto.password }, { ip });
  }

  @Post('connect/cancel')
  @HttpCode(HttpStatus.NO_CONTENT)
  async cancel(@CurrentUser('userId') userId: string): Promise<void> {
    await this.auth.cancel(userId);
  }

  @Delete('session')
  @HttpCode(HttpStatus.NO_CONTENT)
  async disconnect(@CurrentUser('userId') userId: string, @Ip() ip: string): Promise<void> {
    await this.channels.disconnect(userId, { ip });
  }

  @Get('dialogs')
  dialogs(@CurrentUser('userId') userId: string) {
    return this.channels.dialogs(userId);
  }

  @Put('channels')
  setChannels(@CurrentUser('userId') userId: string, @Body() dto: SetTelegramChannelsDto) {
    return this.channels.setEnabled(userId, dto.tgChannelIds);
  }
}
