import { SignalTraderRepository } from './signal-trader.repository';

describe('expireStuckDecisions (2026-11-16: a claimed evaluation hung and blocked the queue)', () => {
  it('closes only claimed-but-undecided rows older than the cutoff, as SKIP evaluation_timeout', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const repo = new SignalTraderRepository({ signalDecision: { updateMany } } as never);
    const before = new Date('2026-11-16T04:00:00.000Z');
    await expect(repo.expireStuckDecisions(before)).resolves.toBe(1);
    const arg = updateMany.mock.calls[0][0];
    expect(arg.where).toEqual({ status: 'PENDING', decision: null, createdAt: { lt: before } });
    expect(arg.data).toMatchObject({ status: 'DONE', decision: 'SKIP', skipReason: 'evaluation_timeout' });
  });
});
