// apps/api/src/modules/sentinel-executor/domain/floor-broker-sl.spec.ts
import { parseAutoExitConfig } from './auto-exit.config';
import {
  FLOOR_STOP_TAG_PREFIX,
  desiredFloorStop,
  floorStopTag,
  parseFloorBrokerSlConfig,
  planFloorStop,
  restingFloorStop,
  simulateStopFill,
  type RestingStop,
} from './floor-broker-sl';
import { aiExitOrderTag, hasPriorAiExit, protectiveOrdersFor } from './exit-order';

const liveExit = parseAutoExitConfig({
  AI_AUTO_EXIT_ENABLED: 'true', AI_AUTO_EXIT_MODE: 'live', AI_AUTO_EXIT_USER_IDS: 'u1', AI_AUTO_EXIT_CANCEL_PROTECTIVE: 'true',
});

describe('parseFloorBrokerSlConfig', () => {
  it('defaults to SHADOW with 3 limit ticks and a 15 s modify gap', () => {
    const c = parseFloorBrokerSlConfig({}, liveExit);
    expect(c).toMatchObject({ mode: 'shadow', limitTicks: 3, modifyMinSec: 15 });
    expect(c.problems).toEqual([]);
  });
  it('off is off; a typo falls back to shadow, never live', () => {
    expect(parseFloorBrokerSlConfig({ FLOOR_BROKER_SL: 'off' }, liveExit).mode).toBe('off');
    const c = parseFloorBrokerSlConfig({ FLOOR_BROKER_SL: 'LIVE!' }, liveExit);
    expect(c.mode).toBe('shadow');
    expect(c.problems.join()).toMatch(/not off\|shadow\|live/);
  });
  it('live only when the AI auto-exit is enabled, live, and cancels protective orders (the backstop must be able to cancel the stop)', () => {
    expect(parseFloorBrokerSlConfig({ FLOOR_BROKER_SL: 'live' }, liveExit).mode).toBe('live');
    for (const env of [
      { AI_AUTO_EXIT_ENABLED: 'true', AI_AUTO_EXIT_MODE: 'live' },
      { AI_AUTO_EXIT_ENABLED: 'true', AI_AUTO_EXIT_MODE: 'dry-run', AI_AUTO_EXIT_CANCEL_PROTECTIVE: 'true' },
      { AI_AUTO_EXIT_MODE: 'live', AI_AUTO_EXIT_CANCEL_PROTECTIVE: 'true' },
    ]) {
      const c = parseFloorBrokerSlConfig({ FLOOR_BROKER_SL: 'live' }, parseAutoExitConfig(env));
      expect(c.mode).toBe('shadow');
      expect(c.problems.length).toBeGreaterThan(0);
    }
  });
  it('out-of-range numbers keep the safe defaults', () => {
    const c = parseFloorBrokerSlConfig({ FLOOR_BROKER_SL_LIMIT_TICKS: '0', FLOOR_BROKER_SL_MODIFY_MIN_SEC: '2' }, liveExit);
    expect(c).toMatchObject({ limitTicks: 3, modifyMinSec: 15 });
    expect(c.problems).toHaveLength(2);
  });
});

describe('desiredFloorStop', () => {
  const base = { floor: 180.74, ltp: 186, tick: 0.05, limitTicks: 3, quantity: 130 };
  it('a long sells STOPLOSS_LIMIT: trigger = floor ceiled to the tick, limit 3 ticks under', () => {
    expect(desiredFloorStop({ ...base, side: 'LONG' })).toEqual({ ok: true, side: 'SELL', trigger: 180.75, limit: 180.6, quantity: 130 });
  });
  it('a short buys: trigger = floor floored to the tick, limit 3 ticks over', () => {
    expect(desiredFloorStop({ ...base, side: 'SHORT', floor: 90.82, ltp: 85 })).toEqual({ ok: true, side: 'BUY', trigger: 90.8, limit: 90.95, quantity: 130 });
  });
  it('is not placeable when the price is already at / through the trigger (Angel refuses; the polling exit owns it)', () => {
    expect(desiredFloorStop({ ...base, side: 'LONG', ltp: 180.75 })).toEqual({ ok: false, reason: 'NOT_PLACEABLE' });
    expect(desiredFloorStop({ ...base, side: 'SHORT', floor: 90.8, ltp: 90.8 })).toEqual({ ok: false, reason: 'NOT_PLACEABLE' });
  });
  it('refuses a limit at or below zero, a bad tick or quantity', () => {
    expect(desiredFloorStop({ ...base, side: 'LONG', floor: 0.1, ltp: 0.5 })).toEqual({ ok: false, reason: 'LIMIT_NOT_POSITIVE' });
    expect(desiredFloorStop({ ...base, side: 'LONG', tick: 0 })).toEqual({ ok: false, reason: 'BAD_TICK' });
    expect(desiredFloorStop({ ...base, side: 'LONG', quantity: 0 })).toEqual({ ok: false, reason: 'BAD_QTY' });
    expect(desiredFloorStop({ ...base, side: 'LONG', floor: NaN })).toEqual({ ok: false, reason: 'NO_FLOOR' });
  });
});

describe('planFloorStop', () => {
  const desired = { ok: true as const, side: 'SELL' as const, trigger: 180.75, limit: 180.6, quantity: 130 };
  const resting: RestingStop = { side: 'SELL', trigger: 170, limit: 169.85, quantity: 130, changedAt: 0 };
  const p = (over: Partial<Parameters<typeof planFloorStop>[0]>) =>
    planFloorStop({ eligible: { ok: true }, desired, resting: null, tick: 0.05, nowMs: 60_000, modifyMinSec: 15, ...over });

  it('places when eligible and none rests', () => expect(p({})).toEqual({ kind: 'PLACE', desired }));
  it('ineligible: cancels a resting stop, else nothing', () => {
    expect(p({ eligible: { ok: false, reason: 'FLOOR_DISARMED' }, resting })).toEqual({ kind: 'CANCEL', reason: 'FLOOR_DISARMED' });
    expect(p({ eligible: { ok: false, reason: 'FLOOR_DISARMED' } })).toEqual({ kind: 'NONE', reason: 'FLOOR_DISARMED' });
  });
  it('trails UP by >= 1 tick, rate-limited', () => {
    expect(p({ resting })).toEqual({ kind: 'MODIFY', desired, from: resting });
    expect(p({ resting: { ...resting, changedAt: 50_000 } })).toEqual({ kind: 'KEEP', reason: 'RATE_LIMITED' });
    expect(p({ resting: { ...resting, trigger: 180.75 - 0.04 } })).toEqual({ kind: 'KEEP', reason: 'NO_IMPROVEMENT' });
  });
  it('never lowers a resting stop', () => {
    expect(p({ resting: { ...resting, trigger: 185, limit: 184.85 } })).toEqual({ kind: 'KEEP', reason: 'NO_IMPROVEMENT' });
  });
  it('a short trails DOWN, never up', () => {
    const d = { ok: true as const, side: 'BUY' as const, trigger: 90, limit: 90.15, quantity: 10 };
    const r: RestingStop = { side: 'BUY', trigger: 95, limit: 95.15, quantity: 10, changedAt: 0 };
    expect(p({ desired: d, resting: r })).toEqual({ kind: 'MODIFY', desired: d, from: r });
    expect(p({ desired: { ...d, trigger: 96 }, resting: r })).toEqual({ kind: 'KEEP', reason: 'NO_IMPROVEMENT' });
  });
  it('a resting stop larger than the position is cut at once, ignoring the rate limit (it could open a fresh position)', () => {
    const big = { ...resting, trigger: 185, limit: 184.85, quantity: 260, changedAt: 59_000 };
    expect(p({ resting: big })).toEqual({ kind: 'MODIFY', desired: { ...desired, trigger: 185, limit: 184.85 }, from: big });
  });
  it('an unplaceable desire keeps the resting stop (it is the protection) or does nothing', () => {
    expect(p({ desired: { ok: false, reason: 'NOT_PLACEABLE' }, resting })).toEqual({ kind: 'KEEP', reason: 'NOT_PLACEABLE' });
    expect(p({ desired: { ok: false, reason: 'NOT_PLACEABLE' } })).toEqual({ kind: 'NONE', reason: 'NOT_PLACEABLE' });
  });
  it('a resting stop on the wrong side is cancelled', () => {
    expect(p({ resting: { ...resting, side: 'BUY' } })).toEqual({ kind: 'CANCEL', reason: 'SIDE_CHANGED' });
  });
});

describe('the floor stop tag and the executor', () => {
  it('is "afS" + the tracker id tail, at most 20 chars, and not an exit prefix (ax/am/at)', () => {
    const tag = floorStopTag('cmw4hjmpu3nk5o6012mbswhsy');
    expect(tag).toBe('afSu3nk5o6012mbswhsy');
    expect(tag.length).toBeLessThanOrEqual(20);
    expect(tag.startsWith(FLOOR_STOP_TAG_PREFIX)).toBe(true);
    expect(['ax', 'am', 'at'].some((p) => tag.startsWith(p))).toBe(false);
    expect(aiExitOrderTag('x', 'M').startsWith(FLOOR_STOP_TAG_PREFIX)).toBe(false);
  });

  const ours = (over: Record<string, unknown> = {}) => ({
    orderid: 'SL1', ordertag: floorStopTag('trk1'), exchange: 'NFO', symboltoken: '40009', status: 'trigger pending',
    variety: 'STOPLOSS', ordertype: 'STOPLOSS_LIMIT', transactiontype: 'SELL', producttype: 'CARRYFORWARD',
    quantity: '130', triggerprice: '180.75', price: '180.6', ...over,
  });

  it('a resting floor stop is NOT a prior exit (the executor would skip PRIOR_AI_EXIT_TODAY and never reach its cancel)', () => {
    expect(hasPriorAiExit([ours()], 'NFO', '40009', null)).toBe(false);
  });
  it('a resting floor stop IS protective to the executor: its market exit cancels it first (no double sell)', () => {
    const scan = protectiveOrdersFor([ours()], { exchange: 'NFO', token: '40009', side: 'SELL', quantity: 130, positionType: 'CARRYFORWARD' });
    expect(scan).toEqual({ kind: 'protective', orders: [expect.objectContaining({ orderId: 'SL1', variety: 'STOPLOSS' })] });
  });
  it('restingFloorStop reads our open stop from the book by tag (a cancelled earlier one is ignored)', () => {
    const book = [ours({ orderid: 'OLD', status: 'cancelled' }), ours(), { orderid: 'X', ordertag: 'axMabc', status: 'open' }];
    expect(restingFloorStop(book, 'trk1')).toEqual({
      kind: 'open', orderId: 'SL1', variety: 'STOPLOSS', side: 'SELL', trigger: 180.75, limit: 180.6, quantity: 130, status: 'trigger pending',
    });
    expect(restingFloorStop([ours({ status: 'complete', averageprice: '180.7', filledshares: '130' })], 'trk1')).toEqual({
      kind: 'complete', orderId: 'SL1', averagePrice: 180.7, filledQty: 130,
    });
    expect(restingFloorStop([ours({ status: 'cancelled' })], 'trk1')).toEqual({ kind: 'none' });
  });
});

describe('simulateStopFill (shadow measurement and the replay)', () => {
  const m = (min: number) => Date.UTC(2026, 10, 6, 5, min);
  const bar = (min: number, o: number, h: number, l: number, c: number) => ({ ts: m(min), open: o, high: h, low: l, close: c });
  const steps = [{ at: m(0), trigger: 158.85, limit: 158.7 }];
  it('a bar trading through the trigger fills at the trigger (limit as the conservative case)', () => {
    const r = simulateStopFill({ side: 'SELL', bars: [bar(1, 162, 163, 160, 161), bar(2, 161, 161, 155, 156)], steps, untilMs: m(9), actualExit: 152.95 });
    expect(r).toEqual({ triggered: true, triggeredAt: m(2), fill: 158.85, fillAtLimit: 158.7, note: 'TRADED_THROUGH' });
  });
  it('a bar opening through the trigger but above the limit fills at its open', () => {
    const r = simulateStopFill({ side: 'SELL', bars: [bar(1, 158.75, 159, 150, 151)], steps, untilMs: m(9), actualExit: 152.95 });
    expect(r).toMatchObject({ fill: 158.75, fillAtLimit: 158.7, note: 'OPENED_THROUGH_TRIGGER' });
  });
  it('a gap below the limit fills only if a LATER bar comes back to the limit, else the backstop exit is the fill', () => {
    const gap = bar(1, 150, 152, 149, 151);
    expect(simulateStopFill({ side: 'SELL', bars: [gap, bar(2, 151, 159, 151, 158)], steps, untilMs: m(9), actualExit: 152.95 })).toMatchObject({
      fill: 158.7, fillAtLimit: 158.7, note: 'LIMIT_FILLED_ON_RECOVERY',
    });
    expect(simulateStopFill({ side: 'SELL', bars: [gap], steps, untilMs: m(9), actualExit: 152.95 })).toMatchObject({
      triggered: true, fill: 152.95, fillAtLimit: 152.95, note: 'GAPPED_BELOW_LIMIT_BACKSTOP',
    });
  });
  it('uses the step in force at each bar (trailed up), and bars before the first step never trigger', () => {
    const s = [{ at: m(1), trigger: 150, limit: 149.85 }, { at: m(3), trigger: 158.85, limit: 158.7 }];
    const bars = [bar(0, 140, 141, 139, 140), bar(1, 160, 161, 155, 156), bar(3, 160, 160, 157, 158)];
    expect(simulateStopFill({ side: 'SELL', bars, steps: s, untilMs: m(9), actualExit: 152 })).toMatchObject({ triggeredAt: m(3), fill: 158.85 });
  });
  it('a cancelled stop (trigger null) stops protecting', () => {
    const s = [{ at: m(0), trigger: 158.85, limit: 158.7 }, { at: m(1), trigger: null, limit: null }];
    expect(simulateStopFill({ side: 'SELL', bars: [bar(2, 160, 160, 150, 151)], steps: s, untilMs: m(9), actualExit: 151 })).toMatchObject({ triggered: false, note: 'NOT_TRIGGERED' });
  });
  it('a BUY stop (short) mirrors it', () => {
    const s = [{ at: m(0), trigger: 100, limit: 100.15 }];
    expect(simulateStopFill({ side: 'BUY', bars: [bar(1, 98, 103, 97, 102)], steps: s, untilMs: m(9), actualExit: 104 })).toMatchObject({ fill: 100, fillAtLimit: 100.15 });
  });
});
