import { EventEmitter } from 'events';
import { Logger } from '@nestjs/common';
import { WsTickSummary, wsTickDebugOn } from './ws-tick-summary';
import { AngelOneWebSocketService } from './angel-one-websocket.service';

describe('WsTickSummary', () => {
  it('emits one summary per window, on the first tick after it closes', () => {
    let t = 0;
    const s = new WsTickSummary(() => t, 60_000);
    for (let i = 0; i < 50; i++) {
      t += 1000;
      expect(s.record(i % 2 === 0 ? 'A' : 'B')).toBeNull();
    }
    s.record(null);
    t = 61_000;
    expect(s.record('C')).toBe('WS ticks: 51 in 61s across 2 tokens (1 unparsed)');
    t = 90_000;
    expect(s.record('C')).toBeNull();
    t = 125_000;
    // the window that just closed held 2 ticks (C at 61s and 90s), 1 token
    expect(s.record('D')).toBe('WS ticks: 2 in 64s across 1 tokens');
  });

  it('WS_TICK_DEBUG is off unless exactly 1/true', () => {
    expect(wsTickDebugOn(undefined)).toBe(false);
    expect(wsTickDebugOn('0')).toBe(false);
    expect(wsTickDebugOn('yes')).toBe(false);
    expect(wsTickDebugOn('1')).toBe(true);
    expect(wsTickDebugOn(' TRUE ')).toBe(true);
  });
});

describe('AngelOneWebSocketService tick logging', () => {
  const OLD = process.env.WS_TICK_DEBUG;
  afterEach(() => {
    jest.restoreAllMocks();
    if (OLD === undefined) delete process.env.WS_TICK_DEBUG;
    else process.env.WS_TICK_DEBUG = OLD;
  });

  function wire(): { ws: EventEmitter; svc: AngelOneWebSocketService; ticks: unknown[] } {
    const svc = new AngelOneWebSocketService({} as never);
    const ws = new EventEmitter();
    (svc as unknown as { ws: unknown }).ws = ws;
    (svc as unknown as { registerEventHandlers(): void }).registerEventHandlers();
    const ticks: unknown[] = [];
    svc.on('tick', (t) => ticks.push(t));
    return { ws, svc, ticks };
  }

  it('does not log per tick by default (summary only), and still emits every tick', () => {
    delete process.env.WS_TICK_DEBUG;
    const debug = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    const { ws, svc, ticks } = wire();
    jest.spyOn(svc as never, 'parseTickData' as never).mockImplementation(((raw: { token: string }) => ({
      token: raw.token,
    })) as never);
    for (let i = 0; i < 200; i++) ws.emit('tick', { token: String(i % 5) });
    expect(ticks).toHaveLength(200);
    expect(debug.mock.calls.filter((c) => String(c[0]).startsWith('WS tick:'))).toHaveLength(0);
    // Within one minute: no summary yet either.
    expect(debug).not.toHaveBeenCalled();
  });

  it('WS_TICK_DEBUG=1 restores the per-tick line', () => {
    process.env.WS_TICK_DEBUG = '1';
    const debug = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    const { ws, svc } = wire();
    jest.spyOn(svc as never, 'parseTickData' as never).mockImplementation((() => ({ token: '1' })) as never);
    ws.emit('tick', { token: '1' });
    expect(debug.mock.calls.filter((c) => String(c[0]).startsWith('WS tick:'))).toHaveLength(1);
  });
});
