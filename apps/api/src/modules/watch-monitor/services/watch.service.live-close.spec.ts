/**
 * Trade agent exit authority (final review item 7): under TRADE_AGENT_AUTHORITY=live the trade engine refuses a
 * watch-monitor close of a LIVE trade. The watch entry must then stay OPEN (TRADED, nothing written) — never marked
 * closed over a still-open position — with one WARN. Paper entries and authority off: exactly as today.
 */
import { Logger } from '@nestjs/common';
import { WatchService } from './watch.service';

function harness(o: { live: boolean; entry: Record<string, unknown> }) {
  const entry = { id: 'w1', token: '11536', symbol: 'NIFTY27NOV24000CE', status: 'TRADED', side: 'BUY', executedPrice: 100, optionsToken: null, currentPrice: 95, ...o.entry };
  const repo = {
    findById: jest.fn(async () => ({ ...entry })),
    createEvent: jest.fn(async () => ({ id: 'e1' })),
    update: jest.fn(async () => ({})),
  };
  const trade = { closeTrade: jest.fn(async () => ({})), legacyLiveCloseRefused: jest.fn(() => o.live) };
  const feed = { unsubscribeForWatch: jest.fn() };
  const svc = new WatchService(
    repo as never, { compute: jest.fn() } as never, { pick: jest.fn() } as never, feed as never, { getLevels: jest.fn() } as never,
    { emitTick: jest.fn(), emitEvent: jest.fn(), emitCreated: jest.fn() } as never, trade as never, null,
  );
  return { svc, repo, trade, entry };
}

const LIVE_ENTRY = { liveTradeId: 'lt-1', paperTradeId: null };
const PAPER_ENTRY = { liveTradeId: null, paperTradeId: 'pt-1' };

describe('WatchService — a refused live close keeps the watch entry OPEN (TRADE_AGENT_AUTHORITY=live)', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  const transitions: Array<[string, (s: WatchService) => Promise<unknown>]> = [
    ['target hit', (s) => s.transitionTargetHit('w1', 120)],
    ['score-decay stop', (s) => s.transitionStopped('w1', 40, 'score-decay')],
    ['hard loss-cut', (s) => s.transitionLossCut('w1', 90, -1500)],
    ['closeTraded (EOD square-off)', (s) => s.closeTraded('w1', 'eod-square-off').catch(() => undefined)],
  ];

  it.each(transitions)('live, LIVE entry, %s → no close call, no status change, no event; WARN once', async (_n, run) => {
    const h = harness({ live: true, entry: LIVE_ENTRY });
    await run(h.svc);
    await run(h.svc);
    expect(h.trade.closeTrade).not.toHaveBeenCalled();
    expect(h.repo.update).not.toHaveBeenCalled();
    expect(h.repo.createEvent).not.toHaveBeenCalled();
    expect(warn.mock.calls.filter(([m]) => String(m).includes('live close refused'))).toHaveLength(1);
  });

  it('closeTraded (squareOffAll) reports the refusal as an error, never as closed', async () => {
    const h = harness({ live: true, entry: LIVE_ENTRY });
    await expect(h.svc.closeTraded('w1', 'eod-square-off')).rejects.toThrow(/live close refused/);
  });

  it.each(transitions)('live, PAPER entry, %s → closes as today', async (_n, run) => {
    const h = harness({ live: true, entry: PAPER_ENTRY });
    await run(h.svc);
    expect(h.trade.closeTrade).toHaveBeenCalledWith('pt-1', expect.anything());
    expect(h.repo.update).toHaveBeenCalled();
  });

  it.each(transitions)('off, LIVE entry, %s → closes and marks the entry closed exactly as today', async (_n, run) => {
    const h = harness({ live: false, entry: LIVE_ENTRY });
    await run(h.svc);
    expect(h.trade.closeTrade).toHaveBeenCalledWith('lt-1', expect.anything());
    expect(h.repo.update).toHaveBeenCalled();
  });
});
