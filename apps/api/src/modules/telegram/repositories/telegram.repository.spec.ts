import { TelegramRepository } from './telegram.repository';

function makePrisma() {
  return {
    telegramChannel: { upsert: jest.fn().mockResolvedValue({ id: 'ch1' }) },
    telegramMessage: { create: jest.fn() },
  } as any;
}

describe('TelegramRepository.insertMessage', () => {
  it('returns null when the (channelId, tgMessageId) pair already exists', async () => {
    const prisma = makePrisma();
    prisma.telegramMessage.create.mockRejectedValue({ code: 'P2002' });
    const repo = new TelegramRepository(prisma);
    const res = await repo.insertMessage({
      channelId: 'ch1', tgMessageId: 1, rawText: 'x', postedAt: new Date(),
      parseStatus: 'signal', rawPayload: {},
    });
    expect(res).toBeNull();
  });

  it('returns the created row id on success', async () => {
    const prisma = makePrisma();
    prisma.telegramMessage.create.mockResolvedValue({ id: 'm1' });
    const repo = new TelegramRepository(prisma);
    const res = await repo.insertMessage({
      channelId: 'ch1', tgMessageId: 2, rawText: 'x', postedAt: new Date(),
      parseStatus: 'signal', rawPayload: {},
    });
    expect(res).toEqual({ id: 'm1' });
  });
});
