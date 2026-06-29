import { AnandPriceMonitorService } from '../anand-price-monitor.service';

const entry = { entryPrice: 100, targetPct: 5, stopPct: 5, trailing: false, peakPrice: null as number | null, stopMovedToBE: false };

describe('AnandPriceMonitorService.decideIntradayTrail', () => {
  it('arms trailing (no exit) the first time price reaches +5%', () => {
    const d = AnandPriceMonitorService.decideIntradayTrail({ ...entry }, 105, null);
    expect(d).toEqual({ action: 'ARM_TRAIL', peakPrice: 105 });
  });

  it('stops out below -5% before trailing arms', () => {
    const d = AnandPriceMonitorService.decideIntradayTrail({ ...entry }, 94, null);
    expect(d.action).toBe('STOP');
  });

  it('holds while trailing and above the Supertrend line', () => {
    const e = { ...entry, trailing: true, peakPrice: 108 };
    const d = AnandPriceMonitorService.decideIntradayTrail(e, 110, 106);
    expect(d).toEqual({ action: 'HOLD', peakPrice: 110 });
  });

  it('exits TRAIL_ST when price drops below the Supertrend line', () => {
    const e = { ...entry, trailing: true, peakPrice: 112 };
    const d = AnandPriceMonitorService.decideIntradayTrail(e, 109, 110);
    expect(d).toEqual({ action: 'EXIT', exitReason: 'TRAIL_ST', peakPrice: 112 });
  });

  it('falls back to 2% give-back when Supertrend is unavailable', () => {
    const e = { ...entry, trailing: true, peakPrice: 120 };
    // 2% below peak 120 = 117.6; 117 < 117.6 → exit
    const d = AnandPriceMonitorService.decideIntradayTrail(e, 117, null);
    expect(d).toEqual({ action: 'EXIT', exitReason: 'TRAIL_GB', peakPrice: 120 });
  });
});
