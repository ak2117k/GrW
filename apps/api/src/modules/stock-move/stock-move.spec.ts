import { normaliseStockSymbol, stockMoveLabel, stockMovePart, toReading, type StockMoveRow } from './stock-move.logic';
import { STOCK_MOVE_REFRESH_MS, StockMoveService, type StockMoveSource } from './stock-move.service';

const row = (symbol: string, rankPct: number, bucket: string, over: Partial<StockMoveRow> = {}): StockMoveRow => ({
  asOf: new Date('2026-10-21T00:00:00Z'), symbol, horizonDays: 5, pBig: rankPct * 0.8, rankPct, bucket,
  resultsDate: null, resultsInWindow: false, modelId: 'stock-move-20261021', ...over,
});
const NOW = Date.parse('2026-10-22T03:00:00Z');

function source(book: StockMoveRow[] | (() => Promise<StockMoveRow[]>), outcomes: Awaited<ReturnType<StockMoveSource['lastOutcomes']>> = []) {
  const latestBook = jest.fn(typeof book === 'function' ? book : async () => book);
  const lastOutcomes = jest.fn(async () => outcomes);
  return { latestBook, lastOutcomes };
}

describe('stock-move logic', () => {
  it('labels a reading the contract way', () => {
    const r = toReading(row('RELIANCE-EQ', 0.97, 'TOP20', { pBig: 0.714, resultsDate: new Date('2026-10-24T00:00:00Z'), resultsInWindow: true }));
    expect(r.symbol).toBe('RELIANCE');
    expect(stockMoveLabel(r)).toBe('RELIANCE p(big 5d) 0.71 · TOP20 · results 2026-10-24 in window · as of 2026-10-21');
    expect(normaliseStockSymbol(' m&m ')).toBe('M&M');
  });
  it('points only with the setting at 1 and only for a long option; never direction', () => {
    const top = toReading(row('A', 0.97, 'TOP20'));
    const bottom = toReading(row('B', 0.05, 'BOTTOM20'));
    expect(stockMovePart(top, true, 0).points).toBe(0);
    expect(stockMovePart(top, true, 1).points).toBe(1);
    expect(stockMovePart(bottom, true, 1).points).toBe(-1);
    expect(stockMovePart(top, false, 1).points).toBe(0);
    expect(stockMovePart(null, true, 1)).toEqual({ points: 0, text: 'stock: no stock-move score yet', note: '' });
  });
});

describe('StockMoveService (in-memory book)', () => {
  it('serves the cached book synchronously, refreshing at most every 30 min', async () => {
    let now = NOW;
    const src = source([row('RELIANCE', 0.97, 'TOP20'), row('TCS', 0.4, 'MID')]);
    const svc = new StockMoveService(src, () => now);
    await svc.onModuleInit();
    expect(svc.get('RELIANCE-EQ')).toMatchObject({ symbol: 'RELIANCE', bucket: 'TOP20' });
    expect(svc.get('INFY')).toBeNull();
    svc.get('TCS');
    expect(src.latestBook).toHaveBeenCalledTimes(1);
    now += STOCK_MOVE_REFRESH_MS;
    svc.get('TCS');
    expect(src.latestBook).toHaveBeenCalledTimes(2);
  });

  it('empty table, a failed read, or a stale book ⇒ null (a failure keeps the last good book)', async () => {
    let fail = false;
    let now = NOW;
    const svc = new StockMoveService(
      source(async () => {
        if (fail) throw new Error('db down');
        return [row('RELIANCE', 0.97, 'TOP20')];
      }),
      () => now,
    );
    expect(svc.get('RELIANCE')).toBeNull(); // nothing loaded yet; this kicks the first read
    await svc.refresh();
    expect(svc.get('RELIANCE')).not.toBeNull();
    fail = true;
    await svc.refresh();
    expect(svc.get('RELIANCE')).not.toBeNull();
    now += 10 * 86_400_000;
    expect(svc.get('RELIANCE')).toBeNull();
    const empty = new StockMoveService(source([]), () => NOW);
    await empty.refresh();
    expect(empty.get('RELIANCE')).toBeNull();
  });

  it('watch: held + news-idea names first, then the top 10 TOP20, with last outcomes', async () => {
    const book = [
      ...Array.from({ length: 12 }, (_, i) => row(`T${i}`, 0.99 - i * 0.01, 'TOP20')),
      row('RELIANCE', 0.5, 'MID'),
    ];
    const svc = new StockMoveService(
      source(book, [{ symbol: 'RELIANCE', asOf: new Date('2026-10-14T00:00:00Z'), outcomeBig: true, outcomeRetBp: 350 }]),
      () => NOW,
    );
    const v = await svc.watch({ held: ['RELIANCE', 'T0'], newsIdeas: ['NEWCO'] });
    expect(v).toMatchObject({ asOf: '2026-10-21', modelId: 'stock-move-20261021', scored: 13 });
    expect(v.rows.map((r) => r.symbol)).toEqual(['RELIANCE', 'T0', 'NEWCO', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9']);
    expect(v.rows[0]).toMatchObject({ sources: ['HELD'], reading: { bucket: 'MID' }, lastOutcome: { asOf: '2026-10-14', big: true, retBp: 350 } });
    expect(v.rows[1].sources).toEqual(['HELD', 'TOP']);
    expect(v.rows[2]).toMatchObject({ sources: ['NEWS_IDEA'], reading: null, lastOutcome: null });
  });

  it('watch on an empty table: no book, held names listed with no reading', async () => {
    const v = await new StockMoveService(source([]), () => NOW).watch({ held: ['KEI'], newsIdeas: [] });
    expect(v).toEqual({ asOf: null, modelId: null, scored: 0, rows: [{ symbol: 'KEI', sources: ['HELD'], reading: null, lastOutcome: null }] });
  });
});
