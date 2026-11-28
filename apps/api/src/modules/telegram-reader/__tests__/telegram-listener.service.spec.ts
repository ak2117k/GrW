import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TELEGRAM_MESSAGE_EVENT } from '../telegram-reader.events';
import { TelegramListenerService, backoffMs, readerEnabled } from '../services/telegram-listener.service';
import { TgIncomingMessage } from '../client/telegram-client.port';
import { FakeTgClient } from './fake-client';
import { Logger } from '@nestjs/common';
import { __resetOpsAlerts, sendOpsAlert } from '../../../common/utils/ops-alert';

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
      updateMany: jest.fn(async () => ({ count: 1 })),
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
  const alerts = jest.fn(async (_key: string, _text: string) => true);
  (svc as any).sendAlert = alerts;
  return { svc, prisma, events, store, client, factory, messages, alerts };
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

  it('every stored message moves the channel lastSeenMsgId forward (audit 2026-11-27: 0 for 6 of 8 channels)', async () => {
    const { svc, prisma } = build();
    await svc.start();
    await svc.handle(msg({ tgMessageId: 42, raw: { id: 42 } }));
    expect(prisma.telegramChannel.updateMany).toHaveBeenCalledWith({ where: { id: 'ch1', lastSeenMsgId: { lt: 42 } }, data: { lastSeenMsgId: 42 } });
    // A failed bookkeeping write never stops the message being emitted.
    prisma.telegramChannel.updateMany.mockRejectedValueOnce(new Error('db down'));
    await expect(svc.handle(msg({ tgMessageId: 43, raw: { id: 43 } }))).resolves.toBe(true);
    // A duplicate delivery stores nothing and moves nothing.
    prisma.telegramChannel.updateMany.mockClear();
    await svc.handle(msg({ tgMessageId: 42, raw: { id: 42 } }));
    expect(prisma.telegramChannel.updateMany).not.toHaveBeenCalled();
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
    // The first round after a (re)connect is the catch-up (deeper fetch); later rounds take the newest 5.
    expect(c.recentMessages.mock.calls).toEqual([['-1001', 100], ['-1001', 5]]);
    const line = svc.logSummary();
    expect(line).toContain('received=0 (live push');    // polled posts do not count as live pushes
    expect(line).toContain('polled_new=2');
    await svc.stop();
  });

  describe('poll cadence (2026-11-25 speed fix)', () => {
    const flood = (seconds: number) => Object.assign(new Error('flood'), { errorMessage: 'FLOOD_WAIT_X', seconds });

    function polled(env: Record<string, string> = {}) {
      const b = build({ env });
      const c = b.client as any;
      c.recentMessages = jest.fn(async () => []);
      return { ...b, c };
    }

    it('polls every 6 s by default', async () => {
      jest.useFakeTimers();
      const { svc, c } = polled();
      await svc.start();
      await jest.advanceTimersByTimeAsync(5_999);
      expect(c.recentMessages).toHaveBeenCalledTimes(0);
      await jest.advanceTimersByTimeAsync(1);
      expect(c.recentMessages).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(6_000);
      expect(c.recentMessages).toHaveBeenCalledTimes(2);
      await jest.advanceTimersByTimeAsync(60_000);
      expect(c.recentMessages).toHaveBeenCalledTimes(12);
      await svc.stop();
      await jest.advanceTimersByTimeAsync(60_000);
      expect(c.recentMessages).toHaveBeenCalledTimes(12); // stop clears the timer
    });

    it('TELEGRAM_POLL_SEC=3 is clamped to 5', async () => {
      jest.useFakeTimers();
      const { svc, c } = polled({ TELEGRAM_POLL_SEC: '3' });
      await svc.start();
      await jest.advanceTimersByTimeAsync(4_999);
      expect(c.recentMessages).toHaveBeenCalledTimes(0);
      await jest.advanceTimersByTimeAsync(1);
      expect(c.recentMessages).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(5_000);
      expect(c.recentMessages).toHaveBeenCalledTimes(2);
      await svc.stop();
    });

    it('FLOOD_WAIT 12 pauses polling 12 s then runs at double interval for 10 min', async () => {
      jest.useFakeTimers();
      const { svc, c, prisma } = polled();
      prisma.telegramChannel.findMany.mockResolvedValue([
        { id: 'ch1', tgChannelId: '-1001', title: 'Alpha' },
        { id: 'ch2', tgChannelId: '-1002', title: 'Beta' },
      ] as any);
      c.recentMessages.mockRejectedValueOnce(flood(12));
      const warn = jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);
      await svc.start();

      await jest.advanceTimersByTimeAsync(6_000); // round 1: first channel floods, rest of round skipped
      expect(c.recentMessages).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('12 s');

      await jest.advanceTimersByTimeAsync(11_999); // paused until 18 s
      expect(c.recentMessages).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1); // 18 s: polling resumes
      expect(c.recentMessages).toHaveBeenCalledTimes(3); // both channels

      await jest.advanceTimersByTimeAsync(11_999); // doubled interval: 12 s
      expect(c.recentMessages).toHaveBeenCalledTimes(3);
      await jest.advanceTimersByTimeAsync(1); // 30 s
      expect(c.recentMessages).toHaveBeenCalledTimes(5);

      // Slow window = 10 min from the end of the pause (18 s → 618 s): rounds at 18, 30, …, 606, 618.
      await jest.advanceTimersByTimeAsync(618_000 - 30_000);
      const atEndOfSlow = c.recentMessages.mock.calls.length;
      expect(atEndOfSlow).toBe(1 + 2 * (1 + (618 - 18) / 12)); // the flooded call + 51 rounds × 2 channels
      await jest.advanceTimersByTimeAsync(6_000); // back to the configured 6 s
      expect(c.recentMessages).toHaveBeenCalledTimes(atEndOfSlow + 2);
      await jest.advanceTimersByTimeAsync(6_000);
      expect(c.recentMessages).toHaveBeenCalledTimes(atEndOfSlow + 4);
      expect(warn).toHaveBeenCalledTimes(1);
      await svc.stop();
    });

    it('media backfill still runs about every 5 min at 6 s', async () => {
      jest.useFakeTimers();
      const { svc } = polled();
      const backfill = jest.spyOn(svc, 'backfillMedia').mockResolvedValue(0);
      await svc.start();
      await jest.advanceTimersByTimeAsync(299_999);
      expect(backfill).toHaveBeenCalledTimes(0);
      await jest.advanceTimersByTimeAsync(1);
      expect(backfill).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(300_000);
      expect(backfill).toHaveBeenCalledTimes(2);
      await svc.stop();
    });

    it('restart does not leave a second poll timer running', async () => {
      jest.useFakeTimers();
      const { svc, c } = polled();
      await svc.start();
      await svc.restart();
      await jest.advanceTimersByTimeAsync(60_000);
      expect(c.recentMessages).toHaveBeenCalledTimes(10);
      await svc.stop();
    });
  });

  describe('self-healing (prod 2026-11-27 21:01 UTC: ~2 min network outage → listener dead ~18 h, no alert)', () => {
    const never = () => new Promise<never>(() => undefined);
    // Saturday night 02:30 IST: outside market hours on purpose — the check must run at any hour.
    const T0 = new Date('2026-11-27T21:00:00Z');

    function live(env: Record<string, string> = {}) {
      const b = build({ env });
      const c = b.client as any;
      c.subscribeUpdates = jest.fn(async () => undefined);
      c.recentMessages = jest.fn(async () => []);
      return { ...b, c };
    }

    it('GramJS connect() resolving on a dead network is a failure that retries with backoff, not a hang', async () => {
      jest.useFakeTimers({ now: T0 });
      const { svc, client, factory, c } = live();
      client.connectSilentlyFails = true;
      c.subscribeUpdates.mockImplementation(never); // what GramJS does after a failed connect: waits forever
      await svc.start();
      expect(svc.status().state).toBe('backoff');
      expect(svc.status().lastError).toContain('not connected');
      expect(client.calls).toContain('disconnect'); // the failed client is closed, not leaked
      client.connectSilentlyFails = false;
      c.subscribeUpdates.mockImplementation(async () => undefined);
      await jest.advanceTimersByTimeAsync(5_000);
      expect(factory.create).toHaveBeenCalledTimes(2);
      expect(svc.status().state).toBe('listening');
      await svc.stop();
    });

    it('a subscribeUpdates that never answers times out into backoff', async () => {
      jest.useFakeTimers({ now: T0 });
      const { svc, c } = live();
      c.subscribeUpdates.mockImplementation(never);
      const started = svc.start();
      await jest.advanceTimersByTimeAsync(90_000);
      await started;
      expect(svc.status().state).toBe('backoff');
      expect(svc.status().lastError).toContain('timed out');
      await svc.stop();
    });

    it('polls that never answer time out; 3 min without a sign of life restarts the client, then a catch-up round runs', async () => {
      jest.useFakeTimers({ now: T0 });
      const { svc, c, factory } = live();
      jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);
      await svc.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(12_000); // catch-up round (6 s) + one normal round (12 s)
      expect(c.recentMessages.mock.calls).toEqual([['-1001', 100], ['-1001', 5]]);

      c.recentMessages.mockImplementation(never); // network gone: every request hangs
      await jest.advanceTimersByTimeAsync(170_000); // 3 min since the last good round, not yet more
      expect(factory.create).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(60_000 + 5_000); // watchdog tick sees > 3 min silent → backoff 5 s → restart
      expect(factory.create).toHaveBeenCalledTimes(2);
      expect(svc.status().state).toBe('listening');

      c.recentMessages.mockReset();
      c.recentMessages.mockImplementation(async () => []);
      await jest.advanceTimersByTimeAsync(7_000);
      expect(c.recentMessages).toHaveBeenCalledWith('-1001', 100); // reconnect → catch-up
      await svc.onModuleDestroy();
    });

    it('a live push or an RPC answer counts as life: no restart while Telegram answers', async () => {
      jest.useFakeTimers({ now: T0 });
      const { svc, c, client, factory } = live();
      jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);
      c.recentMessages.mockRejectedValue(Object.assign(new Error('rpc'), { errorMessage: 'CHANNEL_PRIVATE' }));
      await svc.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(10 * 60_000);
      expect(factory.create).toHaveBeenCalledTimes(1);

      c.recentMessages.mockRejectedValue(new Error('socket closed')); // no answer at all, but pushes still arrive
      for (let i = 0; i < 10; i++) {
        client.handler!(msg({ chatId: '-1999', tgMessageId: 100 + i }));
        await jest.advanceTimersByTimeAsync(60_000);
      }
      expect(factory.create).toHaveBeenCalledTimes(1);
      await svc.onModuleDestroy();
    });

    it('alerts the owner ONCE when stalled > 15 min (at 02:30 IST on a weekend), and once on recovery with the caught-up count', async () => {
      jest.useFakeTimers({ now: T0 });
      const { svc, c, client, alerts } = live();
      jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);
      await svc.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(6_000); // healthy catch-up round at 21:00:06 UTC

      // Outage: requests hang, and every reconnect "succeeds" without a connection (GramJS connect → false).
      c.recentMessages.mockImplementation(never);
      client.connectSilentlyFails = true;
      await jest.advanceTimersByTimeAsync(14 * 60_000);
      expect(alerts).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(2 * 60_000);
      expect(alerts).toHaveBeenCalledTimes(1);
      expect(alerts.mock.calls[0][0]).toBe('TELEGRAM_READER_STALLED');
      expect(alerts.mock.calls[0][1]).toContain('since 02:30 IST');
      await jest.advanceTimersByTimeAsync(60 * 60_000);
      expect(alerts).toHaveBeenCalledTimes(1); // once per outage

      // Network back: the next retry connects, the catch-up round stores the 3 posts made meanwhile.
      client.connectSilentlyFails = false;
      const nowS = () => Math.floor(Date.now() / 1000);
      c.recentMessages.mockReset();
      c.recentMessages.mockImplementation(async () => [
        msg({ tgMessageId: 33, date: nowS() - 60, text: 'c' }),
        msg({ tgMessageId: 32, date: nowS() - 1_800, text: 'b' }),
        msg({ tgMessageId: 31, date: nowS() - 3_000, text: 'a' }),
      ]);
      await jest.advanceTimersByTimeAsync(6 * 60_000); // backoff is capped at 5 min
      expect(svc.status().state).toBe('listening');
      expect(alerts).toHaveBeenCalledTimes(2);
      expect(alerts.mock.calls[1][0]).toBe('TELEGRAM_READER_RECOVERED');
      expect(alerts.mock.calls[1][1]).toContain('Caught up 3 post(s)');
      await jest.advanceTimersByTimeAsync(30 * 60_000);
      expect(alerts).toHaveBeenCalledTimes(2);

      // A second outage after the recovery alerts again (the outage flags were reset).
      c.recentMessages.mockImplementation(never);
      client.connectSilentlyFails = true;
      await jest.advanceTimersByTimeAsync(20 * 60_000);
      expect(alerts).toHaveBeenCalledTimes(3);
      expect(alerts.mock.calls[2][0]).toBe('TELEGRAM_READER_STALLED');
      expect(alerts.mock.calls[2][1]).toContain('Telegram has not answered for');
      await svc.onModuleDestroy();
    });

    it('a stall alert that could not be sent is retried; a short blip sends nothing', async () => {
      jest.useFakeTimers({ now: T0 });
      const { svc, c, alerts } = live();
      jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);
      await svc.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(6_000);
      c.recentMessages.mockImplementation(never);
      await jest.advanceTimersByTimeAsync(5 * 60_000); // 5-min blip: restart, but no alert
      expect(alerts).not.toHaveBeenCalled();
      alerts.mockResolvedValueOnce(false); // e.g. DNS still down for api.telegram.org
      await jest.advanceTimersByTimeAsync(12 * 60_000);
      expect(alerts).toHaveBeenCalledTimes(2); // first send failed → retried on the next tick
      await jest.advanceTimersByTimeAsync(10 * 60_000);
      expect(alerts).toHaveBeenCalledTimes(2);
      await svc.onModuleDestroy();
    });

    it('a revoked session alerts once after 15 min and says to reconnect in Settings', async () => {
      jest.useFakeTimers({ now: T0 });
      const { svc, client, alerts } = live();
      jest.spyOn((svc as any).logger, 'error').mockImplementation(() => undefined);
      client.connectError = Object.assign(new Error('x'), { errorMessage: 'AUTH_KEY_UNREGISTERED' });
      await svc.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(16 * 60_000);
      expect(alerts).toHaveBeenCalledTimes(1);
      expect(alerts.mock.calls[0][1]).toContain('reconnect it in Settings');
      await svc.onModuleDestroy();
    });

    it('TELEGRAM_POLL_SEC=0 (push only): no stall restarts and no alerts, as before', async () => {
      jest.useFakeTimers({ now: T0 });
      const { svc, factory, alerts } = live({ TELEGRAM_POLL_SEC: '0' });
      await svc.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(30 * 60_000);
      expect(factory.create).toHaveBeenCalledTimes(1);
      expect(alerts).not.toHaveBeenCalled();
      await svc.onModuleDestroy();
    });

    it('catch-up keeps the newest 5 always, and older ones only when under 48 h old', async () => {
      const { svc, c } = live();
      const now = Math.floor(Date.now() / 1000);
      const ages = [10, 20, 30, 40, 50, 3_600, 3 * 86_400, 4 * 86_400]; // seconds old, newest first
      c.recentMessages.mockImplementation(async () => ages.map((a, i) => msg({ tgMessageId: 100 - i, date: now - a, text: `p${i}` })));
      await svc.start();
      expect(await svc.pollOnce()).toBe(6);
      await svc.stop();
    });

    it('the summary line counts raw updates of any type and still prints while not listening', async () => {
      jest.useFakeTimers({ now: T0 });
      const { svc, client } = live();
      jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);
      await svc.start();
      client.rawHandler!();
      client.rawHandler!();
      expect(svc.logSummary()).toContain('updates=2 (raw, any type)');
      client.connectSilentlyFails = true;
      await svc.restart();
      expect(svc.status().state).toBe('backoff');
      expect(svc.logSummary()).toContain('(state backoff');
      await svc.stop();
    });

    // ---- review 2026-11-28 ----
    const two = [
      { id: 'ch1', tgChannelId: '-1001', title: 'Alpha' },
      { id: 'ch2', tgChannelId: '-1002', title: 'Beta' },
    ];
    const nowS = () => Math.floor(Date.now() / 1000);

    it('a channel that keeps failing leaves catch-up after 3 tries (logged once); RECOVERED is still sent and names it', async () => {
      jest.useFakeTimers({ now: T0 });
      const { svc, c, client, prisma, alerts } = live();
      prisma.telegramChannel.findMany.mockResolvedValue(two as any);
      const warn = jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);
      await svc.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(6_000);
      c.recentMessages.mockImplementation(never);
      client.connectSilentlyFails = true;
      await jest.advanceTimersByTimeAsync(20 * 60_000);
      expect(alerts).toHaveBeenCalledTimes(1);

      // Network back, but the owner left Beta: GramJS throws a plain Error (not an RPC error) every time.
      client.connectSilentlyFails = false;
      c.recentMessages.mockReset();
      c.recentMessages.mockImplementation(async (chatId: string) => {
        if (chatId === '-1002') throw new Error('Could not find the input entity for {"channelId":"2"}');
        return [msg({ tgMessageId: 50, date: nowS() - 60, text: 'x' })];
      });
      await jest.advanceTimersByTimeAsync(6 * 60_000);
      expect(alerts).toHaveBeenCalledTimes(2);
      expect(alerts.mock.calls[1][0]).toBe('TELEGRAM_READER_RECOVERED');
      expect(alerts.mock.calls[1][1]).toContain('Caught up 1 post(s)');
      expect(alerts.mock.calls[1][1]).toContain('Could not read: "Beta"');
      const beta = c.recentMessages.mock.calls.filter(([id]: [string]) => id === '-1002').map(([, n]: [string, number]) => n);
      expect(beta.slice(0, 3)).toEqual([100, 100, 100]);
      expect(beta.length).toBeGreaterThan(3);
      expect(beta.slice(3).every((n: number) => n === 5)).toBe(true); // no 100-post fetch forever
      expect(warn.mock.calls.filter(([l]) => String(l).includes('catch-up skipped for "Beta"'))).toHaveLength(1);
      await svc.onModuleDestroy();
    });

    it('an RPC answer (CHANNEL_PRIVATE) ends that channel\'s catch-up at once; refreshChannels trims un-ticked channels', async () => {
      const { svc, c, prisma } = live();
      jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);
      prisma.telegramChannel.findMany.mockResolvedValue(two as any);
      c.recentMessages.mockImplementation(async (chatId: string) => {
        if (chatId === '-1002') throw Object.assign(new Error('rpc'), { errorMessage: 'CHANNEL_PRIVATE' });
        return [];
      });
      await svc.start();
      await svc.pollOnce();
      await svc.pollOnce();
      expect(c.recentMessages.mock.calls.filter(([id]: [string]) => id === '-1002').map(([, n]: [string, number]) => n)).toEqual([100, 5]);

      await svc.restart(); // fresh catch-up for both
      expect([...(svc as any).catchUpLeft]).toEqual(['-1001', '-1002']);
      prisma.telegramChannel.findMany.mockResolvedValue([two[0]] as any);
      await svc.refreshChannels();
      expect([...(svc as any).catchUpLeft]).toEqual(['-1001']);
      await svc.stop();
    });

    it('pushes from a replaced (abandoned) client are ignored: they cannot hide a stall of the current one', async () => {
      jest.useFakeTimers({ now: T0 });
      const { svc, factory } = live();
      jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);
      const zombie = new FakeTgClient() as any;
      zombie.subscribeUpdates = jest.fn(never); // its connect times out and it is abandoned
      zombie.recentMessages = jest.fn(async () => []);
      const current = new FakeTgClient() as any;
      current.subscribeUpdates = jest.fn(async () => undefined);
      current.recentMessages = jest.fn(never); // the current client is stalled
      factory.create.mockReset();
      factory.create.mockReturnValueOnce(zombie).mockReturnValue(current);

      await svc.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(95_000 + 1_000); // 90 s connect timeout → backoff 5 s → current client
      expect(factory.create).toHaveBeenCalledTimes(2);
      expect(zombie.calls).toContain('disconnect');
      expect(svc.status().state).toBe('listening');

      // The abandoned client's GramJS retry loop connected anyway and delivers pushes every 30 s.
      for (let i = 0; i < 10; i++) {
        zombie.handler(msg({ chatId: '-1999', tgMessageId: 500 + i }));
        zombie.rawHandler?.();
        await jest.advanceTimersByTimeAsync(30_000);
      }
      expect((svc as any).lastProgressAt).toBeNull();
      expect(factory.create).toHaveBeenCalledTimes(3); // the current client was restarted for its stall
      expect(svc.logSummary()).toContain('received=0 (live push');
      await svc.onModuleDestroy();
    });

    it('FLOOD_WAIT 45 s on every poll pauses polling for the wait and is never a stall or an outage', async () => {
      jest.useFakeTimers({ now: T0 });
      const { svc, c, factory, alerts } = live();
      jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);
      c.recentMessages.mockRejectedValue(Object.assign(new Error('flood'), { errorMessage: 'FLOOD_WAIT_X', seconds: 45 }));
      await svc.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(30 * 60_000);
      expect(factory.create).toHaveBeenCalledTimes(1);
      expect(alerts).not.toHaveBeenCalled();
      const calls = c.recentMessages.mock.calls.length;
      expect(calls).toBeGreaterThanOrEqual(38); // ~ one try per 45 s pause over 30 min…
      expect(calls).toBeLessThanOrEqual(41); // …not one per 6 s
      await svc.onModuleDestroy();
    });

    it('a slow catch-up round (> 3 min, every fetch answering) is not a stall', async () => {
      jest.useFakeTimers({ now: T0 });
      const { svc, c, factory, prisma } = live();
      jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);
      prisma.telegramChannel.findMany.mockResolvedValue(
        Array.from({ length: 10 }, (_, i) => ({ id: `ch${i}`, tgChannelId: `-10${i}`, title: `C${i}` })) as any,
      );
      c.recentMessages.mockImplementation(() => new Promise((r) => setTimeout(() => r([]), 28_000))); // 10 × 28 s = 280 s round
      await svc.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(5 * 60_000);
      expect(factory.create).toHaveBeenCalledTimes(1);
      await svc.onModuleDestroy();
    });

    it('the backoff attempt resets only after the link has answered for 5 min', async () => {
      jest.useFakeTimers({ now: T0 });
      const { svc } = live();
      await svc.start();
      (svc as any).attempt = 3;
      await jest.advanceTimersByTimeAsync(4 * 60_000);
      expect((svc as any).attempt).toBe(3);
      await jest.advanceTimersByTimeAsync(90_000);
      expect((svc as any).attempt).toBe(0);
      await svc.stop();
    });

    it('with the real sendOpsAlert, a STALLED send that failed is retried after the 30-min cooldown, then not again', async () => {
      jest.useFakeTimers({ now: T0 });
      __resetOpsAlerts();
      const { svc, c, client } = live();
      jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);
      const opsWarn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const fetch = jest.fn().mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND')).mockResolvedValue({ ok: true, status: 200 });
      (svc as any).sendAlert = (k: string, t: string) =>
        sendOpsAlert(k, t, { env: { TELEGRAM_ALERT_BOT_TOKEN: 't', TELEGRAM_ALERT_CHAT_ID: 'c' }, fetch });
      await svc.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(6_000);
      c.recentMessages.mockImplementation(never);
      client.connectSilentlyFails = true;
      await jest.advanceTimersByTimeAsync(16 * 60_000);
      expect(fetch).toHaveBeenCalledTimes(1); // failed (DNS)
      await jest.advanceTimersByTimeAsync(28 * 60_000);
      expect(fetch).toHaveBeenCalledTimes(1); // cooldown
      await jest.advanceTimersByTimeAsync(3 * 60_000);
      expect(fetch).toHaveBeenCalledTimes(2); // retried, delivered
      await jest.advanceTimersByTimeAsync(60 * 60_000);
      expect(fetch).toHaveBeenCalledTimes(2);
      await svc.onModuleDestroy();
      opsWarn.mockRestore();
      __resetOpsAlerts();
    });
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

  it('backfill: a missed image is fetched again by id, saved, marked tried, and sent with backfill: true', async () => {
    const { svc, prisma, events, client } = build({ env: { TELEGRAM_MEDIA_DIR: tmp() } });
    (svc as any).mediaRetryDelaysMs = [0, 0];
    await svc.start();
    const raw = { id: 42, media: { kind: 'photo', mimeType: 'image/jpeg', skipped: 'empty download' } };
    (prisma as any).$queryRaw = jest.fn(async () => [
      { id: 'm42', channelId: 'ch1', tgChannelId: '-1001', tgMessageId: 42, postedAt: new Date('2026-10-27T15:52:22Z'), rawText: '', rawPayload: raw },
    ]);
    (client as any).messageById = jest.fn(async () => msg({ tgMessageId: 42, text: '', hasMedia: true, media: photo, download: async () => Buffer.from('gold-call') }));
    expect(await svc.backfillMedia(new Date('2026-10-27T17:00:00Z'))).toBe(1);
    expect((client as any).messageById).toHaveBeenCalledWith('-1001', 42);
    const upd = (prisma.telegramMessage.update.mock.calls[0] as any[])[0];
    expect(upd.where).toEqual({ id: 'm42' });
    expect(upd.data.rawPayload.media).toMatchObject({ kind: 'photo', sha256: expect.stringMatching(/^[0-9a-f]{64}$/), backfillTried: true });
    expect(events.emit).toHaveBeenCalledWith('telegram.message', expect.objectContaining({ messageId: 'm42', backfill: true, media: expect.objectContaining({ kind: 'photo' }) }));
  });

  it('backfill: still empty → marked tried (never retried forever), nothing sent', async () => {
    const { svc, prisma, events, client } = build({ env: { TELEGRAM_MEDIA_DIR: tmp() } });
    (svc as any).mediaRetryDelaysMs = [0, 0];
    await svc.start();
    (prisma as any).$queryRaw = jest.fn(async () => [
      { id: 'm43', channelId: 'ch1', tgChannelId: '-1001', tgMessageId: 43, postedAt: new Date(), rawText: '', rawPayload: { media: { skipped: 'empty download' } } },
    ]);
    (client as any).messageById = jest.fn(async () => msg({ tgMessageId: 43, hasMedia: true, media: photo, download: async () => Buffer.alloc(0) }));
    expect(await svc.backfillMedia(new Date())).toBe(0);
    expect((prisma.telegramMessage.update.mock.calls[0] as any[])[0].data.rawPayload.media).toMatchObject({ skipped: 'empty download', backfillTried: true, attempts: 3 });
    expect(events.emit).not.toHaveBeenCalled();
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
