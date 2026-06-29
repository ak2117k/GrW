import { Test } from '@nestjs/testing';
import {
  SellFuturesPaperAccountService,
  SellFuturesPositionCapError,
  SellFuturesMarginExhaustedError,
  SellFuturesKillSwitchError,
} from './sell-futures-paper-account.service';
import { SellFuturesTradeRepository } from '../repositories/sell-futures-trade.repository';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { MARGIN_PCT, MAX_OPEN_POSITIONS, PAPER_MARGIN_POOL } from '../constants';

describe('SellFuturesPaperAccountService', () => {
  let svc: SellFuturesPaperAccountService;
  let prisma: any;
  let trades: any;
  let row: any;

  beforeEach(async () => {
    row = {
      id: 'acc1',
      startingBalance: PAPER_MARGIN_POOL,
      cash: PAPER_MARGIN_POOL,
      realizedPnl: 0,
      fees: 0,
      deployedCapital: 0,
      killSwitchAt: null,
    };
    prisma = {
      sellFuturesPaperAccount: {
        findFirst: jest.fn().mockResolvedValue(row),
        create: jest.fn().mockResolvedValue(row),
        update: jest.fn().mockImplementation(({ data }: any) => {
          Object.assign(row, data);
          return Promise.resolve(row);
        }),
      },
    };
    trades = {
      sumRealized: jest.fn().mockResolvedValue({ pnl: 0, fees: 0 }),
      sumOpenNotional: jest.fn().mockResolvedValue(0),
    };
    const mod = await Test.createTestingModule({
      providers: [
        SellFuturesPaperAccountService,
        { provide: PrismaService, useValue: prisma },
        { provide: SellFuturesTradeRepository, useValue: trades },
      ],
    }).compile();
    svc = mod.get(SellFuturesPaperAccountService);
  });

  it('admit throws kill-switch when killSwitchAt is set', async () => {
    row.killSwitchAt = new Date();
    await expect(svc.admit({ openTrades: 0 })).rejects.toBeInstanceOf(SellFuturesKillSwitchError);
  });

  it('admit throws position-cap at MAX_OPEN_POSITIONS', async () => {
    await expect(svc.admit({ openTrades: MAX_OPEN_POSITIONS })).rejects.toBeInstanceOf(
      SellFuturesPositionCapError,
    );
  });

  it('admit passes below the cap with kill-switch off', async () => {
    await expect(svc.admit({ openTrades: MAX_OPEN_POSITIONS - 1 })).resolves.toBeUndefined();
  });

  it('ensureMargin throws margin-exhausted when required margin exceeds cash', async () => {
    row.cash = 1000;
    await expect(svc.ensureMargin(5000)).rejects.toBeInstanceOf(SellFuturesMarginExhaustedError);
  });

  it('ensureMargin passes when cash covers the required margin', async () => {
    row.cash = 10_000;
    await expect(svc.ensureMargin(5000)).resolves.toBeUndefined();
  });

  it('applyEntry deploys only the margin (notional × MARGIN_PCT), not full notional', async () => {
    // notional = 100 × 500 = 50,000 → margin = 50,000 × 0.20 = 10,000
    await svc.applyEntry({ entryPrice: 100, quantity: 500, entryFees: 50 });
    const expectedMargin = 100 * 500 * MARGIN_PCT;
    expect(row.deployedCapital).toBeCloseTo(expectedMargin, 4);
    expect(row.cash).toBeCloseTo(PAPER_MARGIN_POOL - expectedMargin - 50, 4);
    expect(row.fees).toBeCloseTo(50, 4);
  });

  it('applyExit releases margin and books SHORT P&L = (entry − exit) × qty', async () => {
    // Open first: entry 100, qty 500 → margin 10,000 deployed.
    await svc.applyEntry({ entryPrice: 100, quantity: 500, entryFees: 0 });
    // Short exit at 98 → profit = (100 − 98) × 500 = +1000 (sideMul = -1).
    await svc.applyExit({ entryPrice: 100, exitPrice: 98, quantity: 500, sideMul: -1, exitFees: 0 });
    expect(row.deployedCapital).toBeCloseTo(0, 4);
    expect(row.realizedPnl).toBeCloseTo(1000, 4);
    // cash back to pool + profit (no fees in this case).
    expect(row.cash).toBeCloseTo(PAPER_MARGIN_POOL + 1000, 4);
  });
});
