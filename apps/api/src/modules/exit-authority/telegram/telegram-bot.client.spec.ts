import { TelegramApiError, TelegramBotClient } from './telegram-bot.client';

const TOKEN = '123456:SECRET-token-value';
const env = { TELEGRAM_ALERT_BOT_TOKEN: TOKEN, TELEGRAM_ALERT_CHAT_ID: '-100777' };

function reply(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function client(fetchImpl: jest.Mock, e: Record<string, string | undefined> = env) {
  return new TelegramBotClient({ env: e, fetch: fetchImpl });
}

describe('TelegramBotClient', () => {
  it('sendMessage posts to /bot<token>/sendMessage with an inline keyboard and returns message_id', async () => {
    const f = jest.fn().mockResolvedValue(reply({ ok: true, result: { message_id: 42 } }));
    const id = await client(f).sendMessage('hello', [
      [
        { text: 'Exit', data: 'x:a1' },
        { text: 'Hold', data: 'h:a1' },
      ],
    ]);
    expect(id).toBe(42);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    const body = JSON.parse(init.body);
    expect(body.chat_id).toBe('-100777');
    expect(body.text).toBe('hello');
    expect(body.reply_markup.inline_keyboard).toEqual([
      [
        { text: 'Exit', callback_data: 'x:a1' },
        { text: 'Hold', callback_data: 'h:a1' },
      ],
    ]);
  });

  it('never puts the token in a thrown error (API error and network error)', async () => {
    const apiErr = jest.fn().mockResolvedValue(reply({ ok: false, description: `Unauthorized ${TOKEN}` }, 401));
    const e1 = await client(apiErr).sendMessage('x').catch((e) => e);
    expect(e1).toBeInstanceOf(TelegramApiError);
    expect(String(e1.message)).not.toContain(TOKEN);
    expect(String(e1.stack)).not.toContain(TOKEN);

    const netErr = jest.fn().mockRejectedValue(new Error(`connect ECONNREFUSED https://api.telegram.org/bot${TOKEN}/sendMessage`));
    const e2 = await client(netErr).sendMessage('x').catch((e) => e);
    expect(e2).toBeInstanceOf(TelegramApiError);
    expect(String(e2.message)).not.toContain(TOKEN);
    expect(String(e2.message)).toContain('<redacted>');
  });

  it('a missing token is an error without any fetch', async () => {
    const f = jest.fn();
    await expect(client(f, { TELEGRAM_ALERT_CHAT_ID: '1' }).sendMessage('x')).rejects.toThrow('TELEGRAM_ALERT_BOT_TOKEN missing');
    expect(f).not.toHaveBeenCalled();
  });

  it('editMessage edits text and buttons; "message is not modified" is not an error', async () => {
    const f = jest
      .fn()
      .mockResolvedValueOnce(reply({ ok: true, result: true }))
      .mockResolvedValueOnce(reply({ ok: false, description: 'Bad Request: message is not modified' }, 400));
    const c = client(f);
    await c.editMessage(42, 'updated', [[{ text: 'Exit', data: 'x:a1' }]]);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/editMessageText`);
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ chat_id: '-100777', message_id: 42, text: 'updated' });
    expect(body.reply_markup.inline_keyboard).toEqual([[{ text: 'Exit', callback_data: 'x:a1' }]]);
    await expect(c.editMessage(42, 'updated')).resolves.toBeUndefined();
  });

  it('deleteMessage posts deleteMessage for the configured chat', async () => {
    const f = jest.fn().mockResolvedValue(reply({ ok: true, result: true }));
    await client(f).deleteMessage(42);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/deleteMessage`);
    expect(JSON.parse(init.body)).toEqual({ chat_id: '-100777', message_id: 42 });
  });

  it('answerCallback posts answerCallbackQuery', async () => {
    const f = jest.fn().mockResolvedValue(reply({ ok: true, result: true }));
    await client(f).answerCallback('cq1', 'Exit sent');
    const [url, init] = f.mock.calls[0];
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/answerCallbackQuery`);
    expect(JSON.parse(init.body)).toEqual({ callback_query_id: 'cq1', text: 'Exit sent' });
  });

  it('getUpdates(offset, 25) long-polls and returns the callback queries', async () => {
    const updates = [{ update_id: 7, callback_query: { id: 'cq', data: 'x:a1', message: { message_id: 42, chat: { id: -100777 } } } }];
    const f = jest.fn().mockResolvedValue(reply({ ok: true, result: updates }));
    const got = await client(f).getUpdates(5, 25);
    expect(got).toEqual(updates);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/getUpdates`);
    expect(JSON.parse(init.body)).toEqual({ offset: 5, timeout: 25, allowed_updates: ['callback_query'] });
  });
});
