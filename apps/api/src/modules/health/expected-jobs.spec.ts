import { MTF_INTEREST_JOB } from '../trade-core/execution/mtf-interest.cron';
import { CORE_BROKER_CORPUS_JOB } from '../trade-core/journal/broker-corpus.cron';
import { CORE_RECON_JOB } from '../trade-core/journal/core-reconciler.service';
import { CORE_SKIP_FOLLOWUP_JOB } from '../trade-core/journal/skip-followup.cron';
import { EXPECTED_JOBS } from './health-detail.service';

describe('EXPECTED_JOBS (M3 note, M5 D11)', () => {
  it('lists the four trade-core jobs, so a job that never ran shows as stale on /healthz/detail', () => {
    expect(EXPECTED_JOBS).toEqual(expect.arrayContaining([MTF_INTEREST_JOB, CORE_RECON_JOB, CORE_SKIP_FOLLOWUP_JOB, CORE_BROKER_CORPUS_JOB]));
  });
});
