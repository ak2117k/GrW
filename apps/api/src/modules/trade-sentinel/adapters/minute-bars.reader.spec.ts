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
});
