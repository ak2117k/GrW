import { describe, expect, it } from 'vitest';
import { filterBoard, istToday, levelsLine, resultLine, type BoardItem } from './signalBoard';

const item = (o: Partial<BoardItem> = {}): BoardItem => ({
  id: 'call:1',
  source: 'TELEGRAM',
  at: '2026-10-28T04:10:00.000Z',
  symbol: 'GOLD',
  instrument: 'GOLD25NOV26147000CE',
  side: 'BUY',
  entry: 251,
  entryNote: 'at 250',
  sl: 230,
  slSource: 'engine',
  targets: [290, 320],
  targetSource: 'engine',
  state: 'OPEN',
  status: 'PAPER',
  why: [],
  result: null,
  channel: 'Stock Gainers',
  aiCorrect: null,
  ...o,
});

describe('signal board helpers', () => {
  it('marks the SL / targets our engine assigned', () => {
    expect(levelsLine(item())).toBe('entry 251 (at 250) · SL 230 (engine) · T 290 / 320 (engine)');
    expect(levelsLine(item({ source: 'NIGHT_SETUP', entryNote: 'buy above the 15m high', slSource: 'setup', targetSource: 'setup' }))).toBe('entry 251 · SL 230 · T 290 / 320');
    expect(levelsLine(item({ entry: null, sl: null, targets: [] }))).toBe('');
  });

  it('formats a result in R, % and ₹', () => {
    expect(resultLine(item({ result: { r: 1.5 } }))).toBe('+1.5 R');
    expect(resultLine(item({ result: { movePct: -8.2, pnl: -2050 } }))).toBe('-8.2% · -₹2,050');
    expect(resultLine(item())).toBe('');
  });

  it('filters by source, or to what is waiting / open', () => {
    const xs = [item(), item({ id: 'setup:1', source: 'NIGHT_SETUP', state: 'WAITING' }), item({ id: 'idea:1', source: 'NEWS_IDEA', state: 'VIEW' })];
    expect(filterBoard(xs, 'actionable').map((x) => x.id)).toEqual(['call:1', 'setup:1']);
    expect(filterBoard(xs, 'NEWS_IDEA').map((x) => x.id)).toEqual(['idea:1']);
    expect(filterBoard(xs, 'all')).toHaveLength(3);
  });

  it('today is the IST date (just after midnight IST is already the next day)', () => {
    expect(istToday(new Date('2026-10-27T18:45:00Z'))).toBe('2026-10-28');
  });
});
