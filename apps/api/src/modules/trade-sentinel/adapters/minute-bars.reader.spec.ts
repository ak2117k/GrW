import { MinuteBarsReader } from './minute-bars.reader';

describe('MinuteBarsReader', () => {
  const REF = { exchange: 'MCX', token: '582930', symbol: 'CRUDEOIL17NOV269000CE' };
  const NOW = new Date('2026-10-14T11:01:20Z'); // 16:31:20 IST
  it('reads candles_1m for the last 120 minutes of the IST day and caches 20 s', async () => {
    const read = jest.fn(async () => [{ ts: 1, open: 1, high: 2, low: 1, close: 2, volume: 0 }]);
    const r = new MinuteBarsReader({ read } as never);
    await expect(r.recent(REF, NOW)).resolves.toEqual([{ ts: 1, open: 1, high: 2, low: 1, close: 2 }]);
    expect(read).toHaveBeenCalledWith('1m', REF, NOW.getTime() - 120 * 60_000, NOW.getTime());
    await r.recent(REF, new Date(NOW.getTime() + 19_000));
    expect(read).toHaveBeenCalledTimes(1);
    await r.recent(REF, new Date(NOW.getTime() + 21_000));
    expect(read).toHaveBeenCalledTimes(2);
  });
  it('never reaches before IST midnight', async () => {
    const read = jest.fn(async () => []);
    const early = new Date('2026-10-13T19:00:00Z'); // 00:30 IST
    await new MinuteBarsReader({ read } as never).recent(REF, early);
    expect(read).toHaveBeenCalledWith('1m', REF, Date.parse('2026-10-13T18:30:00Z'), early.getTime());
  });
  it('a DB error is an empty read, never a throw', async () => {
    const r = new MinuteBarsReader({ read: jest.fn(async () => { throw new Error('db'); }) } as never);
    await expect(r.recent(REF, NOW)).resolves.toEqual([]);
  });
  it('closeAt: the last stored bar in the five minutes up to the anchor minute; null when none or on a DB error', async () => {
    const at = new Date('2026-10-14T04:00:42Z');
    const minute = Date.parse('2026-10-14T04:00:00Z');
    const read = jest.fn(async () => [{ ts: minute - 120_000, open: 1, high: 2, low: 1, close: 24_010, volume: 0 }, { ts: minute, open: 1, high: 2, low: 1, close: 24_020, volume: 0 }]);
    await expect(new MinuteBarsReader({ read } as never).closeAt(REF, at)).resolves.toBe(24_020);
    expect(read).toHaveBeenCalledWith('1m', REF, minute - 4 * 60_000, minute + 60_000);
    await expect(new MinuteBarsReader({ read: jest.fn(async () => []) } as never).closeAt(REF, at)).resolves.toBeNull();
    await expect(new MinuteBarsReader({ read: jest.fn(async () => { throw new Error('db'); }) } as never).closeAt(REF, at)).resolves.toBeNull();
  });

  describe('n15 (catastrophe floor: the underlying 15-minute noise unit)', () => {
    // 2026-10-14 MCX session bars from 09:00 IST, 15 minutes each, high−low 20, flat closes.
    const bars = Array.from({ length: 20 }, (_, i) => {
      const ts = Date.parse('2026-10-14T03:30:00Z') + i * 15 * 60_000;
      return { ts, open: 9000, high: 9010, low: 8990, close: 9000, volume: 0 };
    });
    it('reads 15-minute buckets (origin 09:15 IST) over 5 days, ATR14 of them, cached 60 s', async () => {
      const readBucketed = jest.fn(async () => bars);
      const r = new MinuteBarsReader({ read: jest.fn(), readBucketed } as never);
      await expect(r.n15(REF, NOW)).resolves.toMatchObject({ n: 20, bars: 14, method: 'atr14-15m' });
      expect(readBucketed).toHaveBeenCalledWith(REF, 15, 555, NOW.getTime() - 5 * 86_400_000, NOW.getTime());
      await r.n15(REF, new Date(NOW.getTime() + 59_000));
      expect(readBucketed).toHaveBeenCalledTimes(1);
    });
    it('a failed read, too few bars, or a repo without bucketed reads ⇒ null (never throws)', async () => {
      await expect(new MinuteBarsReader({ read: jest.fn(), readBucketed: jest.fn(async () => { throw new Error('db'); }) } as never).n15(REF, NOW)).resolves.toBeNull();
      await expect(new MinuteBarsReader({ read: jest.fn(), readBucketed: jest.fn(async () => bars.slice(0, 3)) } as never).n15(REF, NOW)).resolves.toBeNull();
      await expect(new MinuteBarsReader({ read: jest.fn() } as never).n15(REF, NOW)).resolves.toBeNull();
    });
  });
});
