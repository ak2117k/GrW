import { Logger } from '@nestjs/common';
import { TelegramOutboxRegistrar } from './telegram-outbox.registrar';
import { recordTelegramSend, setTelegramOutboxRecorder } from '../utils/telegram-outbox';
import type { PrismaService } from './prisma.service';

const entry = { kind: 'ops', source: 'k', method: 'sendMessage', chatId: '42', text: 'hi', ok: true, messageId: 5 };
const flush = () => new Promise((r) => setImmediate(r));

describe('TelegramOutboxRegistrar', () => {
  afterEach(() => setTelegramOutboxRecorder(null));

  it('on boot, every recorded send becomes a telegram_outbox insert', async () => {
    const create = jest.fn().mockResolvedValue({});
    const reg = new TelegramOutboxRegistrar({ telegramOutbox: { create } } as unknown as PrismaService);
    reg.onModuleInit();
    recordTelegramSend(entry);
    await flush();
    expect(create).toHaveBeenCalledWith({
      data: { kind: 'ops', source: 'k', method: 'sendMessage', chatId: '42', text: 'hi', ok: true, error: null, messageId: 5 },
    });
    reg.onModuleDestroy();
    recordTelegramSend(entry);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('a failed insert is warned at most once per 10 min and never thrown', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const create = jest.fn().mockRejectedValue(new Error('relation "telegram_outbox" does not exist'));
    new TelegramOutboxRegistrar({ telegramOutbox: { create } } as unknown as PrismaService).onModuleInit();
    expect(() => {
      recordTelegramSend(entry);
      recordTelegramSend(entry);
    }).not.toThrow();
    await flush();
    expect(create).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/telegram_outbox write failed \(send not affected\)/);
    warn.mockRestore();
  });
});
