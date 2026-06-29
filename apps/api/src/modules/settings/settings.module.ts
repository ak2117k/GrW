import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { SettingsController } from './controllers/settings.controller';
import { SettingsService } from './services/settings.service';

@Module({
  imports: [PrismaModule],
  controllers: [SettingsController],
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
