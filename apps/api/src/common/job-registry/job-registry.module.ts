import { Global, Module } from '@nestjs/common';
import { CronLeaseModule } from '../cron-lease/cron-lease.module';
import { JobRunRepository } from './job-run.repository';
import { JobRunnerService } from './job-runner.service';

/**
 * Global because Plan 2 routes ~12 jobs across ~10 feature modules through
 * `JobRunnerService`, and a per-module import list is one more place for a job
 * to be quietly left out.
 */
@Global()
@Module({
  imports: [CronLeaseModule],
  providers: [JobRunRepository, JobRunnerService],
  exports: [JobRunRepository, JobRunnerService],
})
export class JobRegistryModule {}
