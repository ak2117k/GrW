import { SignalIntakeRepository } from './signal-intake.repository';

describe('SignalIntakeRepository.saveClass — telegram_messages.parseStatus mirrors the class (audit 2026-11-27: always "pending")', () => {
  const make = (o: { failParse?: boolean } = {}) => {
    const prisma = {
      signalMessageClass: { upsert: jest.fn(async () => undefined) },
      telegramMessage: {
        updateMany: jest.fn(async () => {
          if (o.failParse) throw new Error('db down');
          return { count: 1 };
        }),
      },
    };
    return { repo: new SignalIntakeRepository(prisma as never), prisma };
  };
  const row = { messageId: 'tm1', channelId: 'ch1', postedAt: new Date('2026-11-27T04:00:00Z'), textHash: 'h', status: 'RECAP' as const, reason: 'result: gains done' };

  it('writes the class row, then sets parseStatus to the class', async () => {
    const { repo, prisma } = make();
    await repo.saveClass(row);
    expect(prisma.signalMessageClass.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.telegramMessage.updateMany).toHaveBeenCalledWith({ where: { id: 'tm1', NOT: { parseStatus: 'RECAP' } }, data: { parseStatus: 'RECAP' } });
  });

  it('a parseStatus write failure never fails the class write', async () => {
    const { repo, prisma } = make({ failParse: true });
    await expect(repo.saveClass(row)).resolves.toBeUndefined();
    expect(prisma.signalMessageClass.upsert).toHaveBeenCalledTimes(1);
  });
});
