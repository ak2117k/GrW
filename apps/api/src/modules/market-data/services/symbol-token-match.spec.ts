import { matchSymbolToken, type ScripMasterRow } from './symbol-token-match';

/**
 * Resolving a Chartink symbol to its Angel One token used to require the symbol
 * to exist in the local `instruments` DB table — a hand-seeded subset of ~5
 * stocks. Every symbol outside it (NEOGEN and most of the market) was rejected
 * "symbol not in local DB", so its signal never became an entry.
 *
 * This matcher resolves against Angel's FULL in-memory scrip master instead, so
 * any listed NSE symbol resolves. It is pure so the priority/exactness rules —
 * the part that actually matters — are pinned without touching the network.
 */
describe('matchSymbolToken', () => {
  // A tiny stand-in master. Real rows carry many more fields; only these matter.
  const master: ScripMasterRow[] = [
    { symbol: 'NEOGEN-EQ', token: '15380', exch_seg: 'NSE', name: 'NEOGEN CHEMICALS' },
    { symbol: 'RELIANCE-EQ', token: '2885', exch_seg: 'NSE', name: 'RELIANCE' },
    // Trade-to-trade series for a surveillance name — only a -BE row exists.
    { symbol: 'SOMESURV-BE', token: '9001', exch_seg: 'NSE', name: 'SURVEILLANCE CO' },
    // Same bare symbol on a different exchange must NOT be returned for NSE.
    { symbol: 'RELIANCE', token: '500325', exch_seg: 'BSE', name: 'RELIANCE BSE' },
    // A decoy that would break a naive substring match.
    { symbol: 'NEOGENAB-EQ', token: '99999', exch_seg: 'NSE', name: 'DECOY' },
  ];

  it('resolves a bare symbol to its -EQ token', () => {
    expect(matchSymbolToken(master, 'NEOGEN', 'NSE')).toEqual({
      token: '15380',
      tradingSymbol: 'NEOGEN-EQ',
    });
  });

  it('is exact, not a substring match — NEOGEN must not match NEOGENAB', () => {
    // The whole point: a fuzzy match would resolve NEOGEN to the decoy's token
    // and silently trade the wrong instrument.
    expect(matchSymbolToken(master, 'NEOGEN', 'NSE')?.token).toBe('15380');
    expect(matchSymbolToken(master, 'NEOGEN', 'NSE')?.token).not.toBe('99999');
  });

  it('is case-insensitive on the input', () => {
    expect(matchSymbolToken(master, 'neogen', 'NSE')?.token).toBe('15380');
  });

  it('accepts an input that already carries a series suffix', () => {
    // Chartink usually sends bare, but be defensive: NEOGEN-EQ must still resolve.
    expect(matchSymbolToken(master, 'NEOGEN-EQ', 'NSE')?.token).toBe('15380');
  });

  it('falls through the series when no -EQ row exists (-BE surveillance name)', () => {
    expect(matchSymbolToken(master, 'SOMESURV', 'NSE')).toEqual({
      token: '9001',
      tradingSymbol: 'SOMESURV-BE',
    });
  });

  it('scopes to the requested exchange — never returns a BSE row for NSE', () => {
    // Only the BSE RELIANCE has bare symbol 'RELIANCE'; the NSE one is -EQ.
    // A resolver that ignored exch_seg could return the BSE token.
    expect(matchSymbolToken(master, 'RELIANCE', 'NSE')?.token).toBe('2885');
  });

  it('returns null for a symbol not in the master (delisted / typo)', () => {
    expect(matchSymbolToken(master, 'NOTATICKER', 'NSE')).toBeNull();
  });

  it('prefers -EQ over other series when several exist', () => {
    const withBoth: ScripMasterRow[] = [
      { symbol: 'DUAL-BE', token: '1', exch_seg: 'NSE', name: 'DUAL' },
      { symbol: 'DUAL-EQ', token: '2', exch_seg: 'NSE', name: 'DUAL' },
    ];
    // -EQ is the normal, liquid series; it must win regardless of row order.
    expect(matchSymbolToken(withBoth, 'DUAL', 'NSE')?.token).toBe('2');
  });

  it('is total — tolerates rows with missing/odd fields without throwing', () => {
    const messy: ScripMasterRow[] = [
      { symbol: null as never, token: '1', exch_seg: 'NSE' },
      { token: '2', exch_seg: 'NSE' } as never,
      { symbol: 'GOOD-EQ', token: '3', exch_seg: 'NSE' },
    ];
    expect(matchSymbolToken(messy, 'GOOD', 'NSE')?.token).toBe('3');
    expect(matchSymbolToken([], 'ANY', 'NSE')).toBeNull();
  });
});
