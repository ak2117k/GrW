import { schedulingImports } from './scheduling-imports';

/**
 * The one switch that keeps a one-shot process from running the application's
 * crons.
 *
 * Asserted at the MODULE level on purpose: `@Cron` schedules nothing unless
 * `ScheduleModule.forRoot()` is registered, so leaving it out disables every
 * cron in the app — including ones added long after this test was written.
 */
describe('schedulingImports', () => {
  const original = process.env.BOOT_JOBS;
  afterEach(() => {
    if (original === undefined) delete process.env.BOOT_JOBS;
    else process.env.BOOT_JOBS = original;
  });

  it('registers the scheduler normally', () => {
    delete process.env.BOOT_JOBS;
    expect(schedulingImports()).toHaveLength(1);
  });

  it('registers NOTHING when BOOT_JOBS=false, so no @Cron anywhere can fire', () => {
    // A script that booted the full app against PRODUCTION had the trade-tracker
    // cron fire from a laptop, over a broker session that could not authenticate,
    // and it closed tracker rows for positions still held. Suppressing the
    // onModuleInit work was not enough — the crons were the damage.
    process.env.BOOT_JOBS = 'false';
    expect(schedulingImports()).toEqual([]);
  });
});
