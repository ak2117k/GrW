import { EventEmitter } from 'events';
import { LiveBrokerSyncService, type LiveSyncDeps } from './live-broker-sync.service';
import type { OrderStreamAuth } from './order-update-stream';

const IST = (local: string) => Date.parse(`${local}+05:30`);
const AUTH: OrderStreamAuth = { jwtToken: 'jwt-1', feedToken: 'feed-1', clientCode: 'U123', apiKey: 'key-1' };

class FakeSocket extends EventEmitter {
  closed = false;
  constructor(readonly headers: Record<string, string>) {
    super();
  }
  send(): void {}
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', 1000);
  }
}

function complete(token = '445566') {
  return Buffer.from(
    JSON.stringify({ 'order-status': 'AB05', orderData: { orderstatus: 'complete', symboltoken: token, exchange: 'MCX' } }),
  );
}

function harness(
  opts: {
    config?: Record<string, unknown>;
    open?: Map<string, Set<string>>;
    warmUsers?: string[];
    auth?: OrderStreamAuth | null;
  } = {},
) {
  const values: Record<string, unknown> = {
    'hub.ownerUserId': 'owner',
    ...opts.config,
  };
  const config = { get: jest.fn((k: string) => values[k]) };
  const warm = new Set(opts.warmUsers ?? ['owner']);
  const tracker = {
    backfill: jest.fn().mockResolvedValue({ opened: 0, closed: 0, skipped: false }),
    isBackfilling: jest.fn().mockReturnValue(false),
    openPositionExchangesByUser: jest.fn().mockResolvedValue(opts.open ?? new Map()),
    distinctOpenTokens: jest.fn().mockResolvedValue(['445566']),
  };
  let auth = opts.auth === undefined ? AUTH : opts.auth;
  const userFeeds = {
    warmRestClient: jest.fn((u: string) => (warm.has(u) ? { client: {}, clientId: 'U123' } : null)),
    streamAuth: jest.fn(() => auth),
    leaseRestClient: jest.fn(),
    hasSession: jest.fn(),
  };
  const feed = { subscribe: jest.fn().mockResolvedValue([]) };
  const sockets: FakeSocket[] = [];
  const deps: LiveSyncDeps = {
    socketFactory: (_url, headers) => {
      const s = new FakeSocket(headers);
      sockets.push(s);
      return s;
    },
  };
  const svc = new LiveBrokerSyncService(
    config as never,
    tracker as never,
    userFeeds as never,
    feed as never,
    deps,
  );
  return {
    svc,
    tracker,
    userFeeds,
    feed,
    sockets,
    setAuth: (a: OrderStreamAuth | null) => {
      auth = a;
    },
    last: () => sockets[sockets.length - 1],
  };
}

/** Let queued promise callbacks run under fake timers. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe('LiveBrokerSyncService', () => {
  const savedBootJobs = process.env.BOOT_JOBS;
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    jest.setSystemTime(IST('2026-10-13T22:40:00')); // Tuesday, MCX evening session
    delete process.env.BOOT_JOBS;
  });
  afterEach(() => {
    jest.useRealTimers();
    if (savedBootJobs === undefined) delete process.env.BOOT_JOBS;
    else process.env.BOOT_JOBS = savedBootJobs;
  });

  describe('order-update stream', () => {
    it("opens ONE order-update socket for the owner on the live session's tokens (no login)", () => {
      const h = harness();
      h.svc.onModuleInit();
      expect(h.sockets).toHaveLength(1);
      expect(h.last().headers.Authorization).toBe('Bearer jwt-1');
      expect(h.userFeeds.streamAuth).toHaveBeenCalledWith('owner');
      expect(h.userFeeds.leaseRestClient).not.toHaveBeenCalled();
      h.svc.onModuleDestroy();
    });

    it('a COMPLETE order update triggers ONE debounced reconcile (~2 s later), positions-only over the warm session', async () => {
      const h = harness();
      h.svc.onModuleInit();
      h.last().emit('open');
      h.last().emit('message', complete());

      jest.advanceTimersByTime(1_900);
      await settle();
      expect(h.tracker.backfill).not.toHaveBeenCalled();

      jest.advanceTimersByTime(200);
      await settle();
      expect(h.tracker.backfill).toHaveBeenCalledTimes(1);
      expect(h.tracker.backfill).toHaveBeenCalledWith('owner', { positionsOnly: true, warmOnly: true });
      h.svc.onModuleDestroy();
    });

    it('a BURST of updates (a bracket leg + SL cancel + fill) collapses into ONE reconcile', async () => {
      const h = harness();
      h.svc.onModuleInit();
      h.last().emit('open');
      for (let i = 0; i < 5; i++) {
        h.last().emit('message', complete(String(i)));
        jest.advanceTimersByTime(300);
      }
      jest.advanceTimersByTime(2_500);
      await settle();
      expect(h.tracker.backfill).toHaveBeenCalledTimes(1);
      h.svc.onModuleDestroy();
    });

    it('a non-terminal update (trigger pending) triggers nothing', async () => {
      const h = harness();
      h.svc.onModuleInit();
      h.last().emit('open');
      h.last().emit(
        'message',
        Buffer.from(JSON.stringify({ 'order-status': 'AB10', orderData: { orderstatus: 'trigger pending' } })),
      );
      jest.advanceTimersByTime(5_000);
      await settle();
      expect(h.tracker.backfill).not.toHaveBeenCalled();
      h.svc.onModuleDestroy();
    });

    it('a reconcile that changed the open set re-offers the open tokens to the shared feed', async () => {
      const h = harness();
      h.tracker.backfill.mockResolvedValue({ opened: 0, closed: 1, skipped: false });
      h.svc.onModuleInit();
      h.last().emit('open');
      h.last().emit('message', complete());
      jest.advanceTimersByTime(2_100);
      await settle();
      expect(h.feed.subscribe).toHaveBeenCalledWith(['445566']);
      h.svc.onModuleDestroy();
    });

    it('is not opened when disabled by config', () => {
      const h = harness({ config: { 'liveSync.orderStreamEnabled': false } });
      h.svc.onModuleInit();
      expect(h.sockets).toHaveLength(0);
      h.svc.onModuleDestroy();
    });

    it('is not opened outside every exchange session (overnight)', () => {
      jest.setSystemTime(IST('2026-10-14T02:00:00'));
      const h = harness();
      h.svc.onModuleInit();
      expect(h.sockets).toHaveLength(0);
      h.svc.onModuleDestroy();
    });

    it('reconnects on the new JWT when the live session re-logs in', () => {
      const h = harness();
      h.svc.onModuleInit();
      h.last().emit('open');
      h.setAuth({ ...AUTH, jwtToken: 'jwt-2' });
      jest.advanceTimersByTime(30_000);
      expect(h.sockets.length).toBeGreaterThanOrEqual(2);
      expect(h.last().headers.Authorization).toBe('Bearer jwt-2');
      h.svc.onModuleDestroy();
    });
  });

  describe('adaptive poll', () => {
    const openMcx = () => new Map([['owner', new Set(['MCX'])]]);

    it('reconciles a user with an OPEN position on an exchange in session every 60 s', async () => {
      const h = harness({ open: openMcx(), config: { 'liveSync.orderStreamEnabled': false } });
      h.svc.onModuleInit();
      jest.advanceTimersByTime(60_000);
      await settle();
      expect(h.tracker.backfill).toHaveBeenCalledTimes(1);
      expect(h.tracker.backfill).toHaveBeenCalledWith('owner', { positionsOnly: true, warmOnly: true });
      jest.advanceTimersByTime(60_000);
      await settle();
      expect(h.tracker.backfill).toHaveBeenCalledTimes(2);
      h.svc.onModuleDestroy();
    });

    it('still runs while the order stream is down', async () => {
      const h = harness({ open: openMcx() });
      h.svc.onModuleInit();
      h.last().close(); // stream drops and stays in backoff
      jest.advanceTimersByTime(60_000);
      await settle();
      expect(h.tracker.backfill).toHaveBeenCalledWith('owner', { positionsOnly: true, warmOnly: true });
      h.svc.onModuleDestroy();
    });

    it('does not poll a user whose only open positions are on a CLOSED exchange', async () => {
      // 22:40 IST: NFO closed hours ago, MCX open.
      const h = harness({ open: new Map([['owner', new Set(['NFO'])]]), config: { 'liveSync.orderStreamEnabled': false } });
      h.svc.onModuleInit();
      jest.advanceTimersByTime(120_000);
      await settle();
      expect(h.tracker.backfill).not.toHaveBeenCalled();
      h.svc.onModuleDestroy();
    });

    it('does not poll a user with no open position tracker', async () => {
      const h = harness({ open: new Map(), config: { 'liveSync.orderStreamEnabled': false } });
      h.svc.onModuleInit();
      jest.advanceTimersByTime(120_000);
      await settle();
      expect(h.tracker.backfill).not.toHaveBeenCalled();
      h.svc.onModuleDestroy();
    });

    it('does not poll a user with no warm session (that would need a login: the 10-min cron covers them)', async () => {
      const h = harness({
        open: new Map([['tenant', new Set(['MCX'])]]),
        warmUsers: ['owner'],
        config: { 'liveSync.orderStreamEnabled': false },
      });
      h.svc.onModuleInit();
      jest.advanceTimersByTime(60_000);
      await settle();
      expect(h.tracker.backfill).not.toHaveBeenCalled();
      h.svc.onModuleDestroy();
    });

    it('single-flight: skips a user whose reconcile is already in flight', async () => {
      const h = harness({ open: openMcx(), config: { 'liveSync.orderStreamEnabled': false } });
      h.tracker.isBackfilling.mockReturnValue(true);
      h.svc.onModuleInit();
      jest.advanceTimersByTime(60_000);
      await settle();
      expect(h.tracker.backfill).not.toHaveBeenCalled();
      h.svc.onModuleDestroy();
    });

    it('a slow pass is not stacked: the next firing skips while the previous is still running', async () => {
      const h = harness({ open: openMcx(), config: { 'liveSync.orderStreamEnabled': false } });
      h.tracker.backfill.mockImplementation(() => new Promise(() => undefined));
      h.svc.onModuleInit();
      jest.advanceTimersByTime(60_000);
      await settle();
      jest.advanceTimersByTime(60_000);
      await settle();
      expect(h.tracker.backfill).toHaveBeenCalledTimes(1);
      h.svc.onModuleDestroy();
    });

    it('honours LIVE_SYNC_POLL_MS but never polls faster than 30 s', async () => {
      const h = harness({ open: openMcx(), config: { 'liveSync.orderStreamEnabled': false, 'liveSync.pollMs': 5_000 } });
      h.svc.onModuleInit();
      jest.advanceTimersByTime(29_000);
      await settle();
      expect(h.tracker.backfill).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1_000);
      await settle();
      expect(h.tracker.backfill).toHaveBeenCalledTimes(1);
      h.svc.onModuleDestroy();
    });

    it('a failing reconcile is contained (logged), the next pass still runs', async () => {
      const h = harness({ open: openMcx(), config: { 'liveSync.orderStreamEnabled': false } });
      h.tracker.backfill.mockRejectedValueOnce(new Error('broker down'));
      h.svc.onModuleInit();
      jest.advanceTimersByTime(60_000);
      await settle();
      jest.advanceTimersByTime(60_000);
      await settle();
      expect(h.tracker.backfill).toHaveBeenCalledTimes(2);
      h.svc.onModuleDestroy();
    });

    it('is off when disabled by config', async () => {
      const h = harness({ open: openMcx(), config: { 'liveSync.pollEnabled': false, 'liveSync.orderStreamEnabled': false } });
      h.svc.onModuleInit();
      jest.advanceTimersByTime(180_000);
      await settle();
      expect(h.tracker.backfill).not.toHaveBeenCalled();
      h.svc.onModuleDestroy();
    });
  });

  it('BOOT_JOBS=false starts neither the stream nor the poll', async () => {
    process.env.BOOT_JOBS = 'false';
    const h = harness({ open: new Map([['owner', new Set(['MCX'])]]) });
    h.svc.onModuleInit();
    jest.advanceTimersByTime(180_000);
    await settle();
    expect(h.sockets).toHaveLength(0);
    expect(h.tracker.backfill).not.toHaveBeenCalled();
    expect(h.tracker.openPositionExchangesByUser).not.toHaveBeenCalled();
    h.svc.onModuleDestroy();
  });

  it('onModuleDestroy stops everything', async () => {
    const h = harness({ open: new Map([['owner', new Set(['MCX'])]]) });
    h.svc.onModuleInit();
    h.svc.onModuleDestroy();
    expect(h.sockets[0].closed).toBe(true);
    jest.advanceTimersByTime(600_000);
    await settle();
    expect(h.sockets).toHaveLength(1);
    expect(h.tracker.backfill).not.toHaveBeenCalled();
  });
});
