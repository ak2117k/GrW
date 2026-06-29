import { Test } from '@nestjs/testing';
import { UngatedTickPoller } from './ungated-tick-poller.service';
import { AngelOneAdapterService } from '../../market-data/services/angel-one-adapter.service';
import { UngatedWatchRepository } from '../repositories/ungated-watch.repository';
import { UngatedWatchService } from './ungated-watch.service';
import { UngatedTradeExecutionService } from './ungated-trade-execution.service';
import { ExitPriceService } from '../../signal-generator/services/exit-price.service';

describe('UngatedTickPoller.pollOpenPositions', () => {
  let poller: UngatedTickPoller;
  let adapter: { getLtpsBatch: jest.Mock };
  let repo: { findAllActive: jest.Mock };
  let watch: { onTick: jest.Mock };
  let exitPrice: { resolveExitPrices: jest.Mock };

  beforeEach(async () => {
    adapter = { getLtpsBatch: jest.fn() };
    repo = { findAllActive: jest.fn() };
    watch = { onTick: jest.fn().mockResolvedValue(undefined) };
    // Default resolver: delegate to the adapter batch fixture and wrap each
    // returned price as fresh, so existing getLtpsBatch fixtures keep working.
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
        UngatedTickPoller,
        { provide: AngelOneAdapterService, useValue: adapter },
        { provide: UngatedWatchRepository, useValue: repo },
        { provide: UngatedWatchService, useValue: watch },
        { provide: UngatedTradeExecutionService, useValue: { closeTrade: jest.fn() } },
        { provide: ExitPriceService, useValue: exitPrice },
      ],
    }).compile();
    poller = mod.get(UngatedTickPoller);
  });

  it('no-ops when no entries are TRADED', async () => {
    repo.findAllActive.mockResolvedValue([
      { status: 'WATCHING', token: '111', exchange: 'NSE' },
      { status: 'STOPPED', token: '222', exchange: 'NSE' },
    ]);
    await poller.pollOpenPositions();
    expect(adapter.getLtpsBatch).not.toHaveBeenCalled();
    expect(watch.onTick).not.toHaveBeenCalled();
  });

  it('batches all TRADED tokens for the same exchange into one quote call', async () => {
    repo.findAllActive.mockResolvedValue([
      { status: 'TRADED', token: '111', exchange: 'NSE' },
      { status: 'TRADED', token: '222', exchange: 'NSE' },
      { status: 'TRADED', token: '333', exchange: 'NSE' },
    ]);
    adapter.getLtpsBatch.mockResolvedValue(new Map([
      ['111', 100.5],
      ['222', 200.5],
      ['333', 300.5],
    ]));
    await poller.pollOpenPositions();
    expect(adapter.getLtpsBatch).toHaveBeenCalledTimes(1);
    expect(adapter.getLtpsBatch).toHaveBeenCalledWith(
      'NSE',
      expect.arrayContaining(['111', '222', '333']),
    );
    expect(watch.onTick).toHaveBeenCalledTimes(3);
    expect(watch.onTick).toHaveBeenCalledWith('111', 100.5, expect.any(Date));
    expect(watch.onTick).toHaveBeenCalledWith('222', 200.5, expect.any(Date));
    expect(watch.onTick).toHaveBeenCalledWith('333', 300.5, expect.any(Date));
  });

  it('tokens missing from the batch response are silently dropped (no onTick)', async () => {
    repo.findAllActive.mockResolvedValue([
      { status: 'TRADED', token: '111', exchange: 'NSE' },
      { status: 'TRADED', token: '222', exchange: 'NSE' },
    ]);
    // Broker only returned a quote for 111 — 222 missing (e.g. delisted, halted)
    adapter.getLtpsBatch.mockResolvedValue(new Map([['111', 100.5]]));
    await poller.pollOpenPositions();
    expect(watch.onTick).toHaveBeenCalledTimes(1);
    expect(watch.onTick).toHaveBeenCalledWith('111', 100.5, expect.any(Date));
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
    // Both tokens should have been attempted — the second one despite the
    // first throwing.
    expect(watch.onTick).toHaveBeenCalledTimes(2);
  });
});
