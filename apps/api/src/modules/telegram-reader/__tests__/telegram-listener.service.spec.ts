import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TELEGRAM_MESSAGE_EVENT } from '../telegram-reader.events';
import { TelegramListenerService, backoffMs, readerEnabled } from '../services/telegram-listener.service';
import { TgIncomingMessage } from '../client/telegram-client.port';
import { FakeTgClient } from './fake-client';

function msg(over: Partial<TgIncomingMessage> = {}): TgIncomingMessage {
  return {
    chatId: '-1001',
    tgMessageId: 10,
    date: 1_760_000_000,
    editDate: null,
    text: 'BUY NIFTY 25000 CE above 120 SL 100',
    hasMedia: false,
    edited: false,
    raw: { id: 10 },
    ...over,
  };
}

function build(opts: { flag?: string; session?: boolean; env?: Record<string, string> } = {}) {
  const messages = new Map<string, any>();
  let seq = 0;
  const prisma = {
    telegramChannel: {
      findMany: jest.fn(async () => [{ id: 'ch1', tgChannelId: '-1001', title: 'Alpha' }]),
    },
    telegramMessage: {
      findUnique: jest.fn(async ({ where }: any) => {
        const k = `${where.channelId_tgMessageId.channelId}:${where.channelId_tgMessageId.tgMessageId}`;
        return messages.get(k) ?? null;
      }),
      create: jest.fn(async ({ data }: any) => {
        const k = `${data.channelId}:${data.tgMessageId}`;
        if (messages.has(k)) throw Object.assign(new Error('dup'), { code: 'P2002' });
        const row = { id: `m${++seq}`, ...data };
        messages.set(k, row);
        return { id: row.id };
      }),
      update: jest.fn(async ({ where, data }: any) => {
        for (const r of messages.values()) if (r.id === where.id) Object.assign(r, data);
      }),
    },
  };
  const events = { emit: jest.fn() };
  const store = {
    findListenable: jest.fn(async () =>
      opts.session === false
        ? null
        : { userId: 'u1', apiId: 1, phoneMasked: '••10', status: 'connected', lastError: null, connectedAt: new Date() },
    ),
    withSecrets: jest.fn(async (_u: string, use: any) => use({ apiHash: 'h', session: 's' })),
    markStatus: jest.fn(async () => undefined),
  };
  const client = new FakeTgClient();
  const factory = { create: jest.fn(() => client) };
  const config = {
    get: (k: string) => (k === 'TELEGRAM_READER' ? opts.flag : k === 'HUB_OWNER_USER_ID' ? 'u1' : opts.env?.[k]),
  };
  const svc = new TelegramListenerService(config as any, prisma as any, events as any, store as any, factory as any);
  return { svc, prisma, events, store, client, factory, messages };
}

describe('TelegramListenerService', () => {
  afterEach(() => jest.useRealTimers());

  it('opens the stored session, subscribes, persists then emits for enabled channels only', async () => {
    const { svc, client, events, prisma } = build();
    await svc.start();
    expect(svc.status().state).toBe('listening');
    expect(client.handler).toBeTruthy();

    await svc.handle(msg({ chatId: '-1999' })); // not enabled
    expect(prisma.telegramMessage.create).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();

    await svc.handle(msg());
    expect(prisma.telegramMessage.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ channelId: 'ch1', tgMessageId: 10, parseStatus: 'pending', hasMedia: false }),
      }),
    );
    const createOrder = prisma.telegramMessage.create.mock.invocationCallOrder[0];
    expect(events.emit.mock.invocationCallOrder[0]).toBeGreaterThan(createOrder);
    expect(events.emit).toHaveBeenCalledWith(TELEGRAM_MESSAGE_EVENT, {
      messageId: 'm1',
      channelId: 'ch1',
      postedAt: new Date(1_760_000_000 * 1000),
      text: 'BUY NIFTY 25000 CE above 120 SL 100',
      hasMedia: false,
      edited: false,
    });
  });

  it('dedups duplicate deliveries and re-emits only edits that change the text', async () => {
    const { svc, events, messages } = build();
    await svc.start();
    await svc.handle(msg());
    await svc.handle(msg()); // same delivery again
    expect(events.emit).toHaveBeenCalledTimes(1);

    await svc.handle(msg({ edited: true, editDate: 1_760_000_100, text: 'BUY NIFTY 25000 CE above 125 SL 100' }));
    expect(events.emit).toHaveBeenCalledTimes(2);
    expect(events.emit.mock.calls[1][1]).toMatchObject({ messageId: 'm1', edited: true });
    expect([...messages.values()][0].editedAt).toEqual(new Date(1_760_000_100 * 1000));

    await svc.handle(msg({ edited: true, text: 'BUY NIFTY 25000 CE above 125 SL 100' })); // no-op edit
    expect(events.emit).toHaveBeenCalledTimes(2);
  });

  it('is inert without a session and off with TELEGRAM_READER=off', async () => {
    const a = build({ session: false });
    await a.svc.start();
    expect(a.factory.create).not.toHaveBeenCalled();
    expect(a.svc.status().state).toBe('idle');

    const b = build({ flag: 'off' });
    await b.svc.start();
    expect(b.factory.create).not.toHaveBeenCalled();
    expect(b.svc.status().state).toBe('off');
  });

  it('FLOOD_WAIT on connect backs off for the time Telegram asks', async () => {
    jest.useFakeTimers();
    const { svc, client, factory } = build();
    client.connectError = Object.assign(new Error('flood'), { errorMessage: 'FLOOD_WAIT_X', seconds: 30 });
    await svc.start();
    expect(svc.status().state).toBe('backoff');
    client.connectError = null;
    await jest.advanceTimersByTimeAsync(29_000);
    expect(factory.create).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(2_000);
    expect(factory.create).toHaveBeenCalledTimes(2);
    expect(svc.status().state).toBe('listening');
    await svc.stop();
  });

  it('a revoked session stops retrying and marks the row', async () => {
    const { svc, client, store } = build();
    client.connectError = Object.assign(new Error('x'), { errorMessage: 'AUTH_KEY_UNREGISTERED' });
    await svc.start();
    expect(svc.status().state).toBe('revoked');
    expect(store.markStatus).toHaveBeenCalledWith('u1', 'revoked', 'AUTH_KEY_UNREGISTERED');
  });

  it('10-min summary counts every update received (any chat) and stored messages per ticked channel, then resets', async () => {
    const { svc } = build();
    await svc.start();
    await svc.handle(msg());
    await svc.handle(msg({ tgMessageId: 11, text: 'x' }));
    await svc.handle(msg({ chatId: '-100999', tgMessageId: 12, text: 'not ticked' }));
    const first = svc.logSummary();
    expect(first).toContain('received=3');
    expect(first).toContain('stored=2');
    expect(first).toContain('Alpha=2');
    expect(svc.logSummary()).toContain('received=0 (live push, any chat) polled_new=0 stored=0');
  });

  it('subscribes for live updates on connect, and the poller stores posts push missed exactly once', async () => {
    const { svc, client, events } = build();
    const c = client as any;
    c.subscribeUpdates = jest.fn(async () => undefined);
    c.recentMessages = jest.fn(async () => [msg({ tgMessageId: 21, text: 'b' }), msg({ tgMessageId: 20, text: 'a' })]);
    await svc.start();
    expect(c.subscribeUpdates).toHaveBeenCalledTimes(1);
    expect(await svc.pollOnce()).toBe(2);
    expect(await svc.pollOnce()).toBe(0);              // dedup: already stored
    expect(events.emit).toHaveBeenCalledTimes(2);
    expect(c.recentMessages).toHaveBeenCalledWith('-1001', 5);
    const line = svc.logSummary();
    expect(line).toContain('received=0 (live push');    // polled posts do not count as live pushes
    expect(line).toContain('polled_new=2');
    await svc.stop();
  });

  it('flag parsing and backoff', () => {
    expect(readerEnabled(undefined)).toBe(true);
    expect(readerEnabled('on')).toBe(true);
    expect(readerEnabled('OFF')).toBe(false);
    expect(backoffMs(0)).toBe(5_000);
    expect(backoffMs(20)).toBe(300_000);
  });
});

describe('TelegramListenerService — post images (2026-10-23)', () => {
  const photo = {
    kind: 'photo' as const,
    mimeType: 'image/jpeg',
    sizeBytes: null,
    sizes: [
      { type: 'x', w: 800, h: 600, bytes: 60_000 },
      { type: 'y', w: 1280, h: 960, bytes: 140_000 },
      { type: 'w', w: 2560, h: 1920, bytes: 1_500_000 },
    ],
  };
  const tmp = () => mkdtempSync(join(tmpdir(), 'tg-media-'));

  it('downloads the smallest readable photo size, saves it, keeps path + sha256 in rawPayload, emits media', async () => {
    const { svc, prisma, events } = build({ env: { TELEGRAM_MEDIA_DIR: tmp() } });
    await svc.start();
    const download = jest.fn(async () => Buffer.from('jpeg-bytes'));
    await svc.handle(msg({ text: '', hasMedia: true, media: photo, download }));
    expect(download).toHaveBeenCalledWith('y');
    const data = (prisma.telegramMessage.create.mock.calls[0] as any[])[0].data;
    expect(data.rawPayload.media).toMatchObject({ kind: 'photo', sizeType: 'y', width: 1280, mimeType: 'image/jpeg', bytes: 10 });
    expect(data.rawPayload.media.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(data.rawPayload.media.path, 'utf8')).toBe('jpeg-bytes');
    expect(events.emit.mock.calls[0][1].media).toMatchObject({ kind: 'photo', path: data.rawPayload.media.path, sha256: data.rawPayload.media.sha256 });
  });

  it.each([
    ['video', { kind: 'video' as const, mimeType: 'video/mp4', sizeBytes: 900_000, sizes: [] }],
    ['sticker', { kind: 'sticker' as const, mimeType: 'image/webp', sizeBytes: 30_000, sizes: [] }],
    ['gif', { kind: 'gif' as const, mimeType: 'video/mp4', sizeBytes: 200_000, sizes: [] }],
    ['a 3 MB image document', { kind: 'image-document' as const, mimeType: 'image/png', sizeBytes: 3_000_000, sizes: [] }],
    ['a pdf', { kind: 'document' as const, mimeType: 'application/pdf', sizeBytes: 100_000, sizes: [] }],
  ])('%s is not downloaded; the skip reason is kept, the text still stored and emitted', async (_why, media) => {
    const { svc, prisma, events } = build({ env: { TELEGRAM_MEDIA_DIR: tmp() } });
    await svc.start();
    const download = jest.fn(async () => Buffer.from('x'));
    await svc.handle(msg({ hasMedia: true, media, download }));
    expect(download).not.toHaveBeenCalled();
    expect((prisma.telegramMessage.create.mock.calls[0] as any[])[0].data.rawPayload.media).toMatchObject({ kind: media.kind, skipped: expect.any(String) });
    expect(events.emit.mock.calls[0][1].media).toBeUndefined();
  });

  it('an empty download is retried (prod 2026-10-27: ~60% of images came back empty on the first try)', async () => {
    const { svc, prisma, events } = build({ env: { TELEGRAM_MEDIA_DIR: tmp() } });
    (svc as any).mediaRetryDelaysMs = [0, 0];
    await svc.start();
    const download = jest.fn().mockResolvedValueOnce(Buffer.alloc(0)).mockResolvedValueOnce(null).mockResolvedValueOnce(Buffer.from('jpeg-bytes'));
    await svc.handle(msg({ text: '', hasMedia: true, media: photo, download }));
    expect(download).toHaveBeenCalledTimes(3);
    const data = (prisma.telegramMessage.create.mock.calls[0] as any[])[0].data;
    expect(data.rawPayload.media).toMatchObject({ kind: 'photo', bytes: 10, attempts: 3 });
    expect(events.emit.mock.calls[0][1].media).toMatchObject({ kind: 'photo' });
  });

  it('still empty after the retries: recorded with the attempt count', async () => {
    const { svc, prisma } = build({ env: { TELEGRAM_MEDIA_DIR: tmp() } });
    (svc as any).mediaRetryDelaysMs = [0, 0];
    await svc.start();
    const download = jest.fn(async () => Buffer.alloc(0));
    await svc.handle(msg({ text: '', hasMedia: true, media: photo, download }));
    expect(download).toHaveBeenCalledTimes(3);
    expect((prisma.telegramMessage.create.mock.calls[0] as any[])[0].data.rawPayload.media).toMatchObject({ skipped: 'empty download', attempts: 3 });
  });

  it('a failed download never loses the message', async () => {
    const { svc, prisma, events } = build({ env: { TELEGRAM_MEDIA_DIR: tmp() } });
    await svc.start();
    const download = jest.fn(async (): Promise<Buffer> => {
      throw new Error('FILE_REFERENCE_EXPIRED');
    });
    await svc.handle(msg({ hasMedia: true, media: photo, download }));
    expect(prisma.telegramMessage.create).toHaveBeenCalledTimes(1);
    expect((prisma.telegramMessage.create.mock.calls[0] as any[])[0].data.rawPayload.media).toMatchObject({ error: expect.stringContaining('FILE_REFERENCE_EXPIRED') });
    expect(events.emit).toHaveBeenCalledTimes(1);
  });

  it('a caption edit keeps the saved image (no second download)', async () => {
    const { svc, prisma, events } = build({ env: { TELEGRAM_MEDIA_DIR: tmp() } });
    await svc.start();
    const download = jest.fn(async () => Buffer.from('jpeg'));
    await svc.handle(msg({ text: 'crude', hasMedia: true, media: photo, download }));
    await svc.handle(msg({ text: 'crude call', hasMedia: true, media: photo, download, edited: true, editDate: 1_760_000_100 }));
    expect(download).toHaveBeenCalledTimes(1);
    const upd = (prisma.telegramMessage.update.mock.calls[0] as any[])[0].data;
    expect(upd.rawPayload.media.path).toBe(events.emit.mock.calls[0][1].media.path);
    expect(events.emit.mock.calls[1][1]).toMatchObject({ edited: true, media: expect.objectContaining({ kind: 'photo' }) });
  });

  it('TELEGRAM_MEDIA_DOWNLOAD=off records the media kind only', async () => {
    const { svc, prisma } = build({ env: { TELEGRAM_MEDIA_DOWNLOAD: 'off' } });
    await svc.start();
    const download = jest.fn(async () => Buffer.from('x'));
    await svc.handle(msg({ hasMedia: true, media: photo, download }));
    expect(download).not.toHaveBeenCalled();
    expect((prisma.telegramMessage.create.mock.calls[0] as any[])[0].data.rawPayload.media).toMatchObject({ skipped: 'TELEGRAM_MEDIA_DOWNLOAD=off' });
  });
});
