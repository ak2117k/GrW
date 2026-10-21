import { Global, Module } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { TUNING_READER } from './tunables';
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
  ],
  exports: [TuningService, TUNING_READER],
})
export class SelfReviewTuningModule {}
