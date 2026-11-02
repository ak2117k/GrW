import { buildEpisodes } from './episodes';
import { closedPos, exitRow, holdingRow, ist, tracker } from './review.fixtures';
import { baseCashSymbol, parseDerivativeSymbol } from './symbols';

const NOW = ist('2026-11-02 13:00');

describe('symbols', () => {
  it('parses options, MCX options and futures', () => {
    expect(parseDerivativeSymbol('KEI29SEP265800CE')).toEqual({ underlying: 'KEI', type: 'CE', expiry: '2026-09-29', strike: 5800 });
    expect(parseDerivativeSymbol('CRUDEOIL15OCT268800PE')).toEqual({ underlying: 'CRUDEOIL', type: 'PE', expiry: '2026-10-15', strike: 8800 });
    expect(parseDerivativeSymbol('SUZLON27OCT2640CE')?.strike).toBe(40);
    expect(parseDerivativeSymbol('360ONE27OCT26900CE')?.underlying).toBe('360ONE');
    expect(parseDerivativeSymbol('RELIANCE28AUG26FUT')).toEqual({ underlying: 'RELIANCE', type: 'FUT', expiry: '2026-08-28', strike: null });
    expect(parseDerivativeSymbol('IDEA-EQ')).toBeNull();
  });

  it('strips cash series suffixes so HFCL-EQ and HFCL-BE are one company', () => {
    expect(baseCashSymbol('HFCL-EQ')).toBe('HFCL');
    expect(baseCashSymbol('HFCL-BE')).toBe('HFCL');
    expect(baseCashSymbol('SURANAT&P-EQ')).toBe('SURANAT&P');
  });
});

describe('buildEpisodes', () => {
  it('merges churned holding rows (12 rows of VIYASH) into ONE open episode, not 11 realised losses', () => {
    const rows = [
      holdingRow('VIYASH-EQ', 289.82, 300, '2026-07-11 18:41', '2026-07-11 22:34', 277.8),
      holdingRow('VIYASH-EQ', 289.82, 300, '2026-07-11 22:42', '2026-07-13 09:16', 277.8),
      holdingRow('VIYASH-EQ', 289.82, 300, '2026-07-13 09:20', '2026-08-17 14:00', 280.3),
      holdingRow('VIYASH-EQ', 289.82, 297, '2026-08-17 14:10', '2026-10-12 19:57', 235.88),
      holdingRow('VIYASH-EQ', 289.82, 297, '2026-10-12 20:25', null, 219.97),
    ];
    const b = buildEpisodes(rows, [], [], NOW);
    expect(b.episodes).toHaveLength(1);
    const e = b.episodes[0];
    expect(e.status).toBe('OPEN');
    expect(e.rowIds).toHaveLength(5);
    expect(e.unrealised).toBeCloseTo((219.97 - 289.82) * 297, 2);
    // 3 shares sold between rows 3 and 4 at the last mark → partial realised
    expect(e.partialExits).toBe(1);
    expect(e.realisedGross).toBeCloseTo((280.3 - 289.82) * 3, 2);
    expect(b.churn.rows).toBe(4);
    expect(b.churn.claimedPnl).toBeLessThan(-7000);
  });

  it('treats a holding whose last row closed with no re-open as sold (realised, delivery charges)', () => {
    const rows = [
      holdingRow('SUZLON-EQ', 57.76, 430, '2026-07-11 18:41', '2026-08-01 10:00', 50),
      holdingRow('SUZLON-EQ', 57.76, 430, '2026-08-01 10:10', '2026-09-03 10:00', 46.16),
    ];
    const [e] = buildEpisodes(rows, [], [], NOW).episodes;
    expect(e.status).toBe('CLOSED');
    expect(e.realisedGross).toBeCloseTo((46.16 - 57.76) * 430, 2);
    expect(e.charges).toBeGreaterThan(20); // delivery STT both legs + DP
    expect(e.closedBy).toBe('AT_BROKER');
    expect(e.flags).toContain('LAST_TICK_EXIT');
    expect(e.flags).toContain('HELD_BEFORE_TRACKING');
  });

  it('joins a series change (HFCL-EQ → HFCL-BE) into the same holding', () => {
    const rows = [
      holdingRow('HFCL-EQ', 227.36, 100, '2026-07-11 18:41', '2026-09-03 10:00', 230),
      holdingRow('HFCL-BE', 227.36, 100, '2026-09-03 10:10', null, 219.73, { token: 'other' }),
    ];
    expect(buildEpisodes(rows, [], [], NOW).episodes).toHaveLength(1);
  });

  it('starts a new holding episode after a long gap', () => {
    const rows = [
      holdingRow('ABB-EQ', 7089.3, 4, '2026-07-11 18:41', '2026-07-20 10:00', 6900),
      holdingRow('ABB-EQ', 6500, 2, '2026-09-01 10:00', null, 6400),
    ];
    expect(buildEpisodes(rows, [], [], NOW).episodes).toHaveLength(2);
  });

  it('flags averaging down when quantity grows while the mark is below cost', () => {
    const rows = [
      holdingRow('ADANIENSOL-EQ', 1744.1, 10, '2026-07-17 10:00', '2026-08-01 10:00', 1500),
      holdingRow('ADANIENSOL-EQ', 1700, 15, '2026-08-01 10:10', null, 1369.7),
    ];
    const [e] = buildEpisodes(rows, [], [], NOW).episodes;
    expect(e.adds).toBe(1);
    expect(e.averagedDown).toBe(true);
  });

  it('drops rows with no average price (entry 0) and reports what they claimed', () => {
    const rows = [
      closedPos('FORTIS27OCT26760PE', 0, 19.5, 775, '2026-10-02 15:50', '2026-10-09 09:10'),
      closedPos('NIFTY28JUL2623950CE', 112.08, 84.45, 650, '2026-07-27 09:40', '2026-07-27 10:00'),
    ];
    const b = buildEpisodes(rows, [], [], NOW);
    expect(b.episodes).toHaveLength(1);
    expect(b.invalid).toEqual({ rows: 1, claimedPnl: 15112.5, symbols: ['FORTIS27OCT26760PE'] });
  });

  it('merges a position that blinked out and back at the same average price, but not a re-entry at a new price', () => {
    const tok = { token: '110810' };
    const blink = [
      closedPos('SUZLON27OCT2640CE', 0.88, 1.2, 12700, '2026-10-12 09:40', '2026-10-12 10:30', tok),
      closedPos('SUZLON27OCT2640CE', 0.88, 1.3, 12700, '2026-10-12 10:40', '2026-10-12 12:50', tok),
    ];
    const merged = buildEpisodes(blink, [], [], NOW).episodes;
    expect(merged).toHaveLength(1);
    expect(merged[0].realisedGross).toBeCloseTo((1.3 - 0.88) * 12700, 2);

    const reentry = [blink[0], closedPos('SUZLON27OCT2640CE', 1.1, 1.0, 12700, '2026-10-12 11:00', '2026-10-12 12:50', tok)];
    expect(buildEpisodes(reentry, [], [], NOW).episodes).toHaveLength(2);
  });

  it('attributes the closer: AI exit (fill price used), Exit button, expiry, at the broker', () => {
    const ai = closedPos('CRUDEOIL15OCT268950CE', 185.1, 120, 100, '2026-10-12 19:36', '2026-10-13 21:40', { id: 'ai', exchange: 'MCX' });
    const man = closedPos('NIFTY28OCT2625000CE', 100, 90, 75, '2026-10-20 10:00', '2026-10-20 11:00', { id: 'man' });
    const exp = closedPos('KEI29SEP265800CE', 271.85, 0.05, 175, '2026-08-17 14:10', '2026-09-30 15:50', { id: 'exp' });
    const brk = closedPos('NIFTY28JUL2623950CE', 112.08, 84.45, 650, '2026-07-27 09:40', '2026-07-27 10:00', { id: 'brk' });
    const b = buildEpisodes([ai, man, exp, brk], [exitRow('ai', 'cmvh123', 123.5), exitRow('man', 'man_man_1', null)], [], NOW);
    const by = Object.fromEntries(b.episodes.map((e) => [e.rowIds[0], e]));
    expect(by.ai.closedBy).toBe('AI_EXIT');
    expect(by.ai.exitPrice).toBe(123.5);
    expect(by.ai.exitPriceSource).toBe('APP_FILL');
    expect(by.ai.realisedGross).toBeCloseTo((123.5 - 185.1) * 100, 2);
    expect(by.ai.segment).toBe('COMMODITY');
    expect(by.man.closedBy).toBe('MANUAL_IN_APP');
    expect(by.exp.closedBy).toBe('EXPIRY');
    expect(by.exp.derivative?.dteAtEntry).toBe(43);
    expect(by.brk.closedBy).toBe('AT_BROKER');
  });

  it('uses BROKER_FILL as the source for closes after the 2026-11-02 tracker fix', () => {
    const [e] = buildEpisodes([closedPos('RELIANCE23NOV261300CE', 8, 7.15, 500, '2026-11-02 09:30', '2026-11-02 11:00')], [], [], NOW).episodes;
    expect(e.exitPriceSource).toBe('BROKER_FILL');
  });

  it('marks cash positions on a held stock as holding legs, and keeps a real intraday trade', () => {
    const rows = [
      holdingRow('ABB-EQ', 7089.3, 4, '2026-07-11 18:41', '2026-10-30 10:20', 6407.5),
      tracker({ symbol: 'ABB-EQ', exchange: 'NSE', token: '13', qty: -1, entryPrice: 6479, exitPrice: 6530, entryTime: ist('2026-10-29 10:58'), exitTime: ist('2026-10-30 09:00'), pnl: -51 }),
      tracker({ symbol: 'TATASTEEL-EQ', exchange: 'NSE', token: '3499', qty: 100, entryPrice: 150, exitPrice: 148, entryTime: ist('2026-10-29 10:00'), exitTime: ist('2026-10-29 14:00'), pnl: -200 }),
    ];
    const b = buildEpisodes(rows, [], [], NOW);
    expect(b.holdingLegs).toBe(1);
    expect(b.episodes.find((e) => e.symbol === 'ABB-EQ' && e.kind === 'POSITION')?.role).toBe('HOLDING_LEG');
    expect(b.episodes.find((e) => e.symbol === 'TATASTEEL-EQ')?.role).toBe('TRADE');
    expect(b.episodes.find((e) => e.symbol === 'TATASTEEL-EQ')?.segment).toBe('CASH_INTRADAY');
  });

  it('flags a possible unadjusted split when the price is under 45% of cost', () => {
    const [e] = buildEpisodes([holdingRow('GOODLUCK-EQ', 1314.04, 10, '2026-08-14 10:00', '2026-09-07 10:20', 476.05)], [], [], NOW).episodes;
    expect(e.flags).toContain('POSSIBLE_CORPORATE_ACTION');
  });

  it('computes the premium-to-strike moneyness proxy and the short side', () => {
    const [e] = buildEpisodes([closedPos('NIFTY11AUG2623850PE', 30, 40, -130, '2026-08-06 15:30', '2026-08-07 10:00')], [], [], NOW).episodes;
    expect(e.side).toBe('SHORT');
    expect(e.realisedGross).toBeCloseTo(-1300, 2);
    expect(e.derivative?.premiumPctOfStrike).toBeCloseTo(0.13, 2);
  });
});
