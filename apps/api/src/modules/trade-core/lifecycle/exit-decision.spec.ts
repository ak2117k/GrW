import { decideExit, effectiveHoldDays, effectiveSquareOff, tradingDaysHeld, type ExitInputs } from './exit-decision';
import type { CorePosition } from './lifecycle.types';
import { adaptivePlan, cashPlan, mtfPlan, NOW, optionPlan, positionFor } from './testing/lifecycle-fixtures';

/** IST wall-clock on an IST date. */
const ist = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00.000+05:30`);
const px = (ltp: number, now: Date = NOW) => ({ ltp, at: now.getTime() });

function inputs(position: CorePosition, over: Partial<ExitInputs> = {}): ExitInputs {
  const now = over.now ?? NOW;
  return {
    position,
    price: px(position.entryAvgPrice ?? 500, now),
    underlyingLtp: null,
    now,
    sessionOpen: true,
    killSwitchActive: false,
    squareOffHhmm: position.plan.squareOffHhmm,
    mtfMaxHoldDays: position.plan.mtfMaxHoldDays,
    tradingDaysHeld: 0,
    recovering: false,
    firstPriceOfDay: false,
    ...over,
  };
}

describe('decideExit (spec §7.3)', () => {
  const cash = positionFor(cashPlan()); // stop 492.5, target 515, clock exit 15:25, square-off 15:15

  it('decides nothing while the session is closed, even with the kill switch on (ruling L9)', () => {
    expect(decideExit(inputs(cash, { sessionOpen: false, killSwitchActive: true, price: px(400) }))).toEqual({ kind: 'NONE' });
  });

  it('decides nothing for a position with nothing open', () => {
    expect(decideExit(inputs({ ...cash, openQty: 0, status: 'PENDING_ENTRY' }, { killSwitchActive: true }))).toEqual({ kind: 'NONE' });
  });

  it('the kill switch outranks a crossed stop (priority 1)', () => {
    expect(decideExit(inputs(cash, { killSwitchActive: true, price: px(400) }))).toMatchObject({ kind: 'EXIT', reason: 'KILL_SWITCH' });
  });

  it('a crossed stop is STOP; once the stop has moved or the trail is active it is TRAIL', () => {
    expect(decideExit(inputs(cash, { price: px(492.5) }))).toMatchObject({ kind: 'EXIT', reason: 'STOP' });
    expect(decideExit(inputs(cash, { price: px(492.6) }))).toEqual({ kind: 'NONE' });
    expect(decideExit(inputs({ ...cash, stopPrice: 500 }, { price: px(499) }))).toMatchObject({ reason: 'TRAIL' });
    expect(decideExit(inputs({ ...cash, trailActive: true }, { price: px(490) }))).toMatchObject({ reason: 'TRAIL' });
    expect(decideExit(inputs(positionFor(cashPlan({ side: 'SELL' })), { price: px(507.5) }))).toMatchObject({ reason: 'STOP' });
  });

  it('the first price after a restart is a RECOVERY_STOP; the first price of an IST day is a GAP_STOP', () => {
    expect(decideExit(inputs(cash, { price: px(480), recovering: true, firstPriceOfDay: true }))).toMatchObject({ reason: 'RECOVERY_STOP' });
    expect(decideExit(inputs(cash, { price: px(480), firstPriceOfDay: true }))).toMatchObject({ reason: 'GAP_STOP' });
  });

  it('without a fresh price no price rule fires', () => {
    expect(decideExit(inputs(cash, { price: null }))).toEqual({ kind: 'NONE' });
  });

  it('target exits everything; the partial level sells the partial quantity once; zero when nothing would remain', () => {
    expect(decideExit(inputs(cash, { price: px(515) }))).toMatchObject({ kind: 'EXIT', reason: 'TARGET' });
    const adaptive = positionFor(adaptivePlan()); // stop 494, partial 505 × 50, target 510
    expect(decideExit(inputs(adaptive, { price: px(505) }))).toMatchObject({ kind: 'PARTIAL', qty: 50 });
    expect(decideExit(inputs({ ...adaptive, partialDone: true }, { price: px(506) }))).toEqual({ kind: 'NONE' });
    expect(decideExit(inputs({ ...adaptive, openQty: 50, partialQty: 50 }, { price: px(505) }))).toMatchObject({ kind: 'PARTIAL', qty: 0 });
    expect(decideExit(inputs(adaptive, { price: px(510) }))).toMatchObject({ kind: 'EXIT', reason: 'TARGET' });
  });

  it('the clock time exit fires at its IST minute, price or not', () => {
    const p = positionFor(cashPlan({ timeExit: { kind: 'clock', hhmm: '14:00' } }));
    expect(decideExit(inputs(p, { now: ist('2026-10-12', '13:59'), price: null }))).toEqual({ kind: 'NONE' });
    expect(decideExit(inputs(p, { now: ist('2026-10-12', '14:00'), price: null }))).toMatchObject({ reason: 'TIME_EXIT' });
  });

  it('intraday vehicles square off at the effective time, and at once on a later IST day (rulings L7, L8)', () => {
    expect(decideExit(inputs(cash, { now: ist('2026-10-12', '15:14'), price: null }))).toEqual({ kind: 'NONE' });
    expect(decideExit(inputs(cash, { now: ist('2026-10-12', '15:15'), price: null }))).toMatchObject({ reason: 'SQUARE_OFF' });
    expect(decideExit(inputs(cash, { now: ist('2026-10-12', '14:00'), squareOffHhmm: '14:00', price: null }))).toMatchObject({ reason: 'SQUARE_OFF' });
    expect(decideExit(inputs(cash, { now: ist('2026-10-13', '09:16'), price: null }))).toMatchObject({ reason: 'SQUARE_OFF' });
  });

  it('MTF holds overnight; holdDays and the hold limit exit at squareOffTime on the n-th trading day (O5)', () => {
    const mtf = positionFor(mtfPlan()); // holdDays 3, mtfMaxHoldDays 10, square-off 15:20
    expect(decideExit(inputs(mtf, { now: ist('2026-10-13', '15:30'), tradingDaysHeld: 1, price: null }))).toEqual({ kind: 'NONE' });
    expect(decideExit(inputs(mtf, { now: ist('2026-10-15', '15:19'), tradingDaysHeld: 3, price: null }))).toEqual({ kind: 'NONE' });
    expect(decideExit(inputs(mtf, { now: ist('2026-10-15', '15:20'), tradingDaysHeld: 3, price: null }))).toMatchObject({ reason: 'TIME_EXIT' });
    const long = positionFor(mtfPlan({ timeExit: { kind: 'holdDays', n: 30 } }));
    expect(decideExit(inputs(long, { now: ist('2026-10-26', '15:20'), tradingDaysHeld: 10, price: null }))).toMatchObject({ reason: 'HOLD_LIMIT' });
    expect(decideExit(inputs(long, { now: ist('2026-10-20', '15:20'), tradingDaysHeld: 6, mtfMaxHoldDays: 5, price: null }))).toMatchObject({ reason: 'HOLD_LIMIT' });
  });

  it('options: out by the expiry-day cutoff, at once after expiry, and the theta stop after its window', () => {
    const onExpiryDay = positionFor(optionPlan({ entryDay: '2026-10-15' }), { openedAt: ist('2026-10-15', '14:00'), highWater: 120 });
    expect(decideExit(inputs(onExpiryDay, { now: ist('2026-10-15', '14:29'), price: null }))).toEqual({ kind: 'NONE' });
    expect(decideExit(inputs(onExpiryDay, { now: ist('2026-10-15', '14:30'), price: null }))).toMatchObject({ reason: 'EXPIRY_DAY' });
    expect(decideExit(inputs(onExpiryDay, { now: ist('2026-10-16', '09:20'), price: null }))).toMatchObject({ reason: 'EXPIRY_DAY' });
    const opt = positionFor(optionPlan()); // opened 10:20 IST: theta needs +10 % by 10:50
    expect(decideExit(inputs(opt, { now: ist('2026-10-12', '10:49'), price: null }))).toEqual({ kind: 'NONE' });
    expect(decideExit(inputs(opt, { now: ist('2026-10-12', '10:50'), price: null }))).toMatchObject({ reason: 'THETA_STOP' });
    expect(decideExit(inputs({ ...opt, highWater: 110 }, { now: ist('2026-10-12', '10:50'), price: null }))).toEqual({ kind: 'NONE' });
  });

  it('options: the premium stop, and an explicit underlying stop (CE below, PE above)', () => {
    expect(decideExit(inputs(positionFor(optionPlan()), { price: px(75) }))).toMatchObject({ reason: 'STOP' });
    const ref = { exchange: 'NSE' as const, token: '26000', symbol: 'NIFTY' };
    const base = optionPlan().option!;
    const ce = positionFor(optionPlan({ option: { ...base, underlyingRef: ref, underlyingStopPrice: 24900 } }));
    expect(decideExit(inputs(ce, { underlyingLtp: 24901 }))).toEqual({ kind: 'NONE' });
    expect(decideExit(inputs(ce, { underlyingLtp: 24900 }))).toMatchObject({ reason: 'UNDERLYING_STOP' });
    const pe = positionFor(optionPlan({ option: { ...base, optionType: 'PE', underlyingRef: ref, underlyingStopPrice: 25100 } }));
    expect(decideExit(inputs(pe, { underlyingLtp: 25100 }))).toMatchObject({ reason: 'UNDERLYING_STOP' });
  });
});

describe('effective limits (O4) and trading days held (O5)', () => {
  it('the square-off is the earlier of frozen and live; a loosening never extends', () => {
    expect(effectiveSquareOff('15:15', '14:00')).toBe('14:00');
    expect(effectiveSquareOff('15:15', '15:25')).toBe('15:15');
    expect(effectiveSquareOff('15:15', null)).toBe('15:15');
    expect(effectiveSquareOff('15:15', 'garbage')).toBe('15:15');
  });

  it('the hold limit is the lower of frozen and live; null for non-MTF', () => {
    expect(effectiveHoldDays(10, 5)).toBe(5);
    expect(effectiveHoldDays(10, 20)).toBe(10);
    expect(effectiveHoldDays(10, null)).toBe(10);
    expect(effectiveHoldDays(null, 5)).toBeNull();
  });

  it('counts exchange trading days after the entry day, skipping weekends and holidays', () => {
    const holiday = '2026-10-20';
    const clock = {
      isTradingDay: (_exchange: string, d: Date) => {
        const local = new Date(d.getTime() + 5.5 * 3600_000);
        return local.getUTCDay() !== 0 && local.getUTCDay() !== 6 && local.toISOString().slice(0, 10) !== holiday;
      },
    };
    expect(tradingDaysHeld(clock, 'NSE', '2026-10-12', ist('2026-10-12', '15:00'))).toBe(0);
    expect(tradingDaysHeld(clock, 'NSE', '2026-10-16', ist('2026-10-19', '10:00'))).toBe(1);
    expect(tradingDaysHeld(clock, 'NSE', '2026-10-16', ist('2026-10-21', '10:00'))).toBe(2);
  });
});
