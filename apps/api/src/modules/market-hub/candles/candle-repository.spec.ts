import { BANKNIFTY_23NOV_1M, BANKNIFTY_REF, ist } from '../testing/banknifty-2026-11-23-preopen';
import { capturedSql, rowsPassing, sessionBounds } from '../testing/captured-sql';
import { MemoryCandleRepo } from '../testing/memory-candle-repo';
import type { InstrumentRef } from '../hub.types';
import { PrismaCandleRepo } from './candle-repository';
import { sessionMinuteFilter } from './session-sql';

const NSE = BANKNIFTY_REF as unknown as InstrumentRef;
const MCX: InstrumentRef = { exchange: 'MCX', token: '495213', symbol: 'GOLD04DEC26FUT' } as InstrumentRef;
const DAY0 = ist('2026-11-23 00:00');
const DAY1 = ist('2026-11-24 00:00');

function fakeDb() {
  return { $queryRaw: jest.fn().mockResolvedValue([]), $executeRaw: jest.fn().mockResolvedValue(0) };
}

describe('sessionMinuteFilter (SQL form of exit-discipline/session-bars)', () => {
  const render = (ex: string | null, col?: string) => {
    const f = sessionMinuteFilter(ex, col);
    return { text: f.sql, values: f.values };
  };

  it('NSE / NFO / BSE / BFO: [09:15, 15:30) IST; MCX: [09:00, 23:55); unknown venue: no filter', () => {
    for (const ex of ['NSE', 'nfo', 'BSE', 'BFO']) expect(render(ex).values).toEqual(['09:15', '15:30']);
    expect(render('MCX').values).toEqual(['09:00', '23:55']);
    expect(render('CDS')).toEqual({ text: '', values: [] });
    expect(render(null)).toEqual({ text: '', values: [] });
    expect(render('NSE').text).toBe(
      " AND (ts AT TIME ZONE 'Asia/Kolkata')::time >= ?::time AND (ts AT TIME ZONE 'Asia/Kolkata')::time < ?::time",
    );
  });

  it('takes a qualified column, refuses anything that is not an identifier', () => {
    expect(render('NSE', 'c.ts').text).toContain('(c.ts AT TIME ZONE');
    expect(() => sessionMinuteFilter('NSE', 'ts); DROP TABLE x; --')).toThrow(/bad column/);
  });
});

describe('PrismaCandleRepo reads session minutes only', () => {
  it('read(1m): the NSE filter is in the query — BANKNIFTY 23-Nov keeps 09:15 onwards, never the pre-open auction', async () => {
    const db = fakeDb();
    await new PrismaCandleRepo(db as never).read('1m', NSE, DAY0, DAY1);
    const q = capturedSql(db.$queryRaw.mock.calls);
    expect(sessionBounds(q)).toEqual({ from: '09:15', to: '15:30' });
    const kept = rowsPassing(q, BANKNIFTY_23NOV_1M);
    expect(kept[0].ts).toBe(ist('2026-11-23 09:15'));
    expect(kept).toHaveLength(15); // 09:15–09:29
    expect(Math.max(...kept.map((b) => b.high))).toBe(65182.45); // not the pre-open 65,489
  });

  it('read(1m) on MCX keeps 09:00–23:54; read(1h / 1d) (broker bars) has no filter', async () => {
    const db = fakeDb();
    const repo = new PrismaCandleRepo(db as never);
    await repo.read('1m', MCX, DAY0, DAY1);
    await repo.read('1h', NSE, DAY0, DAY1);
    await repo.read('1d', NSE, DAY0, DAY1);
    expect(sessionBounds(capturedSql(db.$queryRaw.mock.calls, 0))).toEqual({ from: '09:00', to: '23:55' });
    expect(sessionBounds(capturedSql(db.$queryRaw.mock.calls, 1))).toBeNull();
    expect(sessionBounds(capturedSql(db.$queryRaw.mock.calls, 2))).toBeNull();
  });

  it('readBucketed: filter before date_bin, origin passed through (NSE 09:15 grid; the 1440 day bar from session minutes)', async () => {
    const db = fakeDb();
    const repo = new PrismaCandleRepo(db as never);
    await repo.readBucketed(NSE, 15, 555, DAY0, DAY1);
    await repo.readBucketed(NSE, 1440, 0, DAY0, DAY1);
    await repo.readBucketed(MCX, 15, 540, DAY0, DAY1);
    const q15 = capturedSql(db.$queryRaw.mock.calls, 0);
    expect(q15.text).toMatch(/date_bin\(/);
    expect(q15.values).toContain('15 minutes');
    expect(q15.values).toContain('2000-01-03T09:15:00+05:30');
    expect(sessionBounds(q15)).toEqual({ from: '09:15', to: '15:30' });
    const qDay = capturedSql(db.$queryRaw.mock.calls, 1);
    expect(qDay.values).toContain('1440 minutes');
    expect(sessionBounds(qDay)).toEqual({ from: '09:15', to: '15:30' });
    const qMcx = capturedSql(db.$queryRaw.mock.calls, 2);
    expect(qMcx.values).toContain('2000-01-03T09:00:00+05:30');
    expect(sessionBounds(qMcx)).toEqual({ from: '09:00', to: '23:55' });
  });

  it('dayCounts (the gap check) still counts every stored row', async () => {
    const db = fakeDb();
    await new PrismaCandleRepo(db as never).dayCounts('1m', NSE, DAY0, DAY1);
    expect(sessionBounds(capturedSql(db.$queryRaw.mock.calls))).toBeNull();
  });
});

describe('MemoryCandleRepo mirrors the session filter', () => {
  const offHours = (d: string, close: number) => [
    { ts: ist(`${d} 02:00`), open: close, high: close, low: close, close, volume: 0 },
    { ts: ist(`${d} 15:30`), open: close, high: close, low: close, close, volume: 0 },
    { ts: ist(`${d} 18:00`), open: close, high: close, low: close, close, volume: 0 },
  ];

  it('1m read and 15m buckets: no pre-open, no off-hours; buckets on the 09:15 grid', async () => {
    const r = new MemoryCandleRepo();
    await r.upsert('1m', NSE, [...BANKNIFTY_23NOV_1M, ...offHours('2026-11-23', 63700)], 'tick');
    const m1 = await r.read('1m', NSE, DAY0, DAY1);
    expect(m1[0].ts).toBe(ist('2026-11-23 09:15'));
    expect(m1.every((b) => b.ts >= ist('2026-11-23 09:15') && b.ts < ist('2026-11-23 15:30'))).toBe(true);
    const b15 = await r.readBucketed(NSE, 15, 555, DAY0, DAY1);
    expect(b15.map((b) => b.ts)).toEqual([ist('2026-11-23 09:15')]);
    expect(b15[0]).toMatchObject({ open: 65003.7, high: 65182.45, low: 63662.1, close: 63696.55 });
  });

  it("today's 1d bar (1440, origin 0) excludes the pre-open range", async () => {
    const r = new MemoryCandleRepo();
    await r.upsert('1m', NSE, BANKNIFTY_23NOV_1M, 'tick');
    const [day] = await r.readBucketed(NSE, 1440, 0, DAY0, DAY1);
    expect(day).toMatchObject({ ts: DAY0, open: 65003.7, high: 65182.45, low: 63662.1 });
  });

  it('MCX keeps 09:00 onwards and its evening', async () => {
    const r = new MemoryCandleRepo();
    const bar = (t: string) => ({ ts: ist(`2026-11-23 ${t}`), open: 1, high: 2, low: 1, close: 1, volume: 1 });
    await r.upsert('1m', MCX, [bar('08:59'), bar('09:00'), bar('21:00'), bar('23:54'), bar('23:55')], 'tick');
    expect((await r.read('1m', MCX, DAY0, DAY1)).map((b) => b.ts)).toEqual([ist('2026-11-23 09:00'), ist('2026-11-23 21:00'), ist('2026-11-23 23:54')]);
  });
});
