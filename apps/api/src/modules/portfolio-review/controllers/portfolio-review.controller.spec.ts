import { NotFoundException } from '@nestjs/common';
import { PortfolioReviewController } from './portfolio-review.controller';

describe('PortfolioReviewController', () => {
  const service = {
    latest: jest.fn().mockResolvedValue({ review: null }),
    startRun: jest.fn().mockResolvedValue({ run: { id: 'r1', status: 'RUNNING' } }),
    runStatus: jest.fn().mockResolvedValue(null),
    reviewQuota: jest.fn().mockResolvedValue({ allowed: true }),
    history: jest.fn().mockResolvedValue([]),
  };
  const c = new PortfolioReviewController(service as never);
  beforeEach(() => jest.clearAllMocks());

  it('GET / reads the latest stored review only — it never starts a run', async () => {
    await c.latest('u1');
    expect(service.latest).toHaveBeenCalledWith('u1');
    expect(service.startRun).not.toHaveBeenCalled();
  });

  it('POST /run starts a run for the caller', async () => {
    await c.run({ userId: 'u1', role: 'ADMIN' } as never);
    expect(service.startRun).toHaveBeenCalledWith({ userId: 'u1', role: 'ADMIN' });
  });

  it('GET /runs/:id is scoped to the caller and 404s when unknown', async () => {
    await expect(c.runStatus('u1', 'nope')).rejects.toBeInstanceOf(NotFoundException);
    expect(service.runStatus).toHaveBeenCalledWith('u1', 'nope');
  });
});
