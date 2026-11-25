import type { SetupPlan } from './setup.types';
import type { Bar15m } from './setup-watch';
import {
  MAX_GRADE_SESSIONS,
  buildGrade,
  gateTotals,
  gradeKindOf,
  gradeSummaryLine,
  referencePlan,
  replayPlan,
  validUntilFor,
  type GradeRow,
  type GradeTrade,
  type SetupGrade,
} from './setup-grade';

const IST = (hhmm: string, day = '2026-11-24') => new Date(`${day}T${hhmm}:00+05:30`);
const bar = (hhmm: string, open: number, high: number, low: number, close: number, day = '2026-11-24'): Bar15m => ({ ts: IST(hhmm, day).getTime(), open, high, low, close });
/** Flat bars at `px` for every 15m slot in [from, to). */
function flat(from: string, to: string, px: number): Bar15m[] {
  const out: Bar15m[] = [];
  for (let t = IST(from).getTime(); t < IST(to).getTime(); t += 15 * 60_000) out.push({ ts: t, open: px, high: px + 0.5, low: px - 0.5, close: px });
  return out;
}
const NIGHT = IST('18:40');

/** DABUR CE pullback: zone 424–426, SL 420, T 432 / 436, valid until 12:00. */
const dabur = (over: Partial<SetupPlan> = {}): SetupPlan => ({
  instrument: { kind: 'OPT', symbol: 'DABUR', strike: 430, optionType: 'CE', expiry: '2026-12-29' },
  side: 'BUY',
  entry: { type: 'LIMIT_PULLBACK', low: 424, high: 426, trigger: null, level: null },
  sl: 420,
  targets: [432, 436],
  validUntil: '12:00',
  confidence: 70,
  evidence: [],
  ...over,
});
const CREATED = IST('10:05');
const VALID = IST('12:00');

/** Bars 10:00 … 11:45 with `over` replacing slots by 'HH:mm'. */
function day(over: Record<string, Bar15m>, px = 430): Bar15m[] {
  return flat('10:00', '12:00', px).map((b) => {
    const k = new Date(b.ts + 330 * 60_000).toISOString().slice(11, 16);
    return over[k] ?? b;
  });
}

describe('replayPlan (15m bars, the watch rules)', () => {
  it('pullback fills at the zone top, T1 trails, T2 closes → TARGET (T2)', () => {
    const bars = day({ '10:15': bar('10:15', 430, 431, 425, 427), '10:30': bar('10:30', 427, 433, 426.5, 432.5), '10:45': bar('10:45', 432.5, 437, 432, 436.5) });
    const r = replayPlan({ setup: dabur(), createdAt: CREATED, validUntil: VALID, bars, now: NIGHT });
    expect(r).toMatchObject({ status: 'DONE', filled: true, fillUnderlying: 426, exit: 'TARGET', outcome: 'T2', trailed: true, exitUnderlying: 436, points: 10 });
  });

  it('fills then the SL in the same bar (adverse extreme first) → SL at the SL level', () => {
    const bars = day({ '10:15': bar('10:15', 430, 433, 419, 421) });
    const r = replayPlan({ setup: dabur(), createdAt: CREATED, validUntil: VALID, bars, now: NIGHT });
    expect(r).toMatchObject({ status: 'DONE', filled: true, fillUnderlying: 426, exit: 'SL', outcome: 'SL', exitUnderlying: 420, points: -6 });
  });

  it('never comes back to the zone → NOT filled at validUntil', () => {
    const r = replayPlan({ setup: dabur(), createdAt: CREATED, validUntil: VALID, bars: day({}), now: NIGHT });
    expect(r).toMatchObject({ status: 'DONE', filled: false, reason: expect.stringMatching(/^VALID_UNTIL_PASSED/) });
  });

  it('validUntil not after the setup (a vetoed valid_until_past) → never fills', () => {
    const bars = day({ '10:15': bar('10:15', 430, 431, 425, 427) });
    expect(replayPlan({ setup: dabur(), createdAt: IST('10:20'), validUntil: IST('10:20'), bars, now: NIGHT })).toMatchObject({ status: 'DONE', filled: false, reason: expect.stringMatching(/^VALID_UNTIL_PASSED/) });
  });

  it('gap through the SL before entry → never fills (SL_CROSSED_BEFORE_ENTRY)', () => {
    const bars = day({ '10:15': bar('10:15', 418, 419, 416, 418.5) });
    const r = replayPlan({ setup: dabur(), createdAt: CREATED, validUntil: VALID, bars, now: NIGHT });
    expect(r).toMatchObject({ status: 'DONE', filled: false, reason: expect.stringMatching(/^SL_CROSSED_BEFORE_ENTRY/) });
  });

  it('T1 then back to the worst-fill entry → stopped at entry (T1_THEN_STOP, 0 points)', () => {
    const bars = day({ '10:15': bar('10:15', 430, 431, 425, 427), '10:30': bar('10:30', 427, 432.5, 427, 432), '10:45': bar('10:45', 432, 432, 425.5, 426) });
    const r = replayPlan({ setup: dabur(), createdAt: CREATED, validUntil: VALID, bars, now: NIGHT });
    expect(r).toMatchObject({ status: 'DONE', exit: 'SL', outcome: 'T1_THEN_STOP', trailed: true, exitUnderlying: 426, points: 0 });
  });

  it('filled and neither level → TIME at the close of the bar ending at validUntil', () => {
    const bars = day({ '10:15': bar('10:15', 430, 431, 425, 427), '11:45': bar('11:45', 428, 429, 427.5, 428.25) }, 428);
    const r = replayPlan({ setup: dabur(), createdAt: CREATED, validUntil: VALID, bars, now: NIGHT });
    expect(r).toMatchObject({ status: 'DONE', exit: 'TIME', outcome: 'TIME', exitUnderlying: 428.25, points: 2.25 });
  });

  it('validUntil inside a bar: that bar is not walked (no price after validUntil); TIME at the previous close', () => {
    // validUntil 11:50: the 11:45 bar (to 12:00) dives through the SL but must not count.
    const bars = day({ '10:15': bar('10:15', 430, 431, 425, 427), '11:30': bar('11:30', 428, 429, 427.5, 428.5), '11:45': bar('11:45', 428.5, 429, 410, 412) }, 428);
    expect(replayPlan({ setup: dabur(), createdAt: CREATED, validUntil: IST('11:50'), bars, now: NIGHT })).toMatchObject({ exit: 'TIME', exitUnderlying: 428.5, exitAt: IST('11:50').toISOString() });
    const never = day({ '11:45': bar('11:45', 430, 430, 425, 425) });
    expect(replayPlan({ setup: dabur(), createdAt: CREATED, validUntil: IST('11:50'), bars: never, now: NIGHT })).toMatchObject({ filled: false, reason: expect.stringMatching(/^VALID_UNTIL_PASSED/) });
  });

  it('a missing 15m bar before the outcome → MISSING_BARS (never a guess)', () => {
    const bars = day({}).filter((b) => b.ts !== IST('10:45').getTime());
    expect(replayPlan({ setup: dabur(), createdAt: CREATED, validUntil: VALID, bars, now: NIGHT })).toMatchObject({ status: 'MISSING_BARS', reason: expect.stringContaining('10:45') });
  });

  it('bars that stop before validUntil (or are not yet closed) → MISSING_BARS', () => {
    expect(replayPlan({ setup: dabur(), createdAt: CREATED, validUntil: VALID, bars: flat('10:00', '11:00', 430), now: NIGHT }).status).toBe('MISSING_BARS');
    expect(replayPlan({ setup: dabur(), createdAt: CREATED, validUntil: VALID, bars: day({}), now: IST('11:50') }).status).toBe('MISSING_BARS');
  });

  it('an outcome before a missing later bar is still graded', () => {
    const bars = day({ '10:15': bar('10:15', 430, 433, 419, 421) }).filter((b) => b.ts < IST('11:00').getTime());
    expect(replayPlan({ setup: dabur(), createdAt: CREATED, validUntil: VALID, bars, now: NIGHT })).toMatchObject({ status: 'DONE', exit: 'SL' });
  });

  it('BREAKOUT_TRIGGER: fills at the next bar after a 15m close beyond the trigger', () => {
    const s = dabur({ entry: { type: 'BREAKOUT_TRIGGER', low: 431, high: 431, trigger: 431, level: 430.5 }, sl: 428, targets: [436] });
    const bars = day({ '10:15': bar('10:15', 430, 432, 429.5, 431.5), '10:30': bar('10:30', 431.8, 437, 431.2, 436.5) });
    const r = replayPlan({ setup: s, createdAt: CREATED, validUntil: VALID, bars, now: NIGHT });
    expect(r).toMatchObject({ status: 'DONE', filled: true, fillUnderlying: 431.8, fillAt: IST('10:30').toISOString(), exit: 'TARGET', exitUnderlying: 436 });
  });

  it('MARKET_NOW fills at the decision LTP when given', () => {
    const s = dabur({ entry: { type: 'MARKET_NOW', low: 430, high: 430, trigger: null, level: 430 }, sl: 427, targets: [433] });
    const bars = day({ '10:15': bar('10:15', 430, 433.5, 429.5, 433) });
    expect(replayPlan({ setup: s, createdAt: CREATED, validUntil: VALID, bars, now: NIGHT, marketFill: 430.4 })).toMatchObject({
      filled: true, fillUnderlying: 430.4, fillAt: CREATED.toISOString(), exit: 'TARGET', points: 2.6,
    });
  });

  it('PE mirror: pullback up into the zone, SL above, target below', () => {
    const s = dabur({ instrument: { kind: 'OPT', symbol: 'DABUR', strike: 420, optionType: 'PE', expiry: '2026-12-29' }, entry: { type: 'LIMIT_PULLBACK', low: 433, high: 435, trigger: null, level: null }, sl: 439, targets: [428] });
    const bars = day({ '10:15': bar('10:15', 430, 434, 429.5, 433.5), '10:30': bar('10:30', 433.5, 434, 427, 428) });
    expect(replayPlan({ setup: s, createdAt: CREATED, validUntil: VALID, bars, now: NIGHT })).toMatchObject({ filled: true, fillUnderlying: 433, exit: 'TARGET', exitUnderlying: 428, points: 5 });
  });
});

describe('validUntilFor / referencePlan / gradeKindOf', () => {
  it('HH:mm on the row day, clamped to the intraday cut-off', () => {
    expect(validUntilFor(CREATED, '12:00', 'NSE').toISOString()).toBe(VALID.toISOString());
    expect(validUntilFor(CREATED, '15:25', 'NSE').toISOString()).toBe(IST('15:15').toISOString());
    expect(validUntilFor(CREATED, 'junk', 'MCX').toISOString()).toBe(IST('23:00').toISOString());
  });

  it('neutral reference: MARKET_NOW at the packet LTP in the claim direction, SL / target = 1 × ATR15m, ATM delta', () => {
    const r = referencePlan(packet(), 'BEAR', 'NSE');
    expect(r).toMatchObject({ ok: true, fill: 431, delta: 0.45, lotSize: 1250 });
    if (!r.ok) throw new Error('no plan');
    expect(r.setup).toMatchObject({ instrument: { optionType: 'PE', strike: 430 }, entry: { type: 'MARKET_NOW', low: 431, high: 431 }, sl: 434, targets: [428], validUntil: '15:15' });
    expect(r.definition).toMatch(/1 × ATR15m/);
  });

  it('reference without the packet LTP / ATR → not ok (no guessed trade)', () => {
    expect(referencePlan({ ...packet(), quote: { status: 'unavailable', reason: 'timeout' } }, 'BULL', 'NSE')).toMatchObject({ ok: false, reason: expect.stringMatching(/LTP/) });
    expect(referencePlan(packet(), 'NEUTRAL', 'NSE')).toMatchObject({ ok: false });
  });

  it('kinds: SETUP, vetoed setup, plain NO_TRADE; SKIPPED is not graded', () => {
    expect(gradeKindOf(row({}))).toBe('SETUP');
    expect(gradeKindOf(row({ status: 'NO_TRADE' }))).toBe('NO_TRADE_VETOED');
    expect(gradeKindOf(row({ decision: 'NO_TRADE', status: 'NO_TRADE', setup: null }))).toBe('NO_TRADE_REFERENCE');
    expect(gradeKindOf(row({ decision: 'SKIPPED', status: 'SKIPPED', setup: null }))).toBeNull();
  });
});

function packet(): Record<string, unknown> {
  return {
    optionExchange: 'NFO',
    claim: { subject: 'DABUR', bias: 'BULL', horizon: 'INTRADAY', claimType: 'DIRECTION', verdict: 'CONFIRMED' },
    quote: { status: 'present', value: { ltp: 431 } },
    bars15m: { status: 'present', value: { atr15m: 3 } },
    chain: {
      status: 'present',
      value: {
        exchange: 'NFO', expiry: '2026-12-29', lotSize: 1250,
        rows: [
          { strike: 425, ce: { delta: 0.7 }, pe: { delta: -0.3 } },
          { strike: 430, ce: { delta: 0.55 }, pe: { delta: -0.45 } },
          { strike: 435, ce: { delta: 0.35 }, pe: { delta: -0.65 } },
        ],
      },
    },
  };
}

function row(over: Partial<GradeRow>): GradeRow {
  return {
    id: 's1',
    underlying: 'DABUR',
    decision: 'SETUP',
    status: 'EXITED',
    setup: dabur(),
    checks: { stage: 'checks', context: { ltpUnderlying: 431, atr15m: 3, delta: 0.5, lotSize: 1250, exchange: 'NFO' } },
    packet: packet(),
    tradeId: 't1',
    validUntil: VALID,
    createdAt: CREATED,
    exitReason: 'AI_SETUP_TARGET',
    pnl: 3000,
    grade: null,
    ...over,
  };
}
const TRADE: GradeTrade = { id: 't1', status: 'CLOSED', pnl: 3000, fees: 82.5, exitReasonTag: 'AI_SETUP_TARGET', isPaperTrade: true };
const WIN = day({ '10:15': bar('10:15', 430, 431, 425, 427), '10:30': bar('10:30', 427, 433, 426.5, 432.5), '10:45': bar('10:45', 432.5, 437, 432, 436.5) });
const SESSION = '2026-11-24';

describe('buildGrade', () => {
  it('SETUP: actual net = Trade pnl − fees, plus the plan-only replay in ₹ (points × |delta| × lot)', () => {
    const g = buildGrade({ row: row({}), trade: TRADE, bars: WIN, barsError: null, now: NIGHT, session: SESSION });
    expect(g).toMatchObject({
      status: 'GRADED', kind: 'SETUP', session: SESSION,
      actual: { filled: true, exitReason: 'AI_SETUP_TARGET', pnlGross: 3000, fees: 82.5, net: 2917.5, tradeId: 't1' },
      plan: { filled: true, outcome: 'T2', points: 10, delta: 0.5, lotSize: 1250, rupees: 6250 },
    });
  });

  it('SETUP expired unfilled: actual not filled, ₹0', () => {
    const g = buildGrade({ row: row({ status: 'EXPIRED', tradeId: null, exitReason: 'VALID_UNTIL_PASSED: …', pnl: null }), trade: null, bars: day({}), barsError: null, now: NIGHT, session: SESSION });
    expect(g).toMatchObject({ status: 'GRADED', actual: { filled: false, net: 0 }, plan: { filled: false, rupees: 0 } });
  });

  it('SETUP still FILLED at night, or its trade still open → PENDING with the reason', () => {
    expect(buildGrade({ row: row({ status: 'FILLED' }), trade: TRADE, bars: WIN, barsError: null, now: NIGHT, session: SESSION })).toMatchObject({ status: 'PENDING', reason: expect.stringContaining('FILLED'), sessionsTried: [SESSION] });
    expect(buildGrade({ row: row({}), trade: { ...TRADE, status: 'OPEN' }, bars: WIN, barsError: null, now: NIGHT, session: SESSION })).toMatchObject({ status: 'PENDING' });
  });

  it('actual ready + no bars → GRADED (counted in the gate) with the plan PENDING', () => {
    const g = buildGrade({ row: row({}), trade: TRADE, bars: null, barsError: 'no 15m bar loader', now: NIGHT, session: SESSION });
    expect(g).toMatchObject({ status: 'GRADED', actual: { filled: true, net: 2917.5 }, plan: { status: 'PENDING', reason: expect.stringContaining('no 15m bar loader'), sessionsTried: [SESSION] } });
    expect(gateTotals([g])).toMatchObject({ gradedSetups: 1, tradedSetups: 1, actualNet: 2917.5 });
  });

  it('the next run with bars fills the plan without changing the actual', () => {
    const g1 = buildGrade({ row: row({}), trade: TRADE, bars: null, barsError: 'x', now: NIGHT, session: SESSION })!;
    // Even a different trade read later never rewrites a graded actual.
    const g2 = buildGrade({ row: row({ grade: g1 }), trade: { ...TRADE, pnl: 99, fees: 1 }, bars: WIN, barsError: null, now: NIGHT, session: '2026-11-25' });
    expect(g2).toMatchObject({ status: 'GRADED', actual: g1.actual, plan: { status: 'GRADED', outcome: 'T2', rupees: 6250 }, sessionsTried: [SESSION, '2026-11-25'] });
  });

  it('bars missing for 5 sessions → only the plan is UNGRADABLE; the same session twice counts once; the actual still counts', () => {
    let prev: SetupGrade = buildGrade({ row: row({}), trade: TRADE, bars: null, barsError: 'x', now: NIGHT, session: SESSION })!;
    prev = buildGrade({ row: row({ grade: prev }), trade: TRADE, bars: null, barsError: 'x', now: NIGHT, session: SESSION })!;
    expect(prev.plan).toMatchObject({ status: 'PENDING', sessionsTried: [SESSION] });
    const days = ['2026-11-25', '2026-11-26', '2026-11-27', '2026-11-30'];
    for (const d of days) prev = buildGrade({ row: row({ grade: prev }), trade: TRADE, bars: day({}).slice(0, 2), barsError: null, now: NIGHT, session: d })!;
    expect(MAX_GRADE_SESSIONS).toBe(5);
    expect(prev).toMatchObject({ status: 'GRADED', actual: { net: 2917.5 }, plan: { status: 'UNGRADABLE', reason: expect.stringContaining('5 sessions'), sessionsTried: [SESSION, ...days] } });
    expect(gateTotals([prev])).toMatchObject({ tradedSetups: 1, actualNet: 2917.5 });
  });

  it('the actual never ready for 5 sessions → UNGRADABLE with the reason (plan kept)', () => {
    let prev: SetupGrade | null = null;
    for (const d of [SESSION, '2026-11-25', '2026-11-26', '2026-11-27', '2026-11-30']) {
      prev = buildGrade({ row: row({ grade: prev }), trade: null, bars: WIN, barsError: null, now: NIGHT, session: d });
    }
    expect(prev).toMatchObject({ status: 'UNGRADABLE', reason: expect.stringMatching(/5 sessions: paper trade t1 not found/), plan: { status: 'GRADED' } });
    expect(gateTotals([prev])).toMatchObject({ gradedSetups: 0, tradedSetups: 0 });
  });

  it('NO_TRADE what-if with no bars → PENDING, then graded when bars arrive', () => {
    const v = row({ status: 'NO_TRADE', tradeId: null, validUntil: null, pnl: null });
    const g1 = buildGrade({ row: v, trade: null, bars: null, barsError: 'x', now: NIGHT, session: SESSION })!;
    expect(g1).toMatchObject({ status: 'PENDING', whatIf: { status: 'PENDING', hypothetical: true } });
    expect(buildGrade({ row: { ...v, grade: g1 }, trade: null, bars: WIN, barsError: null, now: NIGHT, session: '2026-11-25' })).toMatchObject({ status: 'GRADED', whatIf: { status: 'GRADED', outcome: 'T2' } });
  });

  it('NO_TRADE with a vetoed setup → the setup replayed as a labelled what-if (no actual)', () => {
    const g = buildGrade({ row: row({ status: 'NO_TRADE', tradeId: null, validUntil: null, pnl: null }), trade: null, bars: WIN, barsError: null, now: NIGHT, session: SESSION });
    expect(g).toMatchObject({ status: 'GRADED', kind: 'NO_TRADE_VETOED', whatIf: { hypothetical: true, filled: true, outcome: 'T2', rupees: 6250 } });
    expect(g).not.toHaveProperty('actual');
    expect(g).not.toHaveProperty('plan');
  });

  it('NO_TRADE without a setup → the neutral reference trade, labelled', () => {
    const r = row({ decision: 'NO_TRADE', status: 'NO_TRADE', setup: null, tradeId: null, validUntil: null, pnl: null, checks: { stage: 'ai' }, createdAt: IST('10:05') });
    // BULL reference: MARKET_NOW 431, SL 428, target 434; 10:15 bar runs to 434.5.
    const bars = [...flat('10:00', '10:15', 431), bar('10:15', 431, 434.5, 430.5, 434), ...flat('10:30', '15:15', 434)];
    const g = buildGrade({ row: r, trade: null, bars, barsError: null, now: NIGHT, session: SESSION });
    expect(g).toMatchObject({ status: 'GRADED', kind: 'NO_TRADE_REFERENCE', whatIf: { hypothetical: true, reference: expect.stringMatching(/neutral reference/), filled: true, outcome: 'T1', points: 3, delta: 0.55, lotSize: 1250, rupees: 2062.5 } });
  });

  it('NO_TRADE without the inputs for a reference → UNGRADABLE at once (no retry, no guess)', () => {
    const r = row({ decision: 'NO_TRADE', status: 'NO_TRADE', setup: null, tradeId: null, packet: { ...packet(), quote: { status: 'unavailable', reason: 'timeout' } } });
    expect(buildGrade({ row: r, trade: null, bars: WIN, barsError: null, now: NIGHT, session: SESSION })).toMatchObject({ status: 'UNGRADABLE', reason: expect.stringMatching(/LTP/) });
  });

  it('₹ is null with the reason when delta or lot is missing (never guessed)', () => {
    const g = buildGrade({ row: row({ checks: { context: { delta: null, lotSize: 1250 } } }), trade: TRADE, bars: WIN, barsError: null, now: NIGHT, session: SESSION });
    expect(g).toMatchObject({ status: 'GRADED', plan: { points: 10, rupees: null, rupeesNote: expect.stringMatching(/delta/) } });
  });
});

describe('gateTotals / gradeSummaryLine', () => {
  it('the gate counts FILLED setups; never-filled ones show as graded only; what-ifs never mix in', () => {
    const a = buildGrade({ row: row({}), trade: TRADE, bars: WIN, barsError: null, now: NIGHT, session: SESSION })!;
    const e = buildGrade({ row: row({ id: 'e', status: 'EXPIRED', tradeId: null, pnl: null }), trade: null, bars: day({}), barsError: null, now: NIGHT, session: SESSION })!;
    const v = buildGrade({ row: row({ status: 'NO_TRADE', tradeId: null }), trade: null, bars: WIN, barsError: null, now: NIGHT, session: SESSION })!;
    const t = gateTotals([a, a, e, v]);
    expect(t).toEqual({ gradedSetups: 3, tradedSetups: 2, actualNet: 5835, gateMin: 20, gateMet: false });
    const line = gradeSummaryLine('NSE', [{ prev: null, grade: a }, { prev: null, grade: e }, { prev: null, grade: v }], t);
    expect(line).toMatch(/setups graded 2 \/ traded 1; actual net ₹2917.5/);
    expect(line).toMatch(/plan-only net ₹6250/);
    expect(line).toMatch(/NO_TRADE what-if net ₹6250/);
    expect(line).toMatch(/live gate: 2\/20 traded setups \(3 graded\), cumulative actual net ₹5835/);
  });

  it('20 traded setups with net > 0 meet the gate numbers; 20 graded but unfilled do not', () => {
    const a = buildGrade({ row: row({}), trade: TRADE, bars: WIN, barsError: null, now: NIGHT, session: SESSION })!;
    const e = buildGrade({ row: row({ status: 'EXPIRED', tradeId: null, pnl: null }), trade: null, bars: day({}), barsError: null, now: NIGHT, session: SESSION })!;
    expect(gateTotals(Array(20).fill(a)).gateMet).toBe(true);
    expect(gateTotals([...Array(19).fill(e), a]).gateMet).toBe(false);
  });

  it('a later run that only fills the plan does not re-count the actual in the run line', () => {
    const g1 = buildGrade({ row: row({}), trade: TRADE, bars: null, barsError: 'x', now: NIGHT, session: SESSION })!;
    const g2 = buildGrade({ row: row({ grade: g1 }), trade: TRADE, bars: WIN, barsError: null, now: NIGHT, session: '2026-11-25' })!;
    const line = gradeSummaryLine('NSE', [{ prev: g1, grade: g2 }], gateTotals([g2]));
    expect(line).toMatch(/setups graded 0 \/ traded 0; actual net ₹0; plan-only net ₹6250 \(1 plans\)/);
  });
});
