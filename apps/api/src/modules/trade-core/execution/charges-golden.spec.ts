import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { estimateCharges, type Segment, type Side } from '../../trade-sentinel/charges';

/**
 * M3 refactors trade-sentinel/charges.ts into per-leg charges (spec §3). estimateCharges
 * feeds the sentinel's green floor, so its numbers must not move by one bit. The fixture
 * was captured from the UNCHANGED file with CAPTURE_CHARGES_GOLDEN=1 and is never
 * regenerated afterwards; JSON numbers round-trip doubles exactly, so Object.is is fair.
 */
const FIXTURE = join(__dirname, 'testing', 'charges-golden.json');
const SEGMENTS: Segment[] = ['EQ_DELIVERY', 'EQ_INTRADAY', 'FUT', 'OPT'];
const SIDES: Side[] = ['LONG', 'SHORT'];
const PRICES = [0.05, 1, 2.35, 99.95, 1234.5, 25000];
const QTYS = [1, 15, 75, 1000, 1800];
const ROWS = SEGMENTS.length * SIDES.length * PRICES.length * PRICES.length * QTYS.length;

interface GoldenInput {
  segment: Segment;
  side: Side;
  entryPrice: number;
  exitPrice: number;
  qty: number;
}
interface GoldenRow extends GoldenInput {
  charges: number;
}

function grid(): GoldenInput[] {
  const out: GoldenInput[] = [];
  for (const segment of SEGMENTS)
    for (const side of SIDES)
      for (const entryPrice of PRICES)
        for (const exitPrice of PRICES)
          for (const qty of QTYS) out.push({ segment, side, entryPrice, exitPrice, qty });
  return out;
}

describe('estimateCharges golden grid (M3 per-leg refactor)', () => {
  if (process.env.CAPTURE_CHARGES_GOLDEN === '1') {
    it('captures the fixture from the current charges.ts', () => {
      const rows: GoldenRow[] = grid().map((g) => ({ ...g, charges: estimateCharges(g) }));
      writeFileSync(FIXTURE, `${JSON.stringify(rows, null, 1)}\n`);
      expect(rows).toHaveLength(ROWS);
    });
    return;
  }

  it('returns exactly the captured number for every input', () => {
    expect(existsSync(FIXTURE)).toBe(true);
    const rows = JSON.parse(readFileSync(FIXTURE, 'utf8')) as GoldenRow[];
    expect(rows).toHaveLength(ROWS);
    const moved = rows.filter((r) => !Object.is(estimateCharges(r), r.charges));
    expect(moved).toEqual([]);
  });
});
