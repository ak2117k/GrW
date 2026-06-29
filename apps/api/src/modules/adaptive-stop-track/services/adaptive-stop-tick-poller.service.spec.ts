import { Test } from '@nestjs/testing';
import { AdaptiveStopTickPoller } from './adaptive-stop-tick-poller.service';
import { AngelOneAdapterService } from '../../market-data/services/angel-one-adapter.service';
import { AdaptiveStopWatchRepository } from '../repositories/adaptive-stop-watch.repository';
import { AdaptiveStopWatchService } from './adaptive-stop-watch.service';
import { AdaptiveStopTradeExecutionService } from './adaptive-stop-trade-execution.service';
import { ExitPriceService } from '../../signal-generator/services/exit-price.service';

describe('AdaptiveStopTickPoller.pollOpenPositions', () => {
  let poller: AdaptiveStopTickPoller;
  let adapter: { getLtpsBatch: jest.Mock };
  let repo: { findAllActive: jest.Mock };
  let watch: { onTick: jest.Mock };
  let exitPrice: { resolveExitPrices: jest.Mock };

  beforeEach(async () => {
    adapter = { getLtpsBatch: jest.fn() };
    repo = { findAllActive: jest.fn() };
    watch = { onTick: jest.fn().mockResolvedValue(undefined) };
    // Default resolver: delegate to the adapter batch fixture and wrap each
    // returned price as fresh, so getLtpsBatch fixtures keep driving the path.
    exitPrice = {
      resolveExitPrices: jest.fn(async (exchange: string, tokens: string[]) => {
        const batch: Map<string, number> = await adapter.getLtpsBatch(exchange, tokens);
        const out = new Map();
        for (const [token, price] of batch) {
          out.set(token, { price, fresh: true, source: 'rest-batch' as const });
        }
        return out;
      }),
    };
    const mod = await Test.createTestingModule({
      providers: [
        AdaptiveStopTickPoller,
        { provide: AngelOneAdapterService, useValue: adapter },
        { provide: AdaptiveStopWatchRepository, useValue: repo },
        { provide: AdaptiveStopWatchService, useValue: watch },
        { provide: AdaptiveStopTradeExecutionService, useValue: { closeTrade: jest.fn() } },
        { provide: ExitPriceService, useValue: exitPrice },
      ],
    }).compile();
    poller = mod.get(AdaptiveStopTickPoller);
  });

  it('no-ops when no entries are TRADED', async () => {
    repo.findAllActive.mockResolvedValue([
      { status: 'WATCHING', token: '111', exchange: 'NSE' },
      { status: 'STOPPED', token: '222', exchange: 'NSE' },
    ]);
    await poller.pollOpenPositions();
    expect(exitPrice.resolveExitPrices).not.toHaveBeenCalled();
    expect(watch.onTick).not.toHaveBeenCalled();
  });

  it('dispatches a fresh-priced onTick for each TRADED token', async () => {
    repo.findAllActive.mockResolvedValue([
      { status: 'TRADED', token: '111', exchange: 'NSE' },
      { status: 'TRADED', token: '222', exchange: 'NSE' },
    ]);
    adapter.getLtpsBatch.mockResolvedValue(new Map([['111', 100.5], ['222', 200.5]]));
    await poller.pollOpenPositions();
    expect(watch.onTick).toHaveBeenCalledTimes(2);
    expect(watch.onTick).toHaveBeenCalledWith('111', 100.5, expect.any(Date));
    expect(watch.onTick).toHaveBeenCalledWith('222', 200.5, expect.any(Date));
  });

  it('does NOT call onTick and warns when a token has no fresh price', async () => {
    repo.findAllActive.mockResolvedValue([
      { status: 'TRADED', token: '111', exchange: 'NSE' },
      { status: 'TRADED', token: '222', exchange: 'NSE' },
    ]);
    const warnSpy = jest.spyOn((poller as any).logger, 'warn').mockImplementation(() => undefined);
    // 111 fresh, 222 surfaced as not-fresh — 222 must be skipped, not acted on.
    exitPrice.resolveExitPrices.mockResolvedValue(
      new Map([
        ['111', { price: 100.5, fresh: true, source: 'rest-batch' as const }],
        ['222', { price: 0, fresh: false, source: 'none' as const }],
      ]),
    );
    await poller.pollOpenPositions();
    expect(watch.onTick).toHaveBeenCalledTimes(1);
    expect(watch.onTick).toHaveBeenCalledWith('111', 100.5, expect.any(Date));
    expect(watch.onTick).not.toHaveBeenCalledWith('222', expect.anything(), expect.anything());
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('222 unmonitored — no fresh price'));
    warnSpy.mockRestore();
  });

  it('an onTick failure for one symbol does NOT abort the others', async () => {
    repo.findAllActive.mockResolvedValue([
      { status: 'TRADED', token: '111', exchange: 'NSE' },
      { status: 'TRADED', token: '222', exchange: 'NSE' },
    ]);
    adapter.getLtpsBatch.mockResolvedValue(new Map([['111', 100], ['222', 200]]));
    watch.onTick.mockImplementationOnce(() => { throw new Error('boom'); });
    await poller.pollOpenPositions();
    expect(watch.onTick).toHaveBeenCalledTimes(2);
  });
});
