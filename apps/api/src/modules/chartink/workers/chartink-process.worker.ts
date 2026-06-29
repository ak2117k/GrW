import { Processor, Process } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';
import { ChartinkProcessService } from '../services/chartink-process.service';
import { ChartinkProcessJobData } from '../services/chartink-ingest.service';

@Processor('chartink-process')
export class ChartinkProcessWorker {
  private readonly logger = new Logger(ChartinkProcessWorker.name);

  constructor(private readonly process: ChartinkProcessService) {}

  // Bull default concurrency is 1 - Chartink alert jobs run strictly
  // serially, so the createFromAlert same-symbol reuse guard cannot race.
  // Do NOT raise concurrency without first making that guard atomic.
  @Process('process')
  async handle(job: Job<ChartinkProcessJobData>): Promise<void> {
    const { alertId, hits } = job.data;
    this.logger.log(`Worker received alert ${alertId} with ${hits.length} hits`);
    await this.process.processAlert(alertId, hits);
  }
}
