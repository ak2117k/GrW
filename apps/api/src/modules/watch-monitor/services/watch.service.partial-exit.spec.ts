/**
 * Unit tests for WatchService partial-exit + trailing-stop logic.
 *
 * Coverage:
 *  1. BUY entry at +0.99% does NOT trigger partial exit
 *  2. BUY entry at +1.00% triggers partial exit; sets partialExitedAt,
 *     partialQty=100, remainingQty=100 (entry executedPrice=1000 → qty=200),
 *     trailingStopPrice = ltp × 0.995
 *  3. SELL entry at −1.00% (in their favor) triggers partial exit;
 *     trailingStopPrice = ltp × 1.005
 *  4. After partial exit, BUY: price rises 5% more → trailingHighWater
 *     updates, stop ratchets up
 *  5. After partial exit, BUY: price drops back below stop → triggerTrailingStop
 *     fires, status=EXITED, closedReason='trailing-stop'
 *  6. Options entry (optionsToken set) → partial exit logic SKIPPED entirely
 *  7. WATCHING entry → partial exit logic SKIPPED (only TRADED)
 */
import { Test } from '@nestjs/testing';
import { WatchService } from './watch.service';
import { WatchRepository } from '../repositories/watch.repository';
import { TargetCalculatorService } from './target-calculator.service';
import { StrikeSelectorService } from './strike-selector.service';
import { MarketFeedService } from '../../market-data/services/market-feed.service';
import { LevelBookService } from '../../signal-generator/services/level-book.service';
import { WatchGateway } from '../gateways/watch.gateway';
import { TradeExecutionService } from '../../trade-engine/services/trade-execution.service';

// ---- helpers ----------------------------------------------------------------
// executedPrice=1000 → qty = floor(200_000 / 1000) = 200
// partialQty = floor(200 * 0.5) = 100; remainingQty = 100

function makeEntry(overrides: Partial<Record<string, any>> = {}): Record<string, any> {
  return {
    id: 'w1',
    token: '11536',
    symbol: 'RELIANCE-EQ',
    exchange: 'NSE',
    side: 'BUY',
    status: 'TRADED',
    initialPrice: 1000,
    executedPrice: 1000,
    profitTarget: 1100,
    optionsToken: null,
    optionsLotSize: null,
    paperTradeId: 'pt-1',
    partialExitedAt: null,
    trailingHighWater: null,
    trailingStopPrice: null,
    remainingQty: null,
    maxFavorable: 1000,
    maxAdverse: 1000,
    lastEventPrice: 1000,
    lastTickAt: null,
    ...overrides,
  };
}

// ---- shared mock factories ---------------------------------------------------

function makeRepo() {
  return {
    findActiveByToken: jest.fn(),
    findById: jest.fn().mockResolvedValue({ id: 'w1', token: '11536', optionsToken: null }),
    createEvent: jest.fn().mockResolvedValue({ id: 'e1' }),
    update: jest.fn().mockResolvedValue({}),
  };
}

function makeTrade() {
  return { executeTrade: jest.fn().mockResolvedValue({ id: 't1' }), closeTrade: jest.fn().mockResolvedValue({}) };
}

function makeFeed() {
  return { subscribeForWatch: jest.fn(), unsubscribeForWatch: jest.fn() };
}

function makeGateway() {
  return { emitTick: jest.fn(), emitEvent: jest.fn(), emitCreated: jest.fn() };
}

async function buildService(repo: any, trade: any, feed: any, gateway: any): Promise<WatchService> {
  const mod = await Test.createTestingModule({
    providers: [
      WatchService,
      { provide: WatchRepository, useValue: repo },
      { provide: TargetCalculatorService, useValue: { compute: jest.fn() } },
      { provide: StrikeSelectorService, useValue: { pick: jest.fn() } },
      { provide: MarketFeedService, useValue: feed },
      { provide: LevelBookService, useValue: { getLevels: jest.fn() } },
      { provide: WatchGateway, useValue: gateway },
      { provide: TradeExecutionService, useValue: trade },
    ],
  }).compile();
  return mod.get(WatchService);
}

// ---- tests ------------------------------------------------------------------

describe('WatchService — partial-exit + trailing-stop', () => {
  let repo: ReturnType<typeof makeRepo>;
  let trade: ReturnType<typeof makeTrade>;
  let feed: ReturnType<typeof makeFeed>;
  let gateway: ReturnType<typeof makeGateway>;
  let svc: WatchService;

  beforeEach(async () => {
    repo = makeRepo();
    trade = makeTrade();
    feed = makeFeed();
    gateway = makeGateway();
    svc = await buildService(repo, trade, feed, gateway);
  });

  // 1. BUY entry at +0.99% does NOT trigger partial exit --------------------
  it('BUY at +0.99% does NOT trigger partial exit', async () => {
    const entry = makeEntry({ side: 'BUY', executedPrice: 1000 });
    repo.findActiveByToken.mockResolvedValue([entry]);

    // ltp = 1000 * 1.0099 = 1009.9 → move = 0.99%, below 1% threshold
    await svc.onTick('11536', 1009.9, new Date());

    const partialExitUpdate = (repo.update.mock.calls as any[]).find(
      (call: any[]) => call[1]?.partialExitedAt,
    );
    expect(partialExitUpdate).toBeUndefined();

    const partialExitEvent = (repo.createEvent.mock.calls as any[]).find(
      (call: any[]) => call[0]?.eventType === 'PARTIAL_EXIT',
    );
    expect(partialExitEvent).toBeUndefined();
  });

  // 2. BUY entry at +1.00% triggers partial exit ---------------------------
  it('BUY at exactly +1.00% triggers partial exit with correct fields', async () => {
    // profitTarget is set above the test ltp so TARGET_HIT does not fire first
    const entry = makeEntry({ side: 'BUY', executedPrice: 1000, profitTarget: 1300 });
    repo.findActiveByToken.mockResolvedValue([entry]);

    // ltp = 1010 → move = 1.00%, exactly at threshold
    // qty = floor(200_000 / 1000) = 200; partialQty = floor(200*0.5) = 100; remaining = 100
    await svc.onTick('11536', 1010, new Date());

    // Should have partially closed the linked trade (100 of 200 shares)
    // AND forwarded the trigger price as opts.exitPrice — without it the
    // trade-execution fallback resolves an exitPrice from the cached LTP
    // at simulation time, drifting from the actual partial-exit trigger
    // and corrupting the partial-slice pnl on the Trade row.
    expect(trade.closeTrade).toHaveBeenCalledWith(
      'pt-1',
      expect.objectContaining({ quantity: 100, exitPrice: 1010 }),
    );

    // Should have written a PARTIAL_EXIT event
    expect(repo.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'PARTIAL_EXIT', price: 1010 }),
    );

    // Should have updated the entry with correct partial-exit fields
    expect(repo.update).toHaveBeenCalledWith(
      'w1',
      expect.objectContaining({
        partialExitedAt: expect.any(Date),
        partialExitPrice: 1010,
        partialQty: 100,
        remainingQty: 100,
        trailingHighWater: 1010,
        trailingStopPrice: expect.closeTo(1010 * 0.995, 4),
      }),
    );
  });

  // 3. SELL entry at −1.00% triggers partial exit --------------------------
  it('SELL at −1.00% triggers partial exit; trailingStopPrice = ltp × 1.005', async () => {
    // profitTarget for SELL is below ltp direction; set well below ltp so
    // TARGET_HIT (ltp <= profitTarget) does not fire at ltp=990.
    // SELL target hit fires when ltp <= profitTarget, so set profitTarget=700 (below 990).
    const entry = makeEntry({
      side: 'SELL',
      executedPrice: 1000,
      profitTarget: 700,
      maxFavorable: 1000,
      maxAdverse: 1000,
    });
    repo.findActiveByToken.mockResolvedValue([entry]);

    // ltp = 990 → move = (1000-990)/1000 = 1%, exactly at threshold
    await svc.onTick('11536', 990, new Date());

    // Partial close of the linked trade — 100 shares
    expect(trade.closeTrade).toHaveBeenCalledWith(
      'pt-1',
      expect.objectContaining({ quantity: 100 }),
    );

    // trailingStopPrice for SELL = ltp × 1.005
    expect(repo.update).toHaveBeenCalledWith(
      'w1',
      expect.objectContaining({
        partialQty: 100,
        remainingQty: 100,
        trailingHighWater: 990,
        trailingStopPrice: expect.closeTo(990 * 1.005, 4),
      }),
    );
  });

  // 4. After partial exit, BUY: price rises → trailingHighWater ratchets up --
  it('After partial exit, BUY: new high ratchets trailingHighWater + stop', async () => {
    // Entry already has partial exit at 1010, highWater=1010, stop=1010*0.995=1004.95
    // profitTarget must be ABOVE the test ltp (1055) so TARGET_HIT does not fire.
    const entry = makeEntry({
      side: 'BUY',
      executedPrice: 1000,
      profitTarget: 1500,
      partialExitedAt: new Date(),
      partialExitPrice: 1010,
      partialQty: 100,
      remainingQty: 100,
      trailingHighWater: 1010,
      trailingStopPrice: 1010 * 0.995, // 1004.95
    });
    repo.findActiveByToken.mockResolvedValue([entry]);

    // Price rises to 1055 (another +4.5% from partial exit price)
    await svc.onTick('11536', 1055, new Date());

    // High-water should update to 1055, stop to 1055 × 0.995
    expect(repo.update).toHaveBeenCalledWith(
      'w1',
      expect.objectContaining({
        trailingHighWater: 1055,
        trailingStopPrice: expect.closeTo(1055 * 0.995, 4),
      }),
    );

    // Should NOT have triggered trailing stop (stop = 1049.725, price = 1055 > stop)
    const trailStopEvent = (repo.createEvent.mock.calls as any[]).find(
      (call: any[]) => call[0]?.eventType === 'TRAILING_STOP_HIT',
    );
    expect(trailStopEvent).toBeUndefined();
  });

  // 5. After partial exit, BUY: price drops below stop → EXITED -------------
  it('After partial exit, BUY: price drops below trailing stop → EXITED', async () => {
    // High-water = 1155, stop = 1155 × 0.995 = 1149.225.
    // profitTarget must be ABOVE ltp (1148) so TARGET_HIT does not fire first.
    const trailStop = 1155 * 0.995;
    const entry = makeEntry({
      side: 'BUY',
      executedPrice: 1000,
      profitTarget: 1500,
      partialExitedAt: new Date(),
      partialExitPrice: 1010,
      partialQty: 100,
      remainingQty: 100,
      trailingHighWater: 1155,
      trailingStopPrice: trailStop,
    });
    repo.findActiveByToken.mockResolvedValue([entry]);

    // Price drops to 1148 — below stop (1149.225)
    await svc.onTick('11536', 1148, new Date());

    // Should close the remaining position via the linked trade, forwarding
    // the trail-stop trigger price as opts.exitPrice so the Trade row
    // records the actual stop price (not the cached LTP at simulation time).
    expect(trade.closeTrade).toHaveBeenCalledWith(
      'pt-1',
      expect.objectContaining({ reason: 'trailing-stop', exitPrice: 1148 }),
    );

    // TRAILING_STOP_HIT event
    expect(repo.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'TRAILING_STOP_HIT', price: 1148 }),
    );

    // Status → EXITED, closedReason → 'trailing-stop'
    expect(repo.update).toHaveBeenCalledWith(
      'w1',
      expect.objectContaining({
        status: 'EXITED',
        closedReason: 'trailing-stop',
      }),
    );

    // Feed unsubscribed
    expect(feed.unsubscribeForWatch).toHaveBeenCalled();
  });

  // 6. Options entry → partial exit logic SKIPPED --------------------------
  it('Options entry (optionsToken set) skips partial exit even at +20%', async () => {
    const entry = makeEntry({
      side: 'BUY',
      executedPrice: 1000,
      profitTarget: 2000,
      optionsToken: 'OPT-TOKEN', // <-- options entry
      optionsLotSize: 75,
    });
    repo.findActiveByToken.mockResolvedValue([entry]);

    // +20% move that would normally trigger partial exit
    await svc.onTick('OPT-TOKEN', 1200, new Date());

    const partialExitEvent = (repo.createEvent.mock.calls as any[]).find(
      (call: any[]) => call[0]?.eventType === 'PARTIAL_EXIT',
    );
    expect(partialExitEvent).toBeUndefined();
    expect(trade.closeTrade).not.toHaveBeenCalled();
  });

  // 7. WATCHING entry → partial exit logic SKIPPED -------------------------
  it('WATCHING entry skips partial exit entirely', async () => {
    const entry = makeEntry({
      side: 'BUY',
      status: 'WATCHING', // <-- not TRADED
      executedPrice: null,
      profitTarget: 2000, // well above test ltp so TARGET_HIT also doesn't fire
    });
    repo.findActiveByToken.mockResolvedValue([entry]);

    // +15% move
    await svc.onTick('11536', 1150, new Date());

    const partialExitEvent = (repo.createEvent.mock.calls as any[]).find(
      (call: any[]) => call[0]?.eventType === 'PARTIAL_EXIT',
    );
    expect(partialExitEvent).toBeUndefined();
    expect(trade.closeTrade).not.toHaveBeenCalled();
  });
});
