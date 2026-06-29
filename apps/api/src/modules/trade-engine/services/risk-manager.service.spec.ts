import { Test } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { RiskManagerService } from './risk-manager.service';
import { SettingsService } from '../../settings/services/settings.service';
import { TradeRepository } from '../repositories/trade.repository';
import { PaperTradeService } from './paper-trade.service';

describe('RiskManagerService.getDailyRiskStatus', () => {
  it('reports capitalDeployed as the summed entry value of open trades', async () => {
    // Regression: capitalDeployed was read from an in-memory counter that
    // only advanced as a side effect of a matching market tick — so it sat
    // at ₹0 even with open positions. It must be derived from the open
    // trades the method already fetches (consistent with positionsUsed).
    const openTrades = [
      { entryPrice: 1000, quantity: 10 }, // ₹10,000
      { entryPrice: 250.5, quantity: 4 }, // ₹1,002
    ];
    const mod = await Test.createTestingModule({
      providers: [
        RiskManagerService,
        {
          provide: SettingsService,
          useValue: {
            getSettings: jest.fn().mockResolvedValue({
              maxDailyLoss: 5000,
              maxConcurrentPositions: 10,
              maxCapitalPerTrade: 200000,
            }),
          },
        },
        {
          provide: TradeRepository,
          useValue: {
            getDailyPnL: jest.fn().mockResolvedValue(0),
            getOpenTrades: jest.fn().mockResolvedValue(openTrades),
          },
        },
        {
          provide: PaperTradeService,
          useValue: { getVirtualBalance: jest.fn().mockReturnValue(2_000_000) },
        },
      ],
    }).compile();
    const svc = mod.get(RiskManagerService);

    const status = await svc.getDailyRiskStatus();

    expect(status.capitalDeployed).toBe(1000 * 10 + 250.5 * 4);
  });
});

describe('RiskManagerService — trade-rejection logging', () => {
  /**
   * Every rejection branch must emit one consistent, greppable
   * `[trade-rejected]` line via formatTradeRejection so the operator can
   * always answer "why was this not traded?" from the console.
   */
  const baseRequest = {
    symbol: 'TCS-EQ',
    token: '11536',
    exchange: 'NSE',
    side: 'BUY' as any,
    orderType: 'MARKET' as any,
    quantity: 10,
    positionType: 'INTRADAY' as any,
    price: 4000,
  };

  function buildModule(opts: {
    settings: any;
    openTrades?: any[];
    dailyPnl?: number;
    virtualBalance?: number;
  }) {
    return Test.createTestingModule({
      providers: [
        RiskManagerService,
        {
          provide: SettingsService,
          useValue: {
            getSettings: jest.fn().mockResolvedValue(opts.settings),
          },
        },
        {
          provide: TradeRepository,
          useValue: {
            getDailyPnL: jest.fn().mockResolvedValue(opts.dailyPnl ?? 0),
            getOpenTrades: jest.fn().mockResolvedValue(opts.openTrades ?? []),
          },
        },
        {
          provide: PaperTradeService,
          useValue: {
            getVirtualBalance: jest
              .fn()
              .mockReturnValue(opts.virtualBalance ?? 2_000_000),
          },
        },
      ],
    }).compile();
  }

  it('emits a [trade-rejected] line when the kill switch is active', async () => {
    const mod = await buildModule({
      settings: {
        maxDailyLoss: 5000,
        maxConcurrentPositions: 10,
        maxCapitalPerTrade: 200000,
        paperTrading: true,
        tradingHoursOnly: false,
      },
    });
    const svc = mod.get(RiskManagerService);
    svc.activateKillSwitch('test halt');
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();

    const result = await svc.validateTrade(baseRequest);

    expect(result.allowed).toBe(false);
    const line = warn.mock.calls.map((c) => String(c[0])).find((s) => s.startsWith('[trade-rejected]'));
    expect(line).toBeDefined();
    expect(line).toContain('TCS-EQ');
    expect(line).toContain('stage=execution');
    expect(line).toContain('side=BUY');
    expect(line).toMatch(/reason="Kill switch active/);
    warn.mockRestore();
  });

  it('emits a [trade-rejected] line when the daily-loss breaker trips', async () => {
    const mod = await buildModule({
      settings: {
        maxDailyLoss: 5000,
        maxConcurrentPositions: 10,
        maxCapitalPerTrade: 200000,
        paperTrading: true,
        tradingHoursOnly: false,
      },
      dailyPnl: -6000,
    });
    const svc = mod.get(RiskManagerService);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();

    const result = await svc.validateTrade(baseRequest);

    expect(result.allowed).toBe(false);
    const line = warn.mock.calls.map((c) => String(c[0])).find((s) => s.startsWith('[trade-rejected]'));
    expect(line).toBeDefined();
    expect(line).toContain('stage=execution');
    expect(line).toMatch(/reason="Max daily loss/);
    warn.mockRestore();
  });

  it('emits a [trade-rejected] line when max concurrent positions is reached', async () => {
    const mod = await buildModule({
      settings: {
        maxDailyLoss: 5000,
        maxConcurrentPositions: 2,
        maxCapitalPerTrade: 200000,
        paperTrading: true,
        tradingHoursOnly: false,
      },
      openTrades: [{ entryPrice: 1, quantity: 1 }, { entryPrice: 1, quantity: 1 }],
    });
    const svc = mod.get(RiskManagerService);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();

    const result = await svc.validateTrade(baseRequest);

    expect(result.allowed).toBe(false);
    const line = warn.mock.calls.map((c) => String(c[0])).find((s) => s.startsWith('[trade-rejected]'));
    expect(line).toBeDefined();
    expect(line).toContain('stage=execution');
    expect(line).toMatch(/reason="Max concurrent positions/);
    warn.mockRestore();
  });

  it('emits a [trade-rejected] line when order value exceeds max capital per trade', async () => {
    const mod = await buildModule({
      settings: {
        maxDailyLoss: 5000,
        maxConcurrentPositions: 10,
        maxCapitalPerTrade: 1000,
        paperTrading: true,
        tradingHoursOnly: false,
      },
    });
    const svc = mod.get(RiskManagerService);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();

    const result = await svc.validateTrade(baseRequest);

    expect(result.allowed).toBe(false);
    const line = warn.mock.calls.map((c) => String(c[0])).find((s) => s.startsWith('[trade-rejected]'));
    expect(line).toBeDefined();
    expect(line).toContain('stage=execution');
    expect(line).toMatch(/reason="Order value/);
    warn.mockRestore();
  });

  it('emits a [trade-rejected] line when paper cash is insufficient', async () => {
    const mod = await buildModule({
      settings: {
        maxDailyLoss: 5000,
        maxConcurrentPositions: 10,
        maxCapitalPerTrade: 200000,
        paperTrading: true,
        tradingHoursOnly: false,
      },
      virtualBalance: 100,
    });
    const svc = mod.get(RiskManagerService);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();

    const result = await svc.validateTrade(baseRequest);

    expect(result.allowed).toBe(false);
    const line = warn.mock.calls.map((c) => String(c[0])).find((s) => s.startsWith('[trade-rejected]'));
    expect(line).toBeDefined();
    expect(line).toContain('stage=execution');
    expect(line).toMatch(/reason="Insufficient paper cash/);
    warn.mockRestore();
  });

  it('emits a [trade-rejected] line when a duplicate position exists', async () => {
    const mod = await buildModule({
      settings: {
        maxDailyLoss: 5000,
        maxConcurrentPositions: 10,
        maxCapitalPerTrade: 200000,
        paperTrading: false,
        tradingHoursOnly: false,
      },
      openTrades: [
        {
          entryPrice: 1,
          quantity: 1,
          side: 'BUY',
          instrument: { symbol: 'TCS-EQ', exchange: 'NSE' },
        },
      ],
    });
    const svc = mod.get(RiskManagerService);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();

    const result = await svc.validateTrade(baseRequest);

    expect(result.allowed).toBe(false);
    const line = warn.mock.calls.map((c) => String(c[0])).find((s) => s.startsWith('[trade-rejected]'));
    expect(line).toBeDefined();
    expect(line).toContain('stage=execution');
    expect(line).toMatch(/reason="Duplicate position/);
    warn.mockRestore();
  });

  it('emits a [trade-rejected] line when outside trading hours', async () => {
    const mod = await buildModule({
      settings: {
        maxDailyLoss: 5000,
        maxConcurrentPositions: 10,
        maxCapitalPerTrade: 200000,
        paperTrading: false,
        tradingHoursOnly: true,
      },
    });
    const svc = mod.get(RiskManagerService);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    // Pin "now" outside any market session (03:00 IST).
    const realDate = Date;
    const fixed = new realDate('2026-05-18T03:00:00+05:30');
    jest
      .spyOn(global, 'Date')
      .mockImplementation(((...args: any[]) =>
        args.length ? new (realDate as any)(...args) : fixed) as any);

    const result = await svc.validateTrade(baseRequest);

    (global.Date as any).mockRestore();
    expect(result.allowed).toBe(false);
    const line = warn.mock.calls.map((c) => String(c[0])).find((s) => s.startsWith('[trade-rejected]'));
    expect(line).toBeDefined();
    expect(line).toContain('stage=execution');
    expect(line).toMatch(/reason="Outside trading hours/);
    warn.mockRestore();
  });

  it('ALLOWS a resting paper LIMIT order outside trading hours (it rests until next session)', async () => {
    const mod = await buildModule({
      settings: {
        maxDailyLoss: 5000,
        maxConcurrentPositions: 10,
        maxCapitalPerTrade: 200000,
        paperTrading: true,
        tradingHoursOnly: true,
      },
    });
    const svc = mod.get(RiskManagerService);
    const realDate = Date;
    const fixed = new realDate('2026-05-18T03:00:00+05:30'); // 03:00 IST — closed
    jest
      .spyOn(global, 'Date')
      .mockImplementation(((...args: any[]) =>
        args.length ? new (realDate as any)(...args) : fixed) as any);

    // Resting paper LIMIT order — exempt from the hours gate.
    const limitOk = await svc.validateTrade({
      ...baseRequest,
      orderType: 'LIMIT' as any,
      isPaper: true as any,
    } as any);
    // A MARKET order at the same closed time is still rejected.
    const marketBlocked = await svc.validateTrade({
      ...baseRequest,
      orderType: 'MARKET' as any,
      isPaper: true as any,
    } as any);
    // A LIVE limit order (isPaper:false) still respects the hours gate.
    const liveLimitBlocked = await svc.validateTrade({
      ...baseRequest,
      orderType: 'LIMIT' as any,
      isPaper: false as any,
    } as any);

    (global.Date as any).mockRestore();
    expect(limitOk.allowed).toBe(true);
    expect(marketBlocked.allowed).toBe(false);
    expect(marketBlocked.reason).toMatch(/Outside trading hours/);
    expect(liveLimitBlocked.allowed).toBe(false);
    expect(liveLimitBlocked.reason).toMatch(/Outside trading hours/);
  });
});
