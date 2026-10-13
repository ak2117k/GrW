import * as gate from '../../adaptive-stop-track/adaptive-stop-decision-gate';
import type { HubCandle } from '../../market-hub/candles/candle.types';
import { ADAPTIVE_GATE_KEY, runGates } from './gate-evaluators';
import { adaptiveSeedBlocks, ist } from './testing/intake-fixtures';

const NOW = ist('2026-10-13', '10:30');
const seedGate = () => adaptiveSeedBlocks().filters.gates[0];
const ctx = (candles: HubCandle[] | null) => ({ entryPrice: 500, now: NOW, candles: jest.fn().mockResolvedValue(candles) });

afterEach(() => jest.restoreAllMocks());

describe('runGates (D9, O6)', () => {
  it('an unknown evaluator key fails closed and names the key', async () => {
    const r = await runGates([{ kind: 'evaluator', evaluatorKey: 'nope', params: {} }], ctx([]));
    expect(r).toEqual({ pass: false, unknown: 'nope', outcomes: [] });
  });

  it('incomplete params fail (never a guessed default)', async () => {
    const r = await runGates([{ kind: 'evaluator', evaluatorKey: ADAPTIVE_GATE_KEY, params: { nearSupportPct: 0.6, rsiHot: 70 } }], ctx([]));
    expect(r.pass).toBe(false);
    expect(r.outcomes[0].reason).toMatch(/params incomplete/);
  });

  it('reads 15m candles over srLookbackDays and passes the seed params and the entry price through', async () => {
    const spy = jest.spyOn(gate, 'evaluateDecisionGate');
    const c = ctx([{ ts: NOW.getTime() - 3_600_000, open: 1, high: 2, low: 1, close: 2, volume: 5 }]);
    await runGates([seedGate()], c);
    expect(c.candles).toHaveBeenCalledWith('15m', 5);
    expect(spy).toHaveBeenCalledWith(500, [expect.objectContaining({ high: 2, low: 1, close: 2, volume: 5, timestamp: new Date(NOW.getTime() - 3_600_000) })], NOW.getTime(), {
      nearSupportPct: 0.6, rsiHot: 70, vwapExtPct: 1.5, requireMacdBullish: true,
    });
  });

  it('a data gap passes as skipped when the version says failOpen (the seed, silo parity) and fails otherwise', async () => {
    const open = await runGates([seedGate()], ctx(null));
    expect(open.pass).toBe(true);
    expect(open.outcomes[0]).toMatchObject({ key: ADAPTIVE_GATE_KEY, pass: true, skipped: true });
    const strict = { ...seedGate(), params: { ...seedGate().params, failOpen: false } };
    const closed = await runGates([strict], ctx(null));
    expect(closed.pass).toBe(false);
    expect(closed.outcomes[0]).toMatchObject({ pass: false, skipped: true });
    expect(closed.outcomes[0].reason).toMatch(/failOpen is false/);
  });

  it('a gate that rejects stops the chain with its reason', async () => {
    jest.spyOn(gate, 'evaluateDecisionGate').mockReturnValue({
      pass: false, skipped: false, nearSupport: false, notExtended: true, macdBullish: true, reason: 'not at support',
      detail: { nearestSupport: 480, distSupportPct: 4.1, rsi: 55, vwapExtPct: 0.2, macdHist: 0.3 },
    });
    const r = await runGates([seedGate(), seedGate()], ctx([]));
    expect(r.pass).toBe(false);
    expect(r.outcomes).toHaveLength(1);
    expect(r.outcomes[0]).toMatchObject({ pass: false, reason: 'not at support', detail: expect.objectContaining({ nearestSupport: 480 }) });
  });
});
