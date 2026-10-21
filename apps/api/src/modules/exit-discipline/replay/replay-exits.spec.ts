import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { breakevenPrice } from '../../trade-sentinel/charges';
import { parseExitDisciplineConfig } from '../config';
import { gateSummary } from '../decision';
import { validateFixture, type ExitFixtureV1 } from './fixture';
import { gridConfigs, replayExits } from './replay-exits';
import { buildSyntheticCrudeFixture } from './synthetic-crude';

const ON = parseExitDisciplineConfig({});
const OFF = parseExitDisciplineConfig({ EXIT_DISCIPLINE_ENABLED: 'false' });
const be = (m: ExitFixtureV1['meta']) =>
  breakevenPrice({ segment: m.segment, entryPrice: m.entryPrice, qty: m.qty, side: m.side })!;

describe('spec §12 replay — synthetic CRUDEOIL17NOV269000CE, 2026-10-14', () => {
  const fx = buildSyntheticCrudeFixture();

  it('package ON: no EXIT_NOW executes — every one is gated with its numbers; the 16:31 sale is held', () => {
    const r = replayExits(fx, { cfg: ON, breakeven: be });
    expect(r.executed).toBeNull();
    expect(r.decisions.map((d) => d.record.outcome)).toEqual(['GATED_THESIS_INTACT', 'GATED_THESIS_INTACT', 'GATED_THESIS_INTACT', 'GATED_THESIS_INTACT']);
    const at1631 = r.decisions.find((d) => d.verdictId === 'v-1631')!;
    expect(at1631.record.clauses.find((c) => c.id === 'THESIS_INVALIDATION')).toMatchObject({ pass: false });
    expect(at1631.nContract).toBeGreaterThan(4);
    expect(r.pnl).toMatchObject({ basis: 'final-mark', exitPrice: 542 });
    expect(r.pnl.grossRupees).toBeCloseTo((542 - 521.9) * 100, 6);
    expect(r.counts).toEqual({ gated: 4, awaiting: 0, passed: 0 });
  });

  it('the 16:31 decision sees the noise floor armed and breached by 527.1, and still holds (underlying never moved against it)', () => {
    const at1631 = replayExits(fx, { cfg: ON, breakeven: be }).decisions.find((d) => d.verdictId === 'v-1631')!;
    expect(at1631.ltpNow).toBe(527.1);
    expect(at1631.floor.armed).toBe(true);
    expect(at1631.floor.price!).toBeGreaterThan(527.1);
    expect(at1631.record.facts).toMatchObject({ floor: { basis: 'noise', armed: true }, underlying: 9003, invalidation: 8932, holdRef: { underlying: 8998 } });
    expect(at1631.record.clauses.find((c) => c.id === 'FLOOR_BREACH_UNDERLYING_MOVE')).toMatchObject({ pass: false, measured: { floorBreached: true } });
    expect(at1631.record.clauses.find((c) => c.id === 'FLOOR_BREACH_VWAP')).toMatchObject({ pass: false });
    expect(gateSummary(at1631.record)).toMatch(/^GATED_THESIS_INTACT: u 9003, inv 8932/);
  });

  it('package ON + a break below 8932 at 16:45: the breaking EXIT_NOW waits for confirmation (only hard risk bypasses)', () => {
    const r = replayExits(buildSyntheticCrudeFixture({ breakAt: '16:45', breakTo: 8925 }), { cfg: ON, breakeven: be });
    const atBreak = r.decisions.find((d) => d.verdictId === 'v-break')!;
    expect(atBreak.record).toMatchObject({ outcome: 'AWAITING_CONFIRMATION', justification: 'THESIS_BROKEN', persistence: { confirmed: false } });
    expect(r.executed?.verdictId).not.toBe('v-break');
  });

  it('package OFF reproduces today: the first EXIT_NOW executes', () => {
    const r = replayExits(fx, { cfg: OFF, breakeven: be });
    expect(r.executed).toMatchObject({ verdictId: 'v-1605', record: { outcome: 'BYPASS', bypassReason: 'DISABLED' } });
    expect(r.decisions).toHaveLength(1);
    expect(r.pnl.basis).toBe('executed');
  });

  it('is deterministic and never throws on a packet it cannot read (fails OPEN like the live gate)', () => {
    expect(replayExits(fx, { cfg: ON, breakeven: be })).toEqual(replayExits(fx, { cfg: ON, breakeven: be }));
    const broken: ExitFixtureV1 = { ...fx, verdicts: fx.verdicts.map((v) => (v.id === 'v-1605' ? { ...v, packet: { junk: true } } : v)) };
    const r = replayExits(broken, { cfg: ON, breakeven: be });
    expect(r.executed).toMatchObject({ verdictId: 'v-1605', record: { outcome: 'BYPASS', bypassReason: 'FACTS_UNREADABLE' } });
  });

  it('no contract bars: N unknown ⇒ the packet fixed floor; the thesis gate still runs', () => {
    const r = replayExits({ ...fx, contractBars: [] }, { cfg: ON, breakeven: be });
    const at1631 = r.decisions.find((d) => d.verdictId === 'v-1631')!;
    expect(at1631.nContract).toBeNull();
    expect(at1631.record.facts).toMatchObject({ floor: { basis: 'fixed', price: 524.85 } });
    expect(r.executed).toBeNull();
  });
});

/** Real exports (git-ignored *.real.json, produced by scripts/export-exit-fixture.ts). */
const dir = join(__dirname, 'fixtures');
const real = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.real.json')) : [];
(real.length ? describe : describe.skip)('spec §12 replay — real exports', () => {
  it.each(real.length ? real : ['(none)'])('%s: the AI exit that actually sold is not PASS unless a justification clause passed with numbers', (file) => {
    const fx = validateFixture(JSON.parse(readFileSync(join(dir, file), 'utf8')));
    const r = replayExits(fx, { cfg: ON, breakeven: be });
    for (const d of r.decisions) {
      if (d.record.outcome === 'PASS') expect(d.record.clauses.some((c) => c.pass === true)).toBe(true);
    }
    if (fx.meta.actualExit) {
      const sold = r.decisions.find((d) => d.verdictId === fx.meta.actualExit!.verdictId);
      // If this fails on the CRUDEOIL export: STOP and report the clause numbers to the owner — do not tune to pass.
      if (sold?.record.outcome === 'PASS') throw new Error(`the sold exit would still PASS: ${gateSummary(sold.record)}`);
    }
  });
});

describe('gridConfigs', () => {
  it('cartesian product over the given keys, base elsewhere, stable order', () => {
    const g = gridConfigs(ON, { floorTrailN: [1.5, 2], gateUnderlyingN: [0.5, 1] });
    expect(g.map((c) => [c.floorTrailN, c.gateUnderlyingN])).toEqual([[1.5, 0.5], [1.5, 1], [2, 0.5], [2, 1]]);
    expect(g.every((c) => c.floorArmN === 1.5 && c.enabled)).toBe(true);
  });
  it('no grid (or empty value lists) ⇒ just the base', () => {
    expect(gridConfigs(ON, {})).toEqual([ON]);
    expect(gridConfigs(ON, { floorArmN: [] })).toEqual([ON]);
  });
  it('a lower gateUnderlyingN can only add executions on the synthetic day (monotone sanity)', () => {
    const fx = buildSyntheticCrudeFixture();
    const passed = (n: number) => replayExits(fx, { cfg: { ...ON, gateUnderlyingN: n }, breakeven: be }).counts.passed;
    expect(passed(0.25)).toBeGreaterThanOrEqual(passed(1));
  });
});
