import { Test } from '@nestjs/testing';
import { WatchController } from './watch.controller';
import { WatchRepository } from '../repositories/watch.repository';
import { WatchService } from '../services/watch.service';
import { RiskGuardService } from '../services/risk-guard.service';

describe('WatchController.close', () => {
  let controller: WatchController;
  let watch: { closeTraded: jest.Mock };

  beforeEach(async () => {
    const repo = {
      findById: jest.fn().mockResolvedValue({ id: 'w1', status: 'TRADED' }),
      update: jest.fn().mockResolvedValue({}),
    };
    watch = { closeTraded: jest.fn().mockResolvedValue(undefined) };
    const mod = await Test.createTestingModule({
      controllers: [WatchController],
      providers: [
        { provide: WatchRepository, useValue: repo },
        { provide: WatchService, useValue: watch },
        { provide: RiskGuardService, useValue: {} },
      ],
    }).compile();
    controller = mod.get(WatchController);
  });

  it('routes a manual close through closeTraded so the linked trade is closed', async () => {
    // Bug: the close button did a bare repo.update(status:EXITED) — the
    // paper position was never closed and the cash never came back.
    await controller.close('w1', { reason: 'manual' } as any);
    expect(watch.closeTraded).toHaveBeenCalledWith('w1', 'manual');
  });
});

describe('WatchController.list', () => {
  let controller: WatchController;
  let watch: { list: jest.Mock };

  beforeEach(async () => {
    watch = { list: jest.fn().mockResolvedValue([]) };
    const mod = await Test.createTestingModule({
      controllers: [WatchController],
      providers: [
        { provide: WatchRepository, useValue: {} },
        { provide: WatchService, useValue: watch },
        { provide: RiskGuardService, useValue: {} },
      ],
    }).compile();
    controller = mod.get(WatchController);
  });

  it('delegates to WatchService.list with status and date', async () => {
    await controller.list('WATCHING', '2026-05-15');
    expect(watch.list).toHaveBeenCalledWith({ status: 'WATCHING', date: '2026-05-15' });
  });

  it('rejects a malformed date', async () => {
    await expect(controller.list(undefined, '15-05-2026')).rejects.toThrow();
  });
});
