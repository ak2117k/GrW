import { Test } from '@nestjs/testing';
import { UngatedTrackController } from './ungated-track.controller';
import { UngatedWatchRepository } from '../repositories/ungated-watch.repository';
import { UngatedTradeRepository } from '../repositories/ungated-trade.repository';
import { UngatedPaperAccountService, STARTING_BALANCE } from '../services/ungated-paper-account.service';
import { UngatedComparisonService } from '../services/ungated-comparison.service';
import { AngelOneAdapterService } from '../../market-data/services/angel-one-adapter.service';

describe('UngatedTrackController', () => {
  let ctrl: UngatedTrackController;
  let watchRepo: any, tradeRepo: any, account: any, comparison: any;

  beforeEach(async () => {
    watchRepo = {
      list: jest.fn().mockResolvedValue([
        { id: 'uw1', alertId: 'a1', paperTradeId: 'ut1', status: 'TARGET_HIT' },
        { id: 'uw2', alertId: null, paperTradeId: null, status: 'WATCHING' },
      ]),
      findScannerNames: jest.fn().mockResolvedValue(new Map([['a1', 'Anand Superbullish scanner May26']])),
      findByIdWithEvents: jest.fn().mockResolvedValue(
        { id: 'uw1', alertId: 'a1', paperTradeId: 'ut1', status: 'TARGET_HIT', events: [] },
      ),
    };
    tradeRepo = { findRealization: jest.fn().mockResolvedValue(
      new Map([['ut1', { pnl: 200, fees: 30 }]])
    ) };
    account = {
      snapshot: jest.fn().mockResolvedValue({
        startingBalance: STARTING_BALANCE, cash: STARTING_BALANCE - 100000,
        realizedPnl: 200, fees: 30, deployedCapital: 100000, killSwitchAt: null,
      }),
    };
    comparison = { daily: jest.fn().mockResolvedValue({ date: '2026-05-20' }) };

    const mod = await Test.createTestingModule({
      controllers: [UngatedTrackController],
      providers: [
        { provide: UngatedWatchRepository, useValue: watchRepo },
        { provide: UngatedTradeRepository, useValue: tradeRepo },
        { provide: UngatedPaperAccountService, useValue: account },
        { provide: UngatedComparisonService, useValue: comparison },
        {
          provide: AngelOneAdapterService,
          useValue: { getLtpsBatch: jest.fn().mockResolvedValue(new Map()) },
        },
      ],
    }).compile();
    ctrl = mod.get(UngatedTrackController);
  });

  it('GET /api/ungated/watch attaches realizedPnl + realizedFees per closed entry', async () => {
    const out = await ctrl.list(undefined, '2026-05-20');
    expect(out[0]).toMatchObject({ id: 'uw1', realizedPnl: 200, realizedFees: 30 });
  });

  it('GET /api/ungated/watch resolves scannerName from alertId (null when no alert)', async () => {
    const out = await ctrl.list(undefined, '2026-05-20');
    expect(out[0]).toMatchObject({ id: 'uw1', scannerName: 'Anand Superbullish scanner May26' });
    expect(out[1]).toMatchObject({ id: 'uw2', scannerName: null });
    // Controller passes raw alertIds (incl. nulls); the repo dedupes/filters.
    expect(watchRepo.findScannerNames).toHaveBeenCalledWith(['a1', null]);
  });

  it('GET /api/ungated/watch/:id resolves scannerName from alertId', async () => {
    const out = await ctrl.get('uw1');
    expect(out).toMatchObject({ id: 'uw1', scannerName: 'Anand Superbullish scanner May26' });
  });

  it('GET /api/ungated/paper-account returns the live snapshot with equity = cash + deployed', async () => {
    const out = await ctrl.account();
    expect(out.equity).toBe(STARTING_BALANCE - 100000 + 100000);
    expect(out.cash).toBe(STARTING_BALANCE - 100000);
  });

  it('GET /api/ungated/comparison delegates to the service', async () => {
    const out = await ctrl.comparison('2026-05-20');
    expect(comparison.daily).toHaveBeenCalledWith('2026-05-20');
    expect(out.date).toBe('2026-05-20');
  });
});
