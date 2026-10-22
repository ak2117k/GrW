import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { MbmModule } from '../mbm/mbm.module';
import { MbmClient } from '../mbm/services/mbm-client.service';
import { OvernightScorecardModule } from '../overnight-scorecard/overnight-scorecard.module';
import { ScorecardService } from '../overnight-scorecard/scorecard.service';
import { parseAutoExitConfig } from '../sentinel-executor/domain/auto-exit.config';
import { makeSentinelClock } from '../trade-sentinel/overnight/overnight-calendar';
import { TradeSetupModule } from '../trade-setup/trade-setup.module';
import { NightReportController } from './controllers/night-report.controller';
import { NIGHT_REPORT_STORE, NightReportRepository } from './repositories/night-report.repository';
import {
  NIGHT_REPORT_MOOD,
  NIGHT_REPORT_OPTIONS,
  NIGHT_REPORT_SCORECARDS,
  NightReportService,
  type NightReportOptions,
} from './services/night-report.service';

/**
 * Night report: one read-only aggregation of the night since the last NSE close
 * (positions + overnight verdicts, news, events, MBM daily setups and mood, job
 * freshness). Reads only; places nothing, writes nothing.
 */
@Module({
  imports: [PrismaModule, MbmModule, OvernightScorecardModule, TradeSetupModule],
  controllers: [NightReportController],
  providers: [
    NightReportRepository,
    { provide: NIGHT_REPORT_STORE, useExisting: NightReportRepository },
    { provide: NIGHT_REPORT_MOOD, useExisting: MbmClient },
    { provide: NIGHT_REPORT_SCORECARDS, useExisting: ScorecardService },
    {
      provide: NIGHT_REPORT_OPTIONS,
      useFactory: (): NightReportOptions => ({
        clock: makeSentinelClock(process.env.HUB_MCX_LATE_CLOSE),
        hold: parseAutoExitConfig(process.env).hold ?? [],
      }),
    },
    NightReportService,
  ],
})
export class NightReportModule {}
