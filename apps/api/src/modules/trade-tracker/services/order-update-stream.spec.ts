import { EventEmitter } from 'events';
import {
  ORDER_UPDATE_URL,
  OrderUpdateStream,
  isFillOrTerminal,
  parseOrderUpdate,
  type OrderStreamAuth,
} from './order-update-stream';

/** A fake `ws` socket: records what was sent, lets the test drive events. */
class FakeSocket extends EventEmitter {
  sent: string[] = [];
  closed = false;
  constructor(
    readonly url: string,
    readonly headers: Record<string, string>,
  ) {
    super();
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', 1000, Buffer.from(''));
  }
  terminate(): void {
    this.close();
  }
}

const AUTH: OrderStreamAuth = { jwtToken: 'jwt-1', feedToken: 'feed-1', clientCode: 'U123', apiKey: 'key-1' };

/** Angel's order-update message for one order (the documented JSON shape). */
function update(orderstatus: string, code = 'AB05', extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    'user-id': 'U123',
    'status-code': '200',
    'order-status': code,
    'error-message': '',
    orderData: {
      orderid: '2610131234',
      tradingsymbol: 'CRUDEOIL20OCT268950CE',
      symboltoken: '445566',
      exchange: 'MCX',
      orderstatus: orderstatus,
      status: orderstatus,
      filledshares: '0',
      ...extra,
    },
  });
}

function harness(auth: () => OrderStreamAuth | null = () => AUTH) {
  const sockets: FakeSocket[] = [];
  const updates: unknown[] = [];
  const logs: string[] = [];
  const stream = new OrderUpdateStream({
    auth,
    socketFactory: (url, headers) => {
      const s = new FakeSocket(url, headers);
      sockets.push(s);
      return s;
    },
    onUpdate: (u) => updates.push(u),
    log: (m) => logs.push(m),
  });
  const last = () => sockets[sockets.length - 1];
  return { stream, sockets, updates, logs, last };
}

describe('parseOrderUpdate / isFillOrTerminal', () => {
  it.each(['complete', 'cancelled', 'rejected'])('%s is terminal', (s) => {
    expect(isFillOrTerminal(parseOrderUpdate(update(s))!)).toBe(true);
  });

  it.each(['open', 'trigger pending', 'modified', 'open pending', 'cancel pending', 'validation pending'])(
    '%s is not terminal',
    (s) => {
      expect(isFillOrTerminal(parseOrderUpdate(update(s, 'AB01'))!)).toBe(false);
    },
  );

  it('a partial fill on a still-open order counts (the position changed)', () => {
    expect(isFillOrTerminal(parseOrderUpdate(update('open', 'AB01', { filledshares: '25' }))!)).toBe(true);
  });

  it('falls back to the status code when the text is missing', () => {
    const raw = JSON.stringify({ 'order-status': 'AB05', orderData: {} });
    expect(isFillOrTerminal(parseOrderUpdate(raw)!)).toBe(true);
  });

  it('the AB00 connect acknowledgement is not an order event', () => {
    const raw = JSON.stringify({ 'user-id': 'U123', 'status-code': '200', 'order-status': 'AB00', orderData: {} });
    expect(isFillOrTerminal(parseOrderUpdate(raw)!)).toBe(false);
  });

  it.each([['pong'], [''], ['{not json'], [Buffer.from('pong')]])('ignores non-JSON frames (%p)', (raw) => {
    expect(parseOrderUpdate(raw)).toBeNull();
  });

  it('reads a Buffer frame', () => {
    expect(parseOrderUpdate(Buffer.from(update('complete')))?.status).toBe('complete');
  });
});

describe('OrderUpdateStream', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("connects to Angel's order-update endpoint with the live session's tokens as headers", () => {
    const h = harness();
    h.stream.start();
    expect(h.sockets).toHaveLength(1);
    expect(h.last().url).toBe(ORDER_UPDATE_URL);
    expect(ORDER_UPDATE_URL).toBe('wss://tns.angelone.in/smart-order-update');
    expect(h.last().headers).toEqual({
      Authorization: 'Bearer jwt-1',
      'x-api-key': 'key-1',
      'x-client-code': 'U123',
      'x-feed-token': 'feed-1',
    });
    h.stream.stop();
  });

  it('start() is idempotent: one socket', () => {
    const h = harness();
    h.stream.start();
    h.stream.start();
    expect(h.sockets).toHaveLength(1);
    h.stream.stop();
  });

  it('hands fill/terminal updates to onUpdate and ignores the rest', () => {
    const h = harness();
    h.stream.start();
    h.last().emit('open');
    h.last().emit('message', Buffer.from(update('trigger pending', 'AB10')));
    h.last().emit('message', Buffer.from('pong'));
    h.last().emit('message', Buffer.from(update('complete')));
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0]).toMatchObject({ status: 'complete', token: '445566', exchange: 'MCX' });
    h.stream.stop();
  });

  it('pings while up', () => {
    const h = harness();
    h.stream.start();
    h.last().emit('open');
    jest.advanceTimersByTime(10_000);
    expect(h.last().sent).toContain('ping');
    h.stream.stop();
  });

  it('reconnects with backoff after a drop, using the CURRENT session tokens', () => {
    let auth = AUTH;
    const h = harness(() => auth);
    h.stream.start();
    h.last().emit('open');
    auth = { ...AUTH, jwtToken: 'jwt-2' };
    h.last().close();
    expect(h.sockets).toHaveLength(1);
    jest.advanceTimersByTime(2_000);
    expect(h.sockets).toHaveLength(2);
    expect(h.last().headers.Authorization).toBe('Bearer jwt-2');
    // A second consecutive failure waits longer.
    h.last().emit('error', new Error('401'));
    h.last().close();
    jest.advanceTimersByTime(2_000);
    expect(h.sockets).toHaveLength(2);
    jest.advanceTimersByTime(2_000);
    expect(h.sockets).toHaveLength(3);
    h.stream.stop();
  });

  it('a silent (stale) socket is dropped and reconnected', () => {
    const h = harness();
    h.stream.start();
    h.last().emit('open');
    jest.advanceTimersByTime(45_000);
    expect(h.sockets[0].closed).toBe(true);
    jest.advanceTimersByTime(5_000);
    expect(h.sockets.length).toBeGreaterThanOrEqual(2);
    h.stream.stop();
  });

  it('with no live session it opens nothing and retries later (never logs in itself)', () => {
    let auth: OrderStreamAuth | null = null;
    const h = harness(() => auth);
    h.stream.start();
    expect(h.sockets).toHaveLength(0);
    expect(h.stream.state()).toBe('waiting-session');
    auth = AUTH;
    jest.advanceTimersByTime(60_000);
    expect(h.sockets).toHaveLength(1);
    h.stream.stop();
  });

  it('never throws: a throwing socket factory or onUpdate is contained', () => {
    const stream = new OrderUpdateStream({
      auth: () => AUTH,
      socketFactory: () => {
        throw new Error('ENOTFOUND');
      },
      onUpdate: () => undefined,
      log: () => undefined,
    });
    expect(() => stream.start()).not.toThrow();
    expect(() => jest.advanceTimersByTime(10_000)).not.toThrow();
    stream.stop();

    const h = harness();
    const s2 = new OrderUpdateStream({
      auth: () => AUTH,
      socketFactory: (url, headers) => {
        const s = new FakeSocket(url, headers);
        h.sockets.push(s);
        return s;
      },
      onUpdate: () => {
        throw new Error('listener');
      },
      log: () => undefined,
    });
    s2.start();
    h.last().emit('open');
    expect(() => h.last().emit('message', Buffer.from(update('complete')))).not.toThrow();
    s2.stop();
  });

  it('logs one line per state change, not one per reconnect attempt', () => {
    const h = harness();
    h.stream.start();
    h.last().emit('open');
    h.last().close();
    for (let i = 0; i < 4; i++) {
      jest.advanceTimersByTime(130_000);
      h.last().close();
    }
    const downs = h.logs.filter((l) => /down/.test(l));
    expect(h.logs.filter((l) => /\bup\b/.test(l))).toHaveLength(1);
    expect(downs).toHaveLength(1);
    h.stream.stop();
  });

  it('stop() closes the socket and schedules nothing more', () => {
    const h = harness();
    h.stream.start();
    h.last().emit('open');
    h.stream.stop();
    expect(h.sockets[0].closed).toBe(true);
    jest.advanceTimersByTime(600_000);
    expect(h.sockets).toHaveLength(1);
    expect(h.stream.state()).toBe('stopped');
  });

  it('restart() reconnects at once (the session re-logged in with a new JWT)', () => {
    let auth = AUTH;
    const h = harness(() => auth);
    h.stream.start();
    h.last().emit('open');
    expect(h.stream.jwtInUse()).toBe('jwt-1');
    auth = { ...AUTH, jwtToken: 'jwt-9' };
    h.stream.restart();
    expect(h.sockets).toHaveLength(2);
    expect(h.stream.jwtInUse()).toBe('jwt-9');
    h.stream.stop();
  });
});
