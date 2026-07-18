import { Test, TestingModule } from '@nestjs/testing';
import { PortfolioService } from './portfolio.service';
import { PortfolioRepository } from '../repositories/portfolio.repository';

/**
 * Unit tests for PortfolioService.getChartTrades — the CORRECTED chart-trade
 * annotation contract (docs/superpowers/specs/2026-07-17-chart-trade-annotations-design.md
 * §"CORRECTION (2026-07-18)").
 *
 * The endpoint now reads the real paper positions — swing_entries /
 * intraday_entries / breakout_swing_entries — by `token` (NO per-user scoping,
 * NO share quantities) and returns { positions: PositionMarker[] } shaped as
 * status + % result. The repository (Prisma queries + alert→scanner resolution)
 * is mocked; the shaping is what's under test.
 */
describe('PortfolioService — getChartTrades', () => {
  let module: TestingModule;
  let service: PortfolioService;
  let getPositionEntriesByToken: jest.Mock;

  const build = async () => {
    module = await Test.createTestingModule({
      providers: [
        PortfolioService,
        {
          provide: PortfolioRepository,
          useValue: { getPositionEntriesByToken },
        },
      ],
    }).compile();
    service = module.get(PortfolioService);
  };

  // Convenience for deterministic timestamps.
  const at = (min: number) => new Date(Date.UTC(2026, 6, 17, 9, min, 0));

  // Default empty repo payload; individual tests override the track they exercise.
  const payload = (over: Partial<{
    swing: any[];
    intraday: any[];
    breakout: any[];
    scannerByAlertId: Record<string, string>;
  }>) => ({
    swing: [],
    intraday: [],
    breakout: [],
    scannerByAlertId: {},
    ...over,
  });

  beforeEach(() => {
    getPositionEntriesByToken = jest.fn();
  });

  it('returns { positions: [] } when there are no positions for the token', async () => {
    getPositionEntriesByToken.mockResolvedValue(payload({}));
    await build();

    const result = await service.getChartTrades('99999');

    expect(result).toEqual({ positions: [] });
    expect(getPositionEntriesByToken).toHaveBeenCalledWith('99999');
  });

  it('shapes an exited SWING long with pnlPct = (exit − entry)/entry × 100, rounded to 2dp', async () => {
    getPositionEntriesByToken.mockResolvedValue(
      payload({
        swing: [
          {
            id: 'swing-1',
            token: '123',
            alertId: 'alert-1',
            entryPrice: 1000,
            enteredAt: at(0),
            targetPct: 10,
            stopPct: 10,
            status: 'TARGET_HIT',
            exitPrice: 1012.345, // 1.2345% → rounds to 1.23
            exitedAt: at(30),
          },
        ],
        scannerByAlertId: { 'alert-1': 'Weekly Breakout Scan' },
      }),
    );
    await build();

    const { positions } = await service.getChartTrades('123');

    expect(positions).toHaveLength(1);
    expect(positions[0]).toEqual({
      id: 'swing-1',
      track: 'SWING',
      provenance: 'Weekly Breakout Scan',
      status: 'TARGET_HIT',
      targetPct: 10,
      stopPct: 10,
      entry: { time: at(0).getTime(), price: 1000 },
      partial: null,
      exit: {
        time: at(30).getTime(),
        price: 1012.345,
        status: 'TARGET_HIT',
        pnlPct: 1.23,
        reason: null, // SwingEntry has no exitReason field → null
      },
    });
  });

  it('leaves exit null for an open SWING position and falls back to the track label', async () => {
    getPositionEntriesByToken.mockResolvedValue(
      payload({
        swing: [
          {
            id: 'swing-open',
            token: '123',
            alertId: 'alert-x',
            entryPrice: 500,
            enteredAt: at(0),
            targetPct: 10,
            stopPct: 10,
            status: 'TRADED',
            exitPrice: null,
            exitedAt: null,
          },
        ],
        scannerByAlertId: {}, // alert-x not resolved → fallback
      }),
    );
    await build();

    const { positions } = await service.getChartTrades('123');

    expect(positions[0].exit).toBeNull();
    expect(positions[0].entry).toEqual({ time: at(0).getTime(), price: 500 });
    expect(positions[0].provenance).toBe('Swing');
  });

  it('shapes the intraday partial book and carries exitReason on the exit', async () => {
    getPositionEntriesByToken.mockResolvedValue(
      payload({
        intraday: [
          {
            id: 'intra-1',
            token: '123',
            alertId: 'alert-2',
            entryPrice: 200,
            enteredAt: at(0),
            targetPct: 5,
            stopPct: 5,
            status: 'STOPPED',
            partialBookedAt: at(10),
            partialExitPrice: 210,
            partialFraction: 0.5,
            exitPrice: 190,
            exitedAt: at(20),
            exitReason: 'TRAIL_STOP',
          },
        ],
        scannerByAlertId: { 'alert-2': 'Intraday Momentum' },
      }),
    );
    await build();

    const { positions } = await service.getChartTrades('123');

    expect(positions[0].track).toBe('INTRADAY');
    expect(positions[0].provenance).toBe('Intraday Momentum');
    expect(positions[0].partial).toEqual({
      time: at(10).getTime(),
      price: 210,
      fraction: 0.5,
    });
    expect(positions[0].exit).toEqual({
      time: at(20).getTime(),
      price: 190,
      status: 'STOPPED',
      pnlPct: -5, // (190-200)/200*100
      reason: 'TRAIL_STOP',
    });
  });

  it('leaves partial null for an intraday position that has not booked partially', async () => {
    getPositionEntriesByToken.mockResolvedValue(
      payload({
        intraday: [
          {
            id: 'intra-2',
            token: '123',
            alertId: 'alert-2',
            entryPrice: 200,
            enteredAt: at(0),
            targetPct: 5,
            stopPct: 5,
            status: 'TRADED',
            partialBookedAt: null,
            partialExitPrice: null,
            partialFraction: null,
            exitPrice: null,
            exitedAt: null,
            exitReason: null,
          },
        ],
      }),
    );
    await build();

    const { positions } = await service.getChartTrades('123');
    expect(positions[0].partial).toBeNull();
    expect(positions[0].exit).toBeNull();
  });

  it('emits an entered BREAKOUT position and skips a QUEUED one with no entry', async () => {
    getPositionEntriesByToken.mockResolvedValue(
      payload({
        breakout: [
          {
            id: 'brk-queued',
            token: '123',
            alertId: 'alert-3',
            entryPrice: null, // QUEUED — nothing to plot
            enteredAt: null,
            targetPct: 10,
            stopPct: 10,
            status: 'QUEUED',
            quantity: 7, // ignored
            exitPrice: null,
            exitedAt: null,
            exitReason: null,
          },
          {
            id: 'brk-filled',
            token: '123',
            alertId: 'alert-3',
            entryPrice: 800,
            enteredAt: at(0),
            targetPct: 10,
            stopPct: 10,
            status: 'TRADED',
            quantity: 7, // ignored
            exitPrice: null,
            exitedAt: null,
            exitReason: null,
          },
        ],
        scannerByAlertId: {}, // fallback to track label
      }),
    );
    await build();

    const { positions } = await service.getChartTrades('123');

    expect(positions).toHaveLength(1);
    expect(positions[0].id).toBe('brk-filled');
    expect(positions[0].track).toBe('BREAKOUT');
    expect(positions[0].provenance).toBe('Breakout');
    expect(positions[0].entry).toEqual({ time: at(0).getTime(), price: 800 });
    expect(positions[0].exit).toBeNull();
  });

  it('combines all three tracks and resolves provenance per-row via the map', async () => {
    getPositionEntriesByToken.mockResolvedValue(
      payload({
        swing: [
          {
            id: 's',
            token: '123',
            alertId: 'a-swing',
            entryPrice: 100,
            enteredAt: at(0),
            targetPct: 10,
            stopPct: 10,
            status: 'TRADED',
            exitPrice: null,
            exitedAt: null,
          },
        ],
        intraday: [
          {
            id: 'i',
            token: '123',
            alertId: 'a-intra',
            entryPrice: 100,
            enteredAt: at(0),
            targetPct: 5,
            stopPct: 5,
            status: 'TRADED',
            partialBookedAt: null,
            partialExitPrice: null,
            partialFraction: null,
            exitPrice: null,
            exitedAt: null,
            exitReason: null,
          },
        ],
        breakout: [
          {
            id: 'b',
            token: '123',
            alertId: 'a-brk',
            entryPrice: 100,
            enteredAt: at(0),
            targetPct: 10,
            stopPct: 10,
            status: 'TRADED',
            exitPrice: null,
            exitedAt: null,
            exitReason: null,
          },
        ],
        scannerByAlertId: { 'a-swing': 'Swing Scan', 'a-brk': 'Breakout Scan' },
      }),
    );
    await build();

    const { positions } = await service.getChartTrades('123');
    const byId = Object.fromEntries(positions.map((p) => [p.id, p]));

    expect(positions).toHaveLength(3);
    expect(byId['s'].provenance).toBe('Swing Scan');
    expect(byId['i'].provenance).toBe('Intraday'); // unresolved → track label
    expect(byId['b'].provenance).toBe('Breakout Scan');
  });
});
