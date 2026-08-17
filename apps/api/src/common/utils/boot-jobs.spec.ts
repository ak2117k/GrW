import { bootJobsEnabled } from './boot-jobs';

describe('bootJobsEnabled', () => {
  const original = process.env.BOOT_JOBS;
  afterEach(() => {
    if (original === undefined) delete process.env.BOOT_JOBS;
    else process.env.BOOT_JOBS = original;
  });

  it('defaults to ON, so the API server is unchanged by this flag existing', () => {
    delete process.env.BOOT_JOBS;
    expect(bootJobsEnabled()).toBe(true);
  });

  it('is off ONLY for the exact string "false"', () => {
    process.env.BOOT_JOBS = 'false';
    expect(bootJobsEnabled()).toBe(false);

    // A typo must fail SAFE — towards the server behaving normally, never
    // towards a production deploy silently running no crons at all.
    for (const value of ['False', '0', 'no', 'off', '']) {
      process.env.BOOT_JOBS = value;
      expect(bootJobsEnabled()).toBe(true);
    }
  });

  it('is read at call time, not captured at import', () => {
    // Boot order is not something a caller controls; a value captured at import
    // would be whatever happened to be set when the module graph loaded.
    process.env.BOOT_JOBS = 'false';
    expect(bootJobsEnabled()).toBe(false);
    process.env.BOOT_JOBS = 'true';
    expect(bootJobsEnabled()).toBe(true);
  });
});
