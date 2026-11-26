import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { DESK_MANAGER_CONFIG, parseDeskManagerConfig, type DeskManagerConfig } from './desk-manager.config';
import { DeskDayRepository } from './repositories/desk-day.repository';
import { DESK_GUARD, DeskGuardService } from './services/desk-guard.service';

/**
 * The desk guard on its own (desk-manager spec §5.5), imported by every module that provides the live order
 * path (signal-trader, reentry-watch) and by the desk manager. Kept apart from DeskManagerModule so the order
 * path never imports the manager (no module cycle).
 *
 * `DESK_GUARD` is what SignalExecutorService injects (@Optional): null while DESK_MANAGER=off, so deploying
 * with the manager off leaves every live entry exactly as before; the service itself is always available for
 * the manager's own reads.
 */
@Module({
  imports: [PrismaModule],
  providers: [
    { provide: DESK_MANAGER_CONFIG, useFactory: () => parseDeskManagerConfig(process.env) },
    DeskDayRepository,
    DeskGuardService,
    {
      provide: DESK_GUARD,
      useFactory: (cfg: DeskManagerConfig, svc: DeskGuardService) => (cfg.mode === 'off' ? null : svc),
      inject: [DESK_MANAGER_CONFIG, DeskGuardService],
    },
  ],
  exports: [DESK_MANAGER_CONFIG, DeskDayRepository, DeskGuardService, DESK_GUARD],
})
export class DeskGuardModule {}
