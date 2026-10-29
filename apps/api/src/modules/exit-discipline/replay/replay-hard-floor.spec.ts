import { parseExitDisciplineConfig } from '../config';
import { gateSummary } from '../decision';
import { validateFixture } from './fixture';
import { replayHardFloor } from './replay-hard-floor';
import { PE_N_UNDERLYING, buildSyntheticCrudePeFixture, istPe, peNet } from './synthetic-crude-pe';

const ON = parseExitDisciplineConfig({});
const ist = (iso: string) => new Date(Date.parse(iso) + 330 * 60_000).toISOString().slice(11, 19);

describe('hard floor replay — synthetic CRUDEOILM17NOV269350PE, prod 2026-10-29', () => {
  const fx = buildSyntheticCrudePeFixture();

  it('the fixture encodes the incident: 37 HOLDs over 21:09–21:31, peak 380.4, floor 376.8, crude 9539 → 9603, net +180 → −330', () => {
    expect(validateFixture(JSON.parse(JSON.stringify(fx)))).toEqual(fx);
    const grind = fx.verdicts.filter((v) => Date.parse(v.createdAt) >= istPe('21:09'));
    expect(grind).toHaveLength(37);
    expect(fx.verdicts.every((v) => v.verdict === 'HOLD')).toBe(true);
    const at = (hhmm: string) => fx.contractBars.find((b) => b.ts === istPe(hhmm))!.close;
    const u = (hhmm: string) => fx.underlyingBars.find((b) => b.ts === istPe(hhmm))!.close;
    expect(Math.max(...fx.contractBars.map((b) => b.close))).toBe(380.4);
    expect([u('21:09'), u('21:31')]).toEqual([9539, 9603]);
    expect([peNet(at('21:09')), peNet(at('21:31'))]).toEqual([180, -330]);
    expect(at('21:31')).toBe(352.8);
    expect(grind[0].packet).toMatchObject({ money: { greenFloorPrice: 376.8, greenFloorArmed: true, floorBasis: 'noise' } });
  });

  it('ROOT CAUSE: measured from the previous verdict, no step of the grind reaches one underlying N', () => {
    const us = fx.verdicts.filter((v) => Date.parse(v.createdAt) >= istPe('21:09'))
      .map((v) => (v.packet as { position: { underlyingLtp: { value: number } } }).position.underlyingLtp.value);
    const steps = us.slice(1).map((x, i) => x - us[i]);
    expect(Math.max(...steps)).toBeLessThan(PE_N_UNDERLYING);
    expect(us[us.length - 1] - us[0]).toBeGreaterThan(5 * PE_N_UNDERLYING - 1); // ~5 N in total
  });

  it('FIXED FRAME: the rule fires at ~21:15 IST — premium below the floor and crude 2 N against from the best point — and the gate PASSES it at once', () => {
    const r = replayHardFloor(fx, { cfg: ON, netPnl: peNet });
    expect(r.best).toMatchObject({ ltp: 380.4, underlying: 9531 });
    // Nothing trips while the trade was green and going its way (20:10–21:10).
    expect(r.trips.every((t) => Date.parse(t.at) >= istPe('21:10'))).toBe(true);
    expect(r.fired).not.toBeNull();
    const fired = r.fired!;
    // 21:15:00 is the first trip (crude 9556.45, 25.45 points = 2.04 N above the 9531 best point); 21:15:30 confirms.
    expect(ist(fired.at)).toBe('21:15:30');
    expect(fired).toMatchObject({ ltp: 371.35, underlying: 9556.45, netPnl: 41 });
    expect(Date.parse(fired.at)).toBeGreaterThanOrEqual(istPe('21:10'));
    expect(Date.parse(fired.at)).toBeLessThanOrEqual(istPe('21:16'));
    expect(fired.reading).toMatchObject({ trip: true, rule: 'HWM_UNDERLYING_MOVE', belowFloor: true, netRed: false });
    expect(fired.reading.adverseFromBestN!).toBeGreaterThanOrEqual(2);
    expect(fired.floor).toBe(376.8);
    expect(fired.ltp).toBeGreaterThan(352.8); // vs the 21:31 mark the HOLDs rode down to
    expect(fired.netPnl).toBeGreaterThan(-330);
    // The rule's EXIT_NOW through the executor's gate: FLOOR_HARD_EXIT, persistence bypassed — no second verdict needed.
    expect(r.gate).toMatchObject({ outcome: 'PASS', justification: 'FLOOR_HARD_EXIT', persistence: { rule: 'BYPASS' } });
    expect(r.gate!.clauses.find((c) => c.id === 'FLOOR_HARD_UNDERLYING_MOVE')).toMatchObject({ pass: true });
    expect(gateSummary(r.gate!)).toMatch(/^PASS: FLOOR_HARD_EXIT via .*FLOOR_HARD_UNDERLYING_MOVE/);
  });

  it('with the K·N rule out of reach (K = 6) the GREEN_TO_RED rule fires once the trade turns net red (~21:17), never earlier', () => {
    const r = replayHardFloor(fx, { cfg: { ...ON, floorHardExitN: 6 }, netPnl: peNet });
    const fired = r.fired!;
    expect(fired.reading).toMatchObject({ rule: 'GREEN_TO_RED', belowFloor: true, netRed: true });
    expect(fired.netPnl).toBeLessThan(0);
    expect(Date.parse(fired.at)).toBeGreaterThanOrEqual(istPe('21:16'));
    expect(Date.parse(fired.at)).toBeLessThanOrEqual(istPe('21:19'));
    // Between the floor break (~21:11) and net red, the green-but-below-floor reads never tripped.
    expect(r.trips.every((t) => t.netPnl < 0)).toBe(true);
    expect(r.gate).toMatchObject({ outcome: 'PASS', justification: 'FLOOR_HARD_EXIT' });
  });

  it('confirmation: the first tripping read never fires on its own', () => {
    const r = replayHardFloor(fx, { cfg: ON, netPnl: peNet });
    expect(r.trips.length).toBeGreaterThanOrEqual(2);
    expect(r.fired!.at).toBe(r.trips[1].at);
    expect(Date.parse(r.trips[1].at) - Date.parse(r.trips[0].at)).toBeGreaterThanOrEqual(20_000);
  });
});
