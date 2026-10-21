import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { SELF_REVIEW_REPORT } from './self-review.ports';
import { SelfReviewModule } from './self-review.module';
import { SelfReviewRunService } from './services/self-review-run.service';
import { SelfReviewService } from './services/self-review.service';
import { TUNING_READER } from './tuning/tunables';
import { TuningService } from './tuning/tuning.service';

const prisma = { tuningOverride: { findMany: jest.fn(async () => [{ target: 'scorecard.factor.oi.weight', value: 0.5 }]) } };

@Global()
@Module({ providers: [{ provide: PrismaService, useValue: prisma }], exports: [PrismaService] })
class FakePrismaModule {}

describe('SelfReviewModule wiring', () => {
  it('resolves without stream B, serves TUNING_READER and SELF_REVIEW_REPORT', async () => {
    const ref = await Test.createTestingModule({ imports: [SelfReviewModule] })
      .overrideModule(PrismaModule)
      .useModule(FakePrismaModule)
      .compile();
    await ref.init();
    expect(ref.get(SelfReviewRunService)).toBeInstanceOf(SelfReviewRunService);
    expect(ref.get(SELF_REVIEW_REPORT)).toBe(ref.get(SelfReviewService));
    expect(ref.get(TUNING_READER)).toBe(ref.get(TuningService));
    expect(ref.get(TuningService).get('scorecard.factor.oi.weight', 1)).toBe(0.5);
    await ref.close();
  });
});
