import { OptionsChainService } from './options-chain.service';
import { GreeksCalculatorService } from './greeks-calculator.service';
import { retentionCutoff, retentionDaysFromEnv } from '../../../common/utils/retention';

/**
 * option_chain_snapshots is the OI history the models and the agent train on.
 * Owner decision 2026-10-21: keep it all unless OPTION_CHAIN_RETENTION_DAYS is
 * set to a positive number of days.
 */
function makeService() {
  const deleteMany = jest.fn().mockResolvedValue({ count: 3 });
  const prisma = { optionChainSnapshot: { deleteMany } } as any;
  const svc = new OptionsChainService(prisma, new GreeksCalculatorService(), {} as any, null, {} as any, null);
  return { svc, deleteMany };
}

describe('OptionsChainService.cleanupOldSnapshots — retention', () => {
  const saved = process.env.OPTION_CHAIN_RETENTION_DAYS;
  afterEach(() => {
    jest.useRealTimers();
    if (saved === undefined) delete process.env.OPTION_CHAIN_RETENTION_DAYS;
    else process.env.OPTION_CHAIN_RETENTION_DAYS = saved;
  });

  it.each([undefined, '', '0', '-1', 'forever'])('OPTION_CHAIN_RETENTION_DAYS=%p keeps every snapshot', async (raw) => {
    if (raw === undefined) delete process.env.OPTION_CHAIN_RETENTION_DAYS;
    else process.env.OPTION_CHAIN_RETENTION_DAYS = raw;
    const { svc, deleteMany } = makeService();
    await svc.cleanupOldSnapshots();
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it('a positive value deletes only snapshots older than that many days', async () => {
    process.env.OPTION_CHAIN_RETENTION_DAYS = '30';
    jest.useFakeTimers().setSystemTime(new Date('2026-10-21T00:00:00Z'));
    const { svc, deleteMany } = makeService();
    await svc.cleanupOldSnapshots();
    expect(deleteMany).toHaveBeenCalledWith({
      where: { capturedAt: { lt: new Date('2026-09-21T00:00:00.000Z') } },
    });
  });

  it('a failed delete never throws out of the cron', async () => {
    process.env.OPTION_CHAIN_RETENTION_DAYS = '30';
    const { svc, deleteMany } = makeService();
    deleteMany.mockRejectedValue(new Error('db down'));
    await expect(svc.cleanupOldSnapshots()).resolves.toBeUndefined();
  });
});

describe('retentionDaysFromEnv / retentionCutoff', () => {
  it('reads whole positive days; everything else is keep-forever (0)', () => {
    expect(retentionDaysFromEnv('45')).toBe(45);
    expect(retentionDaysFromEnv(' 7.9 ')).toBe(7);
    for (const raw of [undefined, '', '  ', '0', '-3', 'NaN', 'x']) expect(retentionDaysFromEnv(raw)).toBe(0);
  });

  it('0 days has no cutoff; n days is n×24h before now', () => {
    expect(retentionCutoff(0)).toBeNull();
    expect(retentionCutoff(2, new Date('2026-10-21T00:00:00Z'))).toEqual(new Date('2026-10-19T00:00:00Z'));
  });
});
