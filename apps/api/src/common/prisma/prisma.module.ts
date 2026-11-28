import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { TelegramOutboxRegistrar } from './telegram-outbox.registrar';

@Global()
@Module({
  providers: [PrismaService, TelegramOutboxRegistrar],
  exports: [PrismaService],
})
export class PrismaModule {}
