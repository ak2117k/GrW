import { parseExitDisciplineConfig } from './config';
import { bypassRecord, decideExit, gateSummary, isBlocking, istDate, lastHoldRef } from './decision';
import type { GateFacts } from './gate';
import type { HistoryVerdict } from './persistence';

const CFG = parseExitDisciplineConfig({});
const NOW = new Date('2026-10-14T11:01:30Z');
const CUR = { id: 'cur', createdAt: new Date('2026-10-14T11:01:00Z') };
const hv = (verdict: string, iso: string, underlying: number | null = null, support: number | null = null): HistoryVerdict =>
  ({ id: `${verdict}@${iso}`, verdict, createdAt: new Date(iso), underlying, support, resistance: 9020 });
const HIST = [hv('EXIT_ARMED', '2026-10-14T11:00:00Z'), hv('HOLD', '2026-10-14T10:50:00Z', 8998, 8946)];
const FACTS: GateFacts = {
  exposure: 'BULLISH', positionSide: 'LONG', ltpNow: 527.1, underlying: 9003, invalidation: 8932,
  holdRef: lastHoldRef(HIST), vwap: 9000, nContract: 4.5, nUnderlying: 3.1,
  floor: { price: 530.5, armed: true, basis: 'noise' }, netPnlNow: 420, maxLossPerTrade: 2000,
  minutesToClose: 419, productType: 'CARRYFORWARD', isExpiryDay: false, dailyLossLatched: false,
};

describe('istDate', () => {
  it('is the Asia/Kolkata calendar date', () => {
    expect(istDate(new Date('2026-10-14T18:29:59Z'))).toBe('2026-10-14');
    expect(istDate(new Date('2026-10-14T18:30:00Z'))).toBe('2026-10-15');
  });
});

describe('lastHoldRef', () => {
  it('picks the newest HOLD and copies its underlying and levels', () => {
    expect(lastHoldRef(HIST)).toEqual({ id: 'HOLD@2026-10-14T10:50:00Z', underlying: 8998, support: 8946, resistance: 9020, at: '2026-10-14T10:50:00.000Z' });
    expect(lastHoldRef([hv('EXIT_NOW', '2026-10-14T10:00:00Z')])).toBeNull();
  });
});

describe('decideExit', () => {
  it('thesis intact ⇒ GATED_THESIS_INTACT with every clause and the facts recorded', () => {
    const r = decideExit({ facts: FACTS, current: CUR, history: HIST, cfg: CFG, now: NOW });
    expect(r).toMatchObject({ v: 1, outcome: 'GATED_THESIS_INTACT', justification: null, persistence: null, facts: FACTS });
    expect(r.clauses).toHaveLength(8);
    expect(r.cfg).toEqual({ floorArmN: 1.5, floorTrailN: 2, gateCloseMin: 10, gateUnderlyingN: 1, persistWindowSec: 300, persistMinSec: 120 });
    expect(r.evaluatedAt).toBe(NOW.toISOString());
    expect(isBlocking(r)).toBe(true);
  });
  it('justified (level break) but first EXIT_NOW ⇒ AWAITING_CONFIRMATION', () => {
    const r = decideExit({ facts: { ...FACTS, underlying: 8940 }, current: CUR, history: HIST, cfg: CFG, now: NOW });
    expect(r).toMatchObject({ outcome: 'AWAITING_CONFIRMATION', justification: 'THESIS_BROKEN', persistence: { confirmed: false } });
    expect(isBlocking(r)).toBe(true);
  });
  it('justified and confirmed ⇒ PASS', () => {
    // The EXIT_NOW must be the IMMEDIATELY previous verdict (newer than HIST's EXIT_ARMED) for CONSECUTIVE (R6).
    const hist = [hv('EXIT_NOW', '2026-10-14T11:00:30Z'), ...HIST];
    const r = decideExit({ facts: { ...FACTS, underlying: 8940 }, current: CUR, history: hist, cfg: CFG, now: NOW });
    expect(r).toMatchObject({ outcome: 'PASS', persistence: { rule: 'CONSECUTIVE' } });
    expect(isBlocking(r)).toBe(false);
  });
  it('hard risk on the FIRST EXIT_NOW ⇒ PASS (persistence bypassed)', () => {
    const r = decideExit({ facts: { ...FACTS, dailyLossLatched: true }, current: CUR, history: HIST, cfg: CFG, now: NOW });
    expect(r).toMatchObject({ outcome: 'PASS', justification: 'HARD_RISK', persistence: { rule: 'BYPASS' } });
  });
  it('clear invalidation break on the FIRST EXIT_NOW ⇒ PASS', () => {
    const r = decideExit({ facts: { ...FACTS, underlying: 8925 }, current: CUR, history: HIST, cfg: CFG, now: NOW });
    expect(r).toMatchObject({ outcome: 'PASS', justification: 'THESIS_BROKEN', persistence: { rule: 'BYPASS' } });
  });
  it('disabled config ⇒ BYPASS DISABLED, nothing evaluated', () => {
    const off = parseExitDisciplineConfig({ EXIT_DISCIPLINE_ENABLED: 'false' });
    const r = decideExit({ facts: FACTS, current: CUR, history: HIST, cfg: off, now: NOW });
    expect(r).toMatchObject({ outcome: 'BYPASS', bypassReason: 'DISABLED', clauses: [], facts: null });
    expect(isBlocking(r)).toBe(false);
  });
});

describe('bypassRecord / isBlocking / gateSummary', () => {
  it('FACTS_UNREADABLE never blocks and keeps the error', () => {
    const r = bypassRecord('FACTS_UNREADABLE', CFG, NOW, 'verdict row not found');
    expect(r).toMatchObject({ outcome: 'BYPASS', bypassReason: 'FACTS_UNREADABLE', error: 'verdict row not found' });
    expect(isBlocking(r)).toBe(false);
    expect(isBlocking(null)).toBe(false);
  });
  it('summary names the outcome and the failing numbers in one line', () => {
    const s = gateSummary(decideExit({ facts: FACTS, current: CUR, history: HIST, cfg: CFG, now: NOW }));
    expect(s).toMatch(/^GATED_THESIS_INTACT: /);
    expect(s).toContain('u 9003');
    expect(s).toContain('inv 8932');
    expect(s).toContain('floor 530.5');
    expect(s.length).toBeLessThanOrEqual(300);
    expect(s).not.toContain('\n');
  });
});
