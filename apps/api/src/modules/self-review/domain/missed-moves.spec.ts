import { bigMoves, missCause, NO_EVIDENCE, scoreMissedMove, type BigMove, type DailyMoveRow } from './missed-moves';

const row = (symbol: string, close: number, over: Partial<DailyMoveRow> = {}): DailyMoveRow => ({
  symbol, close, prevClose: 100, atrPct: 0.02, bucket: 'MID', rankPct: 0.5, resultsInWindow: false, ...over,
});
const up: BigMove = { symbol: 'DIVISLAB', retPct: 6, atrMove: 3, bucket: 'MID', rankPct: 0.5, resultsInWindow: false };
const down: BigMove = { ...up, retPct: -6 };

describe('bigMoves', () => {
  it('keeps moves of at least 2 ATR, either way, biggest first', () => {
    const out = bigMoves([row('SMALL', 103), row('UP', 106), row('DOWN', 90)]);
    expect(out.map((m) => [m.symbol, m.retPct, m.atrMove])).toEqual([['DOWN', -10, 5], ['UP', 6, 3]]);
  });
  it('caps the list', () => {
    expect(bigMoves(Array.from({ length: 15 }, (_, i) => row(`S${i}`, 110 + i)))).toHaveLength(10);
  });
  it('skips a row with no price or no ATR', () => {
    expect(bigMoves([row('A', 110, { prevClose: null }), row('B', 110, { atrPct: null }), row('C', 110, { atrPct: 0 })])).toEqual([]);
  });
});

describe('missCause', () => {
  it('a real position wins over everything else', () => {
    expect(missCause(up, { ...NO_EVIDENCE, realTrade: true, paperTrade: true, articles: 3 })).toBe('TRADED');
  });
  it('a setup, idea or signal only counts on the side the stock moved', () => {
    expect(missCause(up, { ...NO_EVIDENCE, setups: ['LONG'] })).toBe('SETUP_NOT_TAKEN');
    expect(missCause(down, { ...NO_EVIDENCE, setups: ['LONG'] })).toBe('NO_SIGNAL');
    expect(missCause(down, { ...NO_EVIDENCE, ideas: ['PE_IDEA'] })).toBe('IDEA_NOT_TAKEN');
    expect(missCause(down, { ...NO_EVIDENCE, signals: ['BEAR'] })).toBe('SIGNAL_NOT_TAKEN');
  });
  it('an idea that said NO_TRADE or the other side was rejected', () => {
    expect(missCause(up, { ...NO_EVIDENCE, ideas: ['NO_TRADE'] })).toBe('IDEA_REJECTED');
    expect(missCause(up, { ...NO_EVIDENCE, ideas: ['PE_IDEA'] })).toBe('IDEA_REJECTED');
  });
  it('splits news into never read, read and unused, and read as low', () => {
    expect(missCause(up, { ...NO_EVIDENCE, articles: 2 })).toBe('NEWS_NOT_READ');
    expect(missCause(up, { ...NO_EVIDENCE, articles: 2, reads: [{ direction: 'BULL', magnitude: 'HIGH' }] })).toBe('NEWS_READ_NOT_USED');
    expect(missCause(up, { ...NO_EVIDENCE, articles: 2, reads: [{ direction: 'BULL', magnitude: 'LOW' }] })).toBe('NEWS_READ_LOW');
    expect(missCause(up, { ...NO_EVIDENCE, articles: 2, reads: [{ direction: 'BEAR', magnitude: 'HIGH' }] })).toBe('NEWS_READ_LOW');
  });
  it('with no news: flagged by the model, or nothing at all', () => {
    expect(missCause({ ...up, bucket: 'TOP20' }, NO_EVIDENCE)).toBe('MODEL_ONLY');
    expect(missCause(up, NO_EVIDENCE)).toBe('NO_SIGNAL');
  });
});

describe('scoreMissedMove', () => {
  it('a move we held is not a miss', () => {
    expect(scoreMissedMove('2026-11-09', up, { ...NO_EVIDENCE, realTrade: true })).toMatchObject({ correct: true, subject: 'TRADED' });
    expect(scoreMissedMove('2026-11-09', up, { ...NO_EVIDENCE, paperTrade: true })).toMatchObject({ correct: true, subject: 'PAPER_ONLY' });
  });
  it('a miss carries its cause and the size of the move', () => {
    expect(scoreMissedMove('2026-11-09', up, { ...NO_EVIDENCE, articles: 2 })).toMatchObject({
      sessionDate: '2026-11-09', kind: 'MISSED_MOVE', refId: '2026-11-09:DIVISLAB', symbol: 'DIVISLAB', correct: false, score: 3,
      subject: 'NEWS_NOT_READ', actual: '+6% close to close (3 ATR)',
    });
  });
});
