import type { InstrumentRef } from '../hub.types';
import { MemoryCandleRepo } from './memory-candle-repo';

const ist = (s: string) => Date.parse(`${s}+05:30`);
const REF: InstrumentRef = { exchange: 'NSE', token: '2885', symbol: 'RELIANCE' };
const bar = (at: string, close: number, volume = 10) => ({ ts: ist(at), open: close, high: close + 1, low: close - 1, close, volume });

describe('MemoryCandleRepo', () => {
  it('broker overwrites tick; tick never overwrites broker', async () => {
    const r = new MemoryCandleRepo();
    await r.upsert('1m', REF, [bar('2026-10-07T10:00:00', 100)], 'tick');
    await r.upsert('1m', REF, [bar('2026-10-07T10:00:00', 200)], 'broker');
    await r.upsert('1m', REF, [bar('2026-10-07T10:00:00', 300)], 'tick');
    const [c] = await r.read('1m', REF, ist('2026-10-07T00:00:00'), ist('2026-10-08T00:00:00'));
    expect(c.close).toBe(200);
  });

  it('groups 1m bars into 30m buckets aligned to 09:15 IST', async () => {
    const r = new MemoryCandleRepo();
    const bars = Array.from({ length: 60 }, (_, i) => ({
      ts: ist('2026-10-07T09:15:00') + i * 60_000, open: 100 + i, high: 200 + i, low: 50 + i, close: 100 + i, volume: 1,
    }));
    await r.upsert('1m', REF, bars, 'broker');
    const out = await r.readBucketed(REF, 30, 555, ist('2026-10-07T00:00:00'), ist('2026-10-08T00:00:00'));
    expect(out).toEqual([
      { ts: ist('2026-10-07T09:15:00'), open: 100, high: 229, low: 50, close: 129, volume: 30 },
      { ts: ist('2026-10-07T09:45:00'), open: 130, high: 259, low: 80, close: 159, volume: 30 },
    ]);
  });

  it('a duplicate ts inside one upsert keeps the last occurrence', async () => {
    const r = new MemoryCandleRepo();
    const t = '2026-10-07T10:00:00';
    await r.upsert('1m', REF, [bar(t, 1), bar(t, 2)], 'broker');
    const m = await r.read('1m', REF, ist(t), ist(t) + 60_000);
    expect(m).toHaveLength(1);
    expect(m[0].close).toBe(2);
    const d = '2026-10-07T00:00:00';
    await r.upsert('1d', REF, [bar(d, 1), bar(d, 2)], 'broker');
    const day = await r.read('1d', REF, ist(d), ist('2026-10-08T00:00:00'));
    expect(day).toHaveLength(1);
    expect(day[0].close).toBe(2);
  });

  it('counts per IST day, remembers coverage, lists tick instruments', async () => {
    const r = new MemoryCandleRepo();
    await r.upsert('1m', REF, [bar('2026-10-07T23:50:00', 1), bar('2026-10-08T00:10:00', 2)], 'tick');
    expect(await r.dayCounts('1m', REF, ist('2026-10-07T00:00:00'), ist('2026-10-09T00:00:00'))).toEqual(
      new Map([['2026-10-07', 1], ['2026-10-08', 1]]),
    );
    await r.markCovered('1m', REF, ['2026-10-06']);
    expect(await r.coveredDays('1m', REF, ['2026-10-06', '2026-10-05'])).toEqual(new Set(['2026-10-06']));
    expect(await r.tickInstruments(ist('2026-10-08T00:00:00'))).toEqual([{ exchange: 'NSE', token: '2885' }]);
  });
});
