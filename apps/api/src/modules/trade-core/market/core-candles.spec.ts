import type { ModuleRef } from '@nestjs/core';
import { HUB_CANDLE_SOURCE } from '../../market-hub/hub-candle-source';
import { CoreCandles } from './core-candles';

const REF = { exchange: 'NSE' as const, token: '2885', symbol: 'RELIANCE-EQ' };
const from = new Date('2026-10-10T03:45:00.000Z');
const to = new Date('2026-10-13T05:00:00.000Z');

function make(source: unknown, throws = false) {
  const moduleRef = {
    get: jest.fn((token: string) => {
      if (throws || token !== HUB_CANDLE_SOURCE) throw new Error('no market hub in this container');
      return source;
    }),
  };
  return new CoreCandles(moduleRef as unknown as ModuleRef);
}

describe('CoreCandles (ruling J7)', () => {
  it('reads the hub candle store and says whether the range is complete', async () => {
    const candles = jest.fn().mockResolvedValue({ candles: [{ ts: 1, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }], incomplete: [{ from: 0, to: 1, reason: 'throttled' }] });
    const r = await make({ servesCharts: () => true, candles }).read(REF, '5m', from, to);
    expect(r).toEqual({ ok: true, candles: [expect.objectContaining({ close: 1.5 })], complete: false });
    expect(candles).toHaveBeenCalledWith(REF, '5m', from, to);
  });

  it('no hub, candles off, or a failing read is a reason, never a throw', async () => {
    expect(await make(null, true).read(REF, '5m', from, to)).toEqual({ ok: false, reason: 'no market hub in this container' });
    expect(await make({ servesCharts: () => false, candles: jest.fn() }).read(REF, '5m', from, to)).toEqual({ ok: false, reason: 'hub candles are off (HUB_CANDLES_ENABLED / HUB_SERVES_CHARTS)' });
    expect(await make({ servesCharts: () => true, candles: jest.fn().mockRejectedValue(new Error('broker down')) }).read(REF, '5m', from, to)).toEqual({ ok: false, reason: 'broker down' });
  });
});
