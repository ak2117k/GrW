import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';

/**
 * Liveness + keep-warm endpoint. PrismaService is provided by the @Global
 * PrismaModule, so no imports are needed here.
 */
@Module({
  controllers: [HealthController],
})
export class HealthModule {}
