import { toPublicEntry, PublicAnandEntry, ANAND_PROVENANCE_KEYS } from '../../src/modules/anand-dual-track/dto/public-entry.dto';

const ALLOWED_KEYS = [
  'id','symbol','segment','entryPrice','enteredAt','targetPct','stopPct',
  'status','exitPrice','exitedAt','currentPrice','pnlPct','targetLeftPct','priceStale',
].sort();

// A raw enriched row as the anand controller would have it: public fields PLUS provenance sentinels.
const rawRow = {
  id: 'e1', symbol: 'TCS', token: '11536', entryPrice: 100, enteredAt: '2026-06-29T04:00:00.000Z',
  targetPct: 5, stopPct: 5, status: 'TRADED', exitPrice: null, exitedAt: null,
  currentPrice: 110, pnlPct: 10, targetLeftPct: 0, priceStale: false,
  // provenance / IP — must NOT appear in output:
  scannerName: '__LEAK_scanner__',
  scoreBreakdown: [{ name: '__LEAK_check__', points: 3, pointsPossible: 5, passed: true }],
  leadCount: 4, leadDates: ['2026-06-01'], trailing: true, exitReason: 'TRAIL_ST',
  alertId: 'al_123',
};

describe('toPublicEntry', () => {
  it('emits exactly the allowlist keys and nothing else', () => {
    const out = toPublicEntry(rawRow, 'INTRADAY');
    expect(Object.keys(out).sort()).toEqual(ALLOWED_KEYS);
  });

  it('stamps the segment from the argument, not the row', () => {
    expect(toPublicEntry(rawRow, 'SWING').segment).toBe('SWING');
  });

  it('contains no provenance key or sentinel value (CI guard)', () => {
    const json = JSON.stringify(toPublicEntry(rawRow, 'INTRADAY'));
    for (const k of ANAND_PROVENANCE_KEYS) expect(json).not.toContain(k);
    expect(json).not.toContain('__LEAK_scanner__');
    expect(json).not.toContain('__LEAK_check__');
    expect(json).not.toContain('TRAIL_ST');
  });

  it('passes through public values', () => {
    const out = toPublicEntry(rawRow, 'INTRADAY');
    expect(out).toMatchObject({ id: 'e1', symbol: 'TCS', entryPrice: 100, targetPct: 5, status: 'TRADED', currentPrice: 110, pnlPct: 10 });
  });

  it('defaults missing optional numerics to null and priceStale to false', () => {
    const out = toPublicEntry({ id: 'x', symbol: 'Y', entryPrice: 1, enteredAt: 't', targetPct: 5, stopPct: 5, status: 'OPEN' } as any, 'INTRADAY');
    expect(out.exitPrice).toBeNull();
    expect(out.currentPrice).toBeNull();
    expect(out.priceStale).toBe(false);
  });
});
