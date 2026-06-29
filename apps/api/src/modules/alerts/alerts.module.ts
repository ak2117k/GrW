import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { AlertsController } from './controllers/alerts.controller';
import { AlertsService } from './services/alerts.service';

@Module({
  imports: [PrismaModule],
  controllers: [AlertsController],
  providers: [AlertsService],
  exports: [AlertsService],
})
export class AlertsModule {}
