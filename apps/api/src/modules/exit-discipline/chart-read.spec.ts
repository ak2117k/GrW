import { chartConfirmMode, hardLossAbsRupees, profitChartConfirmMode, readChart, supertrend, type ChartBar } from './chart-read';
import { chartGateOf } from './decision';
import type { ClauseResult, GateFactsSnapshot } from './types';

const bar = (i: number, close: number, range = 20): ChartBar => ({ ts: i * 900_000, open: close, high: close + range / 2, low: close - range / 2, close });
const rising = (n: number, from: number, step: number) => Array.from({ length: n }, (_, i) => bar(i, from + i * step));

describe('supertrend', () => {
  it('UP on a rising series, DOWN on a falling one, null when too short', () => {
    expect(supertrend(rising(30, 62000, 15))?.dir).toBe('UP');
    expect(supertrend(rising(30, 62000, -15))?.dir).toBe('DOWN');
    expect(supertrend(rising(5, 62000, 15))).toBeNull();
  });
});

describe('readChart (BANKNIFTY 62300 CE, 2026-11-19 09:53)', () => {
  // Long call; underlying 62322 near its best 62340; invalidation 62000; 15m uptrend; N15 ~ 120.
  const base = {
    bull: true, underlyingNow: 62322, invalidation: 62000, bestUnderlying: 62340,
    bars5: rising(30, 61900, 14), bars15: rising(30, 61700, 22), n15: 120, k15: 1.5,
  };

  it('intact: no close beyond the invalidation, 18 pts < 1.5 x N15, Supertrend UP', () => {
    const r = readChart(base);
    expect(r.known).toBe(true);
    expect(r.against).toBe(false);
  });

  it('against: a closed 5m bar below the invalidation', () => {
    const bars5 = [...base.bars5.slice(0, -1), bar(99, 61980)];
    expect(readChart({ ...base, bars5 }).against).toBe(true);
  });

  it('against: >= 1.5 x N15 from the best', () => {
    expect(readChart({ ...base, underlyingNow: 62340 - 181 }).against).toBe(true);
  });

  it('against: 15m Supertrend DOWN for a long', () => {
    expect(readChart({ ...base, bars15: rising(30, 62600, -22) }).against).toBe(true);
  });

  it('nothing readable ⇒ known false and treated as against', () => {
    const r = readChart({ bull: true, underlyingNow: null, invalidation: null, bestUnderlying: null, bars5: [], bars15: [], n15: null, k15: 1.5 });
    expect(r.known).toBe(false);
    expect(r.against).toBe(true);
  });

  it('an invalidation on the wrong scale (a premium) is ignored', () => {
    expect(readChart({ ...base, invalidation: 340 }).measured.invalidation).toBeNull();
  });
});

describe('chartGateOf (loss-side only, ₹3,500 absolute)', () => {
  const clause = (id: ClauseResult['id'], pass: boolean | null): ClauseResult => ({ id, pass, measured: {}, note: '' });
  const g = (passed: ClauseResult['id'][]) => ({
    justified: passed.length > 0, justification: null, hardRisk: false, thesisClearMargin: false, floorHard: false, ladder: false,
    clauses: [...passed.map((id) => clause(id, true)), clause('THESIS_INVALIDATION', false)],
  }) as never;
  const intact = readChart({ bull: true, underlyingNow: 1731, invalidation: 1722.9, bestUnderlying: 1738.6, bars5: rising(30, 1700, 1), bars15: rising(30, 1690, 1.5), n15: 6, k15: 1.5 });
  const facts = (net: number, chart = intact) => ({ netPnlNow: net, chart } as unknown as GateFactsSnapshot);
  const act = { mode: 'act' as const, absLossRupees: 3500 };

  it('PAYTM 1780 CE: MAX_LOSS at −₹2,172 with the chart intact ⇒ held in act mode', () => {
    expect(intact.against).toBe(false);
    const r = chartGateOf(g(['HARD_MAX_LOSS']), facts(-2172), act);
    expect(r?.held).toBe(true);
  });

  it('observe mode records wouldHold but never holds', () => {
    const r = chartGateOf(g(['HARD_MAX_LOSS']), facts(-2172), { ...act, mode: 'observe' });
    expect(r?.wouldHold).toBe(true);
    expect(r?.held).toBe(false);
  });

  it('at −₹3,500 it exits whatever the chart says', () => {
    expect(chartGateOf(g(['HARD_MAX_LOSS']), facts(-3500), act)?.held).toBe(false);
  });

  it('GREEN_TO_RED is loss-side too', () => {
    expect(chartGateOf(g(['FLOOR_HARD_GREEN_TO_RED']), facts(-424), act)?.held).toBe(true);
  });

  it('profit-side, thesis or other hard-risk grounds are never touched', () => {
    expect(chartGateOf(g(['TARGET_LADDER']), facts(-100), act)).toBeNull();
    expect(chartGateOf(g(['FLOOR_HARD_GREEN_LOCK']), facts(200), act)).toBeNull();
    expect(chartGateOf(g(['HARD_MAX_LOSS', 'THESIS_INVALIDATION']), facts(-2172), act)).toBeNull();
    expect(chartGateOf(g(['HARD_MAX_LOSS', 'HARD_SESSION_CLOSE']), facts(-2172), act)).toBeNull();
  });

  it('chart against or unreadable ⇒ the exit stands', () => {
    const against = { ...intact, against: true };
    expect(chartGateOf(g(['HARD_MAX_LOSS']), facts(-2172, against), act)?.held).toBe(false);
    expect(chartGateOf(g(['HARD_MAX_LOSS']), facts(-2172, null as never), act)?.held).toBe(false);
  });

  it('config: observe by default, ₹3,500 by default', () => {
    expect(chartConfirmMode({})).toBe('observe');
    expect(chartConfirmMode({ EXIT_CHART_CONFIRM: 'act' })).toBe('act');
    expect(hardLossAbsRupees({})).toBe(3500);
  });
});

describe('cutLossRealActs (TRIGGER_CUT_LOSS_REAL)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { cutLossRealActs } = require('./cut-loss-yardstick');
  it('acts only on "act", and never with the yardstick off', () => {
    expect(cutLossRealActs({})).toBe(false);
    expect(cutLossRealActs({ TRIGGER_CUT_LOSS_REAL: 'act' })).toBe(true);
    expect(cutLossRealActs({ TRIGGER_CUT_LOSS_REAL: 'act', TRIGGER_CUT_LOSS_N15: 'off' })).toBe(false);
  });
});

describe('profit-side chart gate (PROFIT_CHART_CONFIRM, owner 2026-11-20 LTM 4100 CE)', () => {
  const clause = (id: ClauseResult['id'], pass: boolean | null, measured: ClauseResult['measured'] = {}): ClauseResult => ({ id, pass, measured, note: '' });
  const g = (passed: ClauseResult[]) => ({
    justified: passed.length > 0, justification: null, hardRisk: false, thesisClearMargin: false, floorHard: true, ladder: false,
    clauses: [...passed, clause('THESIS_INVALIDATION', false)],
  }) as never;
  // LTM 09:40: green lock sold 139.55 on a 12.7-pt dip; LTM 4221 above the 4155 invalidation, still rising.
  const intact = readChart({ bull: true, underlyingNow: 4221.8, invalidation: 4155, bestUnderlying: 4234.5, bars5: rising(30, 4150, 2.5), bars15: rising(30, 4100, 4), n15: 72, k15: 1.5 });
  const facts = (net: number, chart = intact) => ({ netPnlNow: net, chart } as unknown as GateFactsSnapshot);
  const opts = (profitMode: 'off' | 'observe' | 'act') => ({ mode: 'observe' as const, absLossRupees: 3500, profitMode });
  const lock = clause('FLOOR_HARD_GREEN_LOCK', true);

  it('LTM 09:40: green lock at +₹7,216 with the chart intact ⇒ held in act mode', () => {
    expect(intact.against).toBe(false);
    const r = chartGateOf(g([lock]), facts(7216), opts('act'));
    expect(r).toMatchObject({ side: 'profit', wouldHold: true, held: true });
  });

  it('observe records wouldHold but never holds; off is silent', () => {
    expect(chartGateOf(g([lock]), facts(7216), opts('observe'))).toMatchObject({ wouldHold: true, held: false });
    expect(chartGateOf(g([lock]), facts(7216), opts('off'))).toBeNull();
  });

  it('the ladder trail and the K·N floor are profit-side too; the last target reached is never held', () => {
    expect(chartGateOf(g([lock, clause('TARGET_LADDER', true, { lastHit: false })]), facts(450), opts('act'))?.held).toBe(true);
    expect(chartGateOf(g([clause('FLOOR_HARD_UNDERLYING_MOVE', true)]), facts(300), opts('act'))?.held).toBe(true);
    expect(chartGateOf(g([clause('TARGET_LADDER', true, { lastHit: true })]), facts(5000), opts('act'))).toBeNull();
  });

  it('net red, chart against or unreadable ⇒ the exit stands; mixed with a VWAP/thesis clause ⇒ untouched', () => {
    expect(chartGateOf(g([clause('TARGET_LADDER', true)]), facts(-443), opts('act'))?.held).toBe(false);
    expect(chartGateOf(g([lock]), facts(7216, { ...intact, against: true }), opts('act'))?.held).toBe(false);
    expect(chartGateOf(g([lock]), facts(7216, null as never), opts('act'))?.held).toBe(false);
    expect(chartGateOf(g([lock, clause('FLOOR_BREACH_VWAP', true)]), facts(700), opts('act'))).toBeNull();
  });

  it('green-to-red stays with the loss-side switch (observe on prod)', () => {
    expect(chartGateOf(g([clause('FLOOR_HARD_GREEN_TO_RED', true), clause('TARGET_LADDER', true)]), facts(-443), opts('act'))).toBeNull();
  });

  it('config: observe by default', () => {
    expect(profitChartConfirmMode({})).toBe('observe');
    expect(profitChartConfirmMode({ PROFIT_CHART_CONFIRM: 'act' })).toBe('act');
    expect(profitChartConfirmMode({ PROFIT_CHART_CONFIRM: 'off' })).toBe('off');
  });
});
