import * as gate from '../../adaptive-stop-track/adaptive-stop-decision-gate';
import type { HubCandle } from '../../market-hub/candles/candle.types';
import { ADAPTIVE_GATE_KEY, GATE_EVALUATORS, MBM_GATE_KEY, runGates } from './gate-evaluators';
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

describe('market-behaviour gate (MBM M3 stream B)', () => {
  const okAnswer = (regime: string, p: number) => ({
    instrument: 'NIFTY', status: 'ok' as const, asOf: '2026-10-13T05:00:00Z', featureSet: 'mbm-fs-v1',
    horizons: { '30m': { p: 0.4, regime: 'NORMAL', q25Bp: 10, q50Bp: 15, q75Bp: 20 }, '60m': { p, regime, q25Bp: 37, q50Bp: 50, q75Bp: 68 } },
    modelIds: { '30m': 'm30', '60m': 'm60' },
  });
  const gateRef = (params: Record<string, string | number | boolean> = { skipRegimes: 'QUIET', horizon: 'auto' }) => ({ kind: 'evaluator' as const, evaluatorKey: MBM_GATE_KEY, params });
  const mbmCtx = (mode: 'off' | 'observe' | 'on', answer: unknown, instrument: string | null = 'NIFTY', now = NOW) => {
    const behaviour = jest.fn().mockResolvedValue(answer);
    return { ctx: { entryPrice: 500, now, candles: jest.fn(), mbm: { mode, instrument, behaviour } }, behaviour };
  };

  it('is registered under the key market-behaviour', () => {
    expect(GATE_EVALUATORS.has('market-behaviour')).toBe(true);
  });

  it('observe never blocks: a QUIET answer the version skips passes, recording wouldSkip, regime and p', async () => {
    const r = await runGates([gateRef()], mbmCtx('observe', okAnswer('QUIET', 0.12)).ctx);
    expect(r.pass).toBe(true);
    expect(r.outcomes[0]).toMatchObject({
      key: MBM_GATE_KEY, pass: true, reason: expect.stringMatching(/^observe: would skip/),
      detail: { mode: 'observe', applies: true, instrument: 'NIFTY', horizon: '60m', regime: 'QUIET', p: 0.12, rangeBp: [37, 68], modelId: 'm60', featureSet: 'mbm-fs-v1', wouldSkip: true },
    });
  });

  it('observe never blocks, even with invalid params', async () => {
    const r = await runGates([gateRef({ skipRegimes: 1, horizon: '5m' })], mbmCtx('observe', okAnswer('QUIET', 0.1)).ctx);
    expect(r.pass).toBe(true);
    expect(r.outcomes[0].detail).toMatchObject({ applies: false });
  });

  it('on: QUIET blocks only when skipRegimes asks for it', async () => {
    const blocked = await runGates([gateRef()], mbmCtx('on', okAnswer('QUIET', 0.1)).ctx);
    expect(blocked.pass).toBe(false);
    expect(blocked.outcomes[0]).toMatchObject({ pass: false, reason: expect.stringMatching(/regime QUIET.*skipRegimes/), detail: { wouldSkip: true } });
    const notAsked = await runGates([gateRef({ horizon: 'auto' })], mbmCtx('on', okAnswer('QUIET', 0.1)).ctx);
    expect(notAsked.pass).toBe(true);
    expect(notAsked.outcomes[0].detail).toMatchObject({ applies: true, wouldSkip: false });
    expect((await runGates([gateRef()], mbmCtx('on', okAnswer('ACTIVE', 0.9)).ctx)).pass).toBe(true);
  });

  it('on: invalid params fail closed like the other gates', async () => {
    const r = await runGates([gateRef({ horizon: '5m' })], mbmCtx('on', okAnswer('ACTIVE', 0.9)).ctx);
    expect(r.pass).toBe(false);
    expect(r.outcomes[0].reason).toMatch(/params invalid/);
  });

  it.each([
    ['absent', { status: 'absent' }],
    ['stale', { ...okAnswer('QUIET', 0.1), status: 'stale' }],
    ['null', null],
  ])('on: an %s answer passes with applies:false', async (_n, answer) => {
    const r = await runGates([gateRef()], mbmCtx('on', answer).ctx);
    expect(r.pass).toBe(true);
    expect(r.outcomes[0]).toMatchObject({ pass: true, skipped: true, detail: { mode: 'on', applies: false } });
  });

  it('on: a throwing client is only absent', async () => {
    const { ctx, behaviour } = mbmCtx('on', null);
    behaviour.mockRejectedValue(new Error('boom'));
    expect((await runGates([gateRef()], ctx)).pass).toBe(true);
  });

  it('a non-NIFTY entry passes with applies:false and never calls MBM', async () => {
    const { ctx, behaviour } = mbmCtx('on', okAnswer('QUIET', 0.1), null);
    const r = await runGates([gateRef()], ctx);
    expect(r.pass).toBe(true);
    expect(r.outcomes[0].detail).toMatchObject({ applies: false });
    expect(behaviour).not.toHaveBeenCalled();
  });

  it('off (or no MBM context) passes with applies:false and never calls MBM', async () => {
    const { ctx, behaviour } = mbmCtx('off', okAnswer('QUIET', 0.1));
    expect((await runGates([gateRef()], ctx)).outcomes[0]).toMatchObject({ pass: true, detail: { mode: 'off', applies: false } });
    expect(behaviour).not.toHaveBeenCalled();
    expect((await runGates([gateRef()], { entryPrice: 500, now: NOW, candles: jest.fn() })).pass).toBe(true);
  });

  it('horizon auto picks 30m in the last hour; an explicit horizon is honoured', async () => {
    const late = await runGates([gateRef()], mbmCtx('on', okAnswer('QUIET', 0.1), 'NIFTY', ist('2026-10-13', '14:45')).ctx);
    expect(late.outcomes[0].detail).toMatchObject({ horizon: '30m', regime: 'NORMAL', wouldSkip: false });
    const fixed = await runGates([gateRef({ skipRegimes: 'quiet, normal', horizon: '30m' })], mbmCtx('on', okAnswer('ACTIVE', 0.9)).ctx);
    expect(fixed.pass).toBe(false);
    expect(fixed.outcomes[0].detail).toMatchObject({ horizon: '30m', regime: 'NORMAL' });
  });
});
