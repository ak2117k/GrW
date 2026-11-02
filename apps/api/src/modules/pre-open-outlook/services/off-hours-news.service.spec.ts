import { OffHoursNewsService } from './off-hours-news.service';

describe('OffHoursNewsService', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  it('enqueues the existing news-fetch job off-hours only, and honours the switches', async () => {
    const queue = { add: jest.fn(async () => ({})) };
    const svc = new OffHoursNewsService(queue as never);
    delete process.env.BOOT_JOBS;
    delete process.env.NEWS_OFFHOURS_FETCH;
    expect(await svc.enqueue(new Date('2026-10-31T14:00:00+05:30'))).toBe(true); // Saturday
    expect(await svc.enqueue(new Date('2026-11-02T10:00:00+05:30'))).toBe(false); // weekday session: regular fetch runs
    process.env.NEWS_OFFHOURS_FETCH = 'off';
    expect(await svc.enqueue(new Date('2026-10-31T14:00:00+05:30'))).toBe(false);
    delete process.env.NEWS_OFFHOURS_FETCH;
    process.env.BOOT_JOBS = 'false';
    expect(await svc.enqueue(new Date('2026-10-31T14:00:00+05:30'))).toBe(false);
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('a queue failure is logged, not thrown', async () => {
    delete process.env.BOOT_JOBS;
    const svc = new OffHoursNewsService({ add: jest.fn(async () => Promise.reject(new Error('redis down'))) } as never);
    await expect(svc.enqueue(new Date('2026-11-01T03:00:00+05:30'))).resolves.toBe(false);
  });
});
