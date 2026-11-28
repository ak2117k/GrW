import { OUTBOX_TEXT_MAX, recordTelegramSend, setTelegramOutboxRecorder, toOutboxRow, type TelegramOutboxRow } from './telegram-outbox';

const base = { kind: 'ops', source: 'k', method: 'sendMessage', chatId: '42', text: 'hello', ok: true, messageId: 7 };

describe('telegram outbox', () => {
  afterEach(() => setTelegramOutboxRecorder(null));

  it('is a no-op with no recorder registered', () => {
    expect(() => recordTelegramSend(base)).not.toThrow();
  });

  it('builds a row: text cut to 500 chars, token stripped from text and error, message id kept', () => {
    const row = toOutboxRow(
      { ...base, text: `tok SECRET ${'x'.repeat(900)}`, ok: false, error: 'HTTP 401 for botSECRET', messageId: null },
      ['SECRET'],
    );
    expect(row.text.length).toBe(OUTBOX_TEXT_MAX);
    expect(row.text).not.toContain('SECRET');
    expect(row.error).toBe('HTTP 401 for bot<redacted>');
    expect(row.messageId).toBeNull();
    expect(toOutboxRow(base).messageId).toBe(7);
    expect(toOutboxRow(base).error).toBeNull();
  });

  it('cuts text by code point, never leaving half an emoji (a lone surrogate fails the insert)', () => {
    const row = toOutboxRow({ ...base, text: `${'a'.repeat(499)}😀😀tail` });
    expect(Array.from(row.text)).toHaveLength(OUTBOX_TEXT_MAX);
    expect(row.text.endsWith('a😀')).toBe(true);
    expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(row.text)).toBe(false);
  });

  it('hands the row to the recorder without waiting for it', () => {
    const rows: TelegramOutboxRow[] = [];
    let resolve!: () => void;
    setTelegramOutboxRecorder((r) => {
      rows.push(r);
      return new Promise<void>((res) => (resolve = res));
    });
    recordTelegramSend(base); // returns although the write is still pending
    expect(rows).toEqual([{ kind: 'ops', source: 'k', method: 'sendMessage', chatId: '42', text: 'hello', ok: true, error: null, messageId: 7 }]);
    resolve();
  });

  it('swallows a rejected write and a throwing recorder, reporting each to onError', async () => {
    const onError = jest.fn();
    setTelegramOutboxRecorder(() => Promise.reject(new Error('db down')), onError);
    expect(() => recordTelegramSend(base)).not.toThrow();
    await new Promise((r) => setImmediate(r));
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'db down' }));

    setTelegramOutboxRecorder(() => {
      throw new Error('sync boom');
    }, () => {
      throw new Error('reporter boom too');
    });
    expect(() => recordTelegramSend(base)).not.toThrow();
  });
});
