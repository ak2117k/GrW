import { NewsWatchBook } from './news-watch-book';

it('matches by instrument key, prunes per user', () => {
  const b = new NewsWatchBook();
  b.upsert({ trackerId: 't1', userId: 'u1', symbol: 'INFY', exchange: 'NSE', instrumentKeys: ['I:INFY'] });
  b.upsert({ trackerId: 't2', userId: 'u1', symbol: 'NIFTY28OCT2625000CE', exchange: 'NFO', instrumentKeys: ['X:NIFTY'] });
  b.upsert({ trackerId: 't3', userId: 'u2', symbol: 'INFY', exchange: 'NSE', instrumentKeys: ['I:INFY'] });
  expect(b.matching(['I:INFY', 'M:IN']).map((w) => w.trackerId).sort()).toEqual(['t1', 't3']);
  expect(b.matching(['S:NIFTY IT', 'M:IN'])).toEqual([]);
  b.prune('u1', new Set(['t2']));
  expect(b.matching(['I:INFY']).map((w) => w.trackerId)).toEqual(['t3']);
  expect(b.size()).toBe(2);
  expect(b.has('t2')).toBe(true);
  expect(b.has('t1')).toBe(false);
});

it('upsert replaces the entry and copies the key list (no aliasing)', () => {
  const b = new NewsWatchBook();
  const keys = ['I:INFY'];
  b.upsert({ trackerId: 't1', userId: 'u1', symbol: 'INFY', exchange: 'NSE', instrumentKeys: keys });
  keys.push('I:TCS');
  expect(b.matching(['I:TCS'])).toEqual([]);
  b.upsert({ trackerId: 't1', userId: 'u1', symbol: 'TCS', exchange: 'NSE', instrumentKeys: ['I:TCS'] });
  expect(b.size()).toBe(1);
  expect(b.matching(['I:TCS']).map((w) => w.symbol)).toEqual(['TCS']);
});
