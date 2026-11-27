import { AlarmChartRepository } from './alarm-chart.reader';
import { INDEX_UNDERLYINGS } from '../../market-hub/underlying';

/** The alarm look's chart read: the underlying's CLOSED session bars, a DB read (copied from the executor's reader, R14). */
const ist = (hms: string) => new Date(`2026-11-27T${hms}+05:30`);

function make() {
  const readBucketed = jest.fn(async (_r: unknown, step: number) => {
    // 10:00, 10:15 … 11:00 IST buckets; the 11:00 one is still open at 11:05.
    const starts = ['10:00:00', '10:15:00', '10:30:00', '10:45:00', '11:00:00'].map((s) => ist(s).getTime());
    return starts.map((ts, i) => ({ ts: step === 5 ? ts + 10 * 60_000 : ts, open: 100 + i, high: 102 + i, low: 99 + i, close: 101 + i, volume: BigInt(10) }));
  });
  const lookup = {
    tracker: jest.fn(async () => ({ symbol: 'NIFTY02DEC2626000CE', exchange: 'NFO', token: '55' })),
    contract: jest.fn(async () => ({ name: 'NIFTY' })),
    nearestFuture: jest.fn(),
    cashRef: jest.fn(),
  };
  return { repo: new AlarmChartRepository({ readBucketed } as never, lookup), readBucketed, lookup };
}

describe('AlarmChartRepository', () => {
  it('reads the index underlying, keeps only CLOSED bars, ascending, with volumes as numbers', async () => {
    const t = make();
    const d = await t.repo.read('t1', ist('11:05:00'));
    expect(d?.ref).toEqual({ exchange: INDEX_UNDERLYINGS.NIFTY.exchange, token: INDEX_UNDERLYINGS.NIFTY.token, symbol: INDEX_UNDERLYINGS.NIFTY.symbol });
    expect(t.readBucketed.mock.calls.map((c) => c[1])).toEqual([5, 15]);
    // 15m: the 11:00 bucket is open at 11:05 ⇒ dropped.
    expect(d!.bars15.map((b) => b.close)).toEqual([101, 102, 103, 104]);
    expect(d!.bars15.every((b, i, a) => i === 0 || a[i - 1].ts < b.ts)).toBe(true);
    expect(typeof d!.bars5[0].volume).toBe('number');
  });

  it('unknown tracker ⇒ null; a failing candle read rejects (the cycle words it as unavailable)', async () => {
    const t = make();
    t.lookup.tracker.mockResolvedValueOnce(null as never);
    expect(await t.repo.read('gone', ist('11:05:00'))).toBeNull();
    t.readBucketed.mockRejectedValueOnce(new Error('db down'));
    await expect(t.repo.read('t2', ist('11:05:00'))).rejects.toThrow('db down');
  });
});
