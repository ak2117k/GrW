import { Test } from '@nestjs/testing';
import { UngatedPaperAccountService, STARTING_BALANCE, TRADE_CAPITAL } from './ungated-paper-account.service';
import { UngatedTradeRepository } from '../repositories/ungated-trade.repository';
import { PrismaService } from '../../../common/prisma/prisma.service';

describe('UngatedPaperAccountService', () => {
  let svc: UngatedPaperAccountService;
  let prisma: any;
  let trades: any;

  beforeEach(async () => {
    let row = { id: 'a1', startingBalance: STARTING_BALANCE, cash: STARTING_BALANCE,
      realizedPnl: 0, fees: 0, deployedCapital: 0, killSwitchAt: null };
    prisma = {
      ungatedPaperAccount: {
        findFirst: jest.fn(async () => row),
        create:    jest.fn(async ({ data }) => { row = { ...row, ...data, id: 'a1' }; return row; }),
        update:    jest.fn(async ({ data }) => { row = { ...row, ...data }; return row; }),
      },
    };
    trades = { sumRealized: jest.fn(async () => ({ pnl: 0, fees: 0 })), sumDeployedOpen: jest.fn(async () => 0) };
    const mod = await Test.createTestingModule({
      providers: [
        UngatedPaperAccountService,
        { provide: PrismaService, useValue: prisma },
        { provide: UngatedTradeRepository, useValue: trades },
      ],
    }).compile();
    svc = mod.get(UngatedPaperAccountService);
    await svc.onModuleInit(); // seeds the row
  });

  it('canary: BUY 100 @ 2000 → partial 50 @ 2200 → final 50 @ 1990 leaves invariants intact', async () => {
    // The economic model: fees are REAL money — SEBI/exchange/STT actually leave
    // the account on every leg. So cash decrements by (notional + entryFees) on
    // open and increments by (cashIn − exitFees) on each exit. Without this,
    // the closing invariant `cash == startingBalance + realizedPnl − fees`
    // can't hold (the gated PaperTradeService follows the same rule).
    await svc.applyEntry({ entryPrice: 2000, quantity: 100, entryFees: 40 });
    let a = await svc.snapshot();
    expect(a.cash).toBe(STARTING_BALANCE - 200000 - 40);
    expect(a.deployedCapital).toBe(200000);
    expect(a.realizedPnl).toBe(0);
    expect(a.fees).toBe(40);

    await svc.applyExit({
      entryPrice: 2000, exitPrice: 2200, quantity: 50, sideMul: 1, exitFees: 30,
    });
    a = await svc.snapshot();
    expect(a.cash).toBe(STARTING_BALANCE - 200000 - 40 + 110000 - 30);
    expect(a.deployedCapital).toBe(100000);
    expect(a.realizedPnl).toBe(10000);
    expect(a.fees).toBe(70);

    await svc.applyExit({
      entryPrice: 2000, exitPrice: 1990, quantity: 50, sideMul: 1, exitFees: 25,
    });
    a = await svc.snapshot();
    expect(a.cash).toBe(STARTING_BALANCE - 200000 - 40 + 110000 - 30 + 99500 - 25);
    expect(a.deployedCapital).toBe(0);
    expect(a.realizedPnl).toBe(9500);
    expect(a.fees).toBe(95);

    // Closing invariant: no open positions ⇒ cash equals startingBalance + realizedPnl − fees.
    expect(a.cash).toBe(a.startingBalance + a.realizedPnl - a.fees);
  });

  it('admit() throws UngatedCapitalExhaustedError when cash < TRADE_CAPITAL', async () => {
    prisma.ungatedPaperAccount.findFirst.mockResolvedValue({
      id: 'a1', startingBalance: STARTING_BALANCE, cash: 50000, realizedPnl: 0,
      fees: 0, deployedCapital: 0, killSwitchAt: null,
    });
    await expect(svc.admit({ openTrades: 0 })).rejects.toThrow(/capital-exhausted|capital_exhausted/i);
  });

  it('admit() throws UngatedPositionCapError when openTrades >= 40', async () => {
    await expect(svc.admit({ openTrades: 40 })).rejects.toThrow(/position-cap|position_cap/i);
  });

  it('admit() throws UngatedKillSwitchError when killSwitchAt is set', async () => {
    prisma.ungatedPaperAccount.findFirst.mockResolvedValue({
      id: 'a1', startingBalance: STARTING_BALANCE, cash: STARTING_BALANCE, realizedPnl: 0,
      fees: 0, deployedCapital: 0, killSwitchAt: new Date(),
    });
    await expect(svc.admit({ openTrades: 0 })).rejects.toThrow(/kill-switch|kill_switch/i);
  });
});
