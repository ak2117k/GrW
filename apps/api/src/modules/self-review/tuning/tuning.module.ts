import { Global, Module } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { SESSION_TUNING, TUNING_READER } from './tunables';
import { SessionTuningService } from './session-tuning.service';
import { TuningService } from './tuning.service';

/**
 * `@Global` so the consumers (overnight-scorecard, sentinel-executor's exit gate) can inject
 * {@link TUNING_READER} with `@Optional()` without importing the self-review module — a module
 * booted without this one simply serves its own defaults.
 */
@Global()
@Module({
  providers: [
    { provide: TuningService, useFactory: (prisma: PrismaService) => TuningService.fromPrisma(prisma), inject: [PrismaService] },
    { provide: TUNING_READER, useExisting: TuningService },
    // 2026-11-05: the session-open reader for the wrong-decision loop's tunables (S7).
    { provide: SessionTuningService, useFactory: (prisma: PrismaService) => SessionTuningService.fromPrisma(prisma), inject: [PrismaService] },
    { provide: SESSION_TUNING, useExisting: SessionTuningService },
  ],
  exports: [TuningService, TUNING_READER, SessionTuningService, SESSION_TUNING],
})
export class SelfReviewTuningModule {}
