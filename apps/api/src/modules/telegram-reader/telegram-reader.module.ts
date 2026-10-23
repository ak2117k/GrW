import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { CredentialDecryptorModule } from '../credential-vault/execution/credential-decryptor.module';
import { GramJsClientFactory } from './client/gramjs-client';
import { TG_CLIENT_FACTORY } from './client/telegram-client.port';
import { TelegramReaderController } from './controllers/telegram-reader.controller';
import { TelegramOwnerGuard } from './guards/telegram-owner.guard';
import { TelegramAuthService } from './services/telegram-auth.service';
import { TelegramChannelsService } from './services/telegram-channels.service';
import { TelegramListenerService } from './services/telegram-listener.service';
import { TelegramSessionStore } from './services/telegram-session.store';

/**
 * Telegram READER (stream R, contract 2026-10-23): reads the owner's chosen channels through the
 * owner's own Telegram user account (MTProto via GramJS), persists every message, emits
 * `telegram.message`. TELEGRAM_READER=on|off (default on; inert without a stored session).
 * Needs EventEmitterModule.forRoot() in the root module. KmsModule + AuditModule are @Global.
 */
@Module({
  imports: [PrismaModule, CredentialDecryptorModule],
  controllers: [TelegramReaderController],
  providers: [
    { provide: TG_CLIENT_FACTORY, useClass: GramJsClientFactory },
    TelegramSessionStore,
    TelegramListenerService,
    TelegramAuthService,
    TelegramChannelsService,
    TelegramOwnerGuard,
  ],
  exports: [TelegramListenerService],
})
export class TelegramReaderModule {}
