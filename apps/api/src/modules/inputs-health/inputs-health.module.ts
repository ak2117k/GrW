import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { makeSentinelClock } from '../trade-sentinel/overnight/overnight-calendar';
import { InputsHealthRepository } from './repositories/inputs-health.repository';
import { InputsHealthCron } from './services/inputs-health.cron';
import { INPUTS_HEALTH_CLOCK, InputsHealthService } from './services/inputs-health.service';

/**
 * Inputs health (2026-11-04): every 15 min, during each watched underlying's own session, checks that
 * its 1m bars, option chain, the news pipeline and the entry engine's news input are actually arriving,
 * and sends one Telegram ops alert per (problem, underlying, IST day). DETECTION ONLY — imported by no
 * trading path. INPUTS_HEALTH=off disables it (default on).
 */
@Module({
  imports: [PrismaModule],
  providers: [
    InputsHealthRepository,
    InputsHealthService,
    InputsHealthCron,
    { provide: INPUTS_HEALTH_CLOCK, useFactory: () => makeSentinelClock(process.env.HUB_MCX_LATE_CLOSE) },
  ],
})
export class InputsHealthModule {}
