import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { SELF_REVIEW_DIAGNOSIS, SELF_REVIEW_LESSONS, SELF_REVIEW_REPORT } from './self-review.ports';
import { SelfReviewDiagnosisAdapter } from './diagnose/self-review-diagnosis.adapter';
import { LessonsService } from './lessons/lessons.service';
import { LESSONS_READER } from './lessons/types';
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
  it('resolves with stream B bound, serves TUNING_READER and SELF_REVIEW_REPORT', async () => {
    // ConfigModule is global in the app; stream B's transport factory reads it.
    const ref = await Test.createTestingModule({ imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), SelfReviewModule] })
      .overrideModule(PrismaModule)
      .useModule(FakePrismaModule)
      .compile();
    await ref.init();
    expect(ref.get(SelfReviewRunService)).toBeInstanceOf(SelfReviewRunService);
    expect(ref.get(SELF_REVIEW_REPORT)).toBe(ref.get(SelfReviewService));
    expect(ref.get(TUNING_READER)).toBe(ref.get(TuningService));
    expect(ref.get(TuningService).get('scorecard.factor.oi.weight', 1)).toBe(0.5);
    // Stream B: the diagnosis + lessons ports, and the @Global lessons reader for the sentinel / news ideas.
    expect(ref.get(SELF_REVIEW_DIAGNOSIS)).toBeInstanceOf(SelfReviewDiagnosisAdapter);
    expect(ref.get(SELF_REVIEW_LESSONS)).toBe(ref.get(LessonsService));
    expect(ref.get(LESSONS_READER)).toBe(ref.get(LessonsService));
    await ref.close();
  });
});
