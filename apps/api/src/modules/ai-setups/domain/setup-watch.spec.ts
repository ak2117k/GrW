import type { SetupPlan } from './setup.types';
import { closedBarsSince, filledStep, pendingStep, premiumFloorSl, worstFillLevel } from './setup-watch';

const T = (iso: string) => new Date(iso);
// 2026-11-25 IST: 10:30 = 05:00Z, 15:15 = 09:45Z.
const CREATED = T('2026-11-25T05:00:00Z');
const VALID = T('2026-11-25T09:45:00Z');
const NOW = T('2026-11-25T05:30:00Z');

/** DABUR: BUY 440 CE when DABUR pulls back into 424–425, SL 419.5, T 433.5 / 440. */
const dabur = (over: Partial<SetupPlan> = {}): SetupPlan => ({
  instrument: { kind: 'OPT', symbol: 'DABUR', strike: 440, optionType: 'CE', expiry: '2026-12-30' },
  side: 'BUY',
  entry: { type: 'LIMIT_PULLBACK', low: 424, high: 425, trigger: null, level: null },
  sl: 419.5,
  targets: [433.5, 440],
  validUntil: '15:15',
  confidence: 70,
  evidence: [],
  ...over,
});

describe('pendingStep', () => {
  it('LIMIT_PULLBACK fills when the underlying LTP is inside [low, high], waits outside it', () => {
    expect(pendingStep({ setup: dabur(), ltp: 424.6, now: NOW, validUntil: VALID, createdAt: CREATED }).action).toBe('FILL');
    expect(pendingStep({ setup: dabur(), ltp: 425, now: NOW, validUntil: VALID, createdAt: CREATED }).action).toBe('FILL');
    expect(pendingStep({ setup: dabur(), ltp: 429, now: NOW, validUntil: VALID, createdAt: CREATED }).action).toBe('WAIT');
  });

  it('a gap through the SL (LTP at / beyond the SL) never fills: EXPIRED with the reason', () => {
    const r = pendingStep({ setup: dabur(), ltp: 418, now: NOW, validUntil: VALID, createdAt: CREATED });
    expect(r).toMatchObject({ action: 'EXPIRE', reason: expect.stringMatching(/^SL_CROSSED_BEFORE_ENTRY/) });
    expect(pendingStep({ setup: dabur(), ltp: 419.5, now: NOW, validUntil: VALID, createdAt: CREATED }).action).toBe('EXPIRE');
  });

  it('validUntil passed → EXPIRED, even with the LTP inside the zone and even with no price', () => {
    expect(pendingStep({ setup: dabur(), ltp: 424.5, now: VALID, validUntil: VALID, createdAt: CREATED })).toMatchObject({ action: 'EXPIRE', reason: expect.stringMatching(/^VALID_UNTIL_PASSED/) });
    expect(pendingStep({ setup: dabur(), ltp: null, now: VALID, validUntil: VALID, createdAt: CREATED }).action).toBe('EXPIRE');
  });

  it('no LTP → WAIT (never a fill on an absent price)', () => {
    expect(pendingStep({ setup: dabur({ entry: { type: 'MARKET_NOW', low: 431, high: 431, trigger: null, level: 430 } }), ltp: null, now: NOW, validUntil: VALID, createdAt: CREATED }).action).toBe('WAIT');
  });

  it('MARKET_NOW fills at once (SL not crossed)', () => {
    expect(pendingStep({ setup: dabur({ entry: { type: 'MARKET_NOW', low: 431, high: 431, trigger: null, level: 430 } }), ltp: 431.2, now: NOW, validUntil: VALID, createdAt: CREATED }).action).toBe('FILL');
  });

  it('BREAKOUT_TRIGGER fills only on a CLOSED 15m bar since the setup closing beyond the trigger', () => {
    const s = dabur({ entry: { type: 'BREAKOUT_TRIGGER', low: 432, high: 433, trigger: 432, level: 431.5 }, sl: 428, targets: [440] });
    const bar = (startIso: string, close: number, low = close - 1) => ({ ts: T(startIso).getTime(), open: close, high: close + 1, low, close });
    // An LTP above the trigger is not enough.
    expect(pendingStep({ setup: s, ltp: 433, now: NOW, validUntil: VALID, createdAt: CREATED, bars15m: [] }).action).toBe('WAIT');
    // A bar that closed BEFORE the setup was made does not count.
    expect(pendingStep({ setup: s, ltp: 433, now: NOW, validUntil: VALID, createdAt: CREATED, bars15m: [bar('2026-11-25T04:30:00Z', 433)] }).action).toBe('WAIT');
    // Closed after it, beyond the trigger → fill.
    expect(pendingStep({ setup: s, ltp: 433, now: NOW, validUntil: VALID, createdAt: CREATED, bars15m: [bar('2026-11-25T05:00:00Z', 432.4)] })).toMatchObject({ action: 'FILL', reason: expect.stringContaining('432.4') });
    // No bars read (null) → wait.
    expect(pendingStep({ setup: s, ltp: 433, now: NOW, validUntil: VALID, createdAt: CREATED, bars15m: null }).action).toBe('WAIT');
    // A bar since the setup that went through the SL invalidates it.
    expect(pendingStep({ setup: s, ltp: 433, now: NOW, validUntil: VALID, createdAt: CREATED, bars15m: [bar('2026-11-25T05:00:00Z', 432.4, 427.9)] }).action).toBe('EXPIRE');
  });

  it('PE (bearish): pullback zone above, SL above it', () => {
    const s = dabur({ instrument: { kind: 'OPT', symbol: 'DABUR', strike: 420, optionType: 'PE', expiry: '2026-12-30' }, entry: { type: 'LIMIT_PULLBACK', low: 433, high: 434, trigger: null, level: null }, sl: 437, targets: [428, 424] });
    expect(pendingStep({ setup: s, ltp: 433.5, now: NOW, validUntil: VALID, createdAt: CREATED }).action).toBe('FILL');
    expect(pendingStep({ setup: s, ltp: 437.2, now: NOW, validUntil: VALID, createdAt: CREATED }).action).toBe('EXPIRE');
    expect(pendingStep({ setup: s, ltp: 430, now: NOW, validUntil: VALID, createdAt: CREATED }).action).toBe('WAIT');
  });
});

describe('closedBarsSince', () => {
  it('keeps bars closed by now and closing after the setup was made', () => {
    const b = (iso: string) => ({ ts: T(iso).getTime(), open: 1, high: 1, low: 1, close: 1 });
    const out = closedBarsSince([b('2026-11-25T04:45:00Z'), b('2026-11-25T05:00:00Z'), b('2026-11-25T05:15:00Z'), b('2026-11-25T05:30:00Z')], T('2026-11-25T04:50:00Z'), T('2026-11-25T05:31:00Z'));
    expect(out.map((x) => new Date(x.ts).toISOString())).toEqual(['2026-11-25T04:45:00.000Z', '2026-11-25T05:00:00.000Z', '2026-11-25T05:15:00.000Z']);
  });
});

describe('worstFillLevel', () => {
  it('zone top for a CE pullback, zone bottom for a PE; max/min(edge, trigger) for breakouts; the fill for MARKET_NOW', () => {
    expect(worstFillLevel(dabur(), 424.6)).toBe(425);
    expect(worstFillLevel(dabur({ instrument: { kind: 'OPT', symbol: 'X', strike: 1, optionType: 'PE', expiry: '2026-12-30' }, entry: { type: 'LIMIT_PULLBACK', low: 433, high: 434, trigger: null, level: null } }), 433.5)).toBe(433);
    expect(worstFillLevel(dabur({ entry: { type: 'BREAKOUT_TRIGGER', low: 432, high: 433, trigger: 434, level: 431 } }), 434.2)).toBe(434);
    expect(worstFillLevel(dabur({ entry: { type: 'MARKET_NOW', low: 431, high: 431, trigger: null, level: 430 } }), 431.4)).toBe(431.4);
  });
});

describe('filledStep', () => {
  const base = { now: NOW, validUntil: VALID, minutesToClose: 120 };

  it('the underlying crossing the SL closes AI_SETUP_SL', () => {
    expect(filledStep({ ...base, setup: dabur(), watch: { sl: 419.5, trailed: false, worstFill: 425 }, ltp: 419.4 })).toMatchObject({ action: 'CLOSE', tag: 'AI_SETUP_SL' });
  });

  it('T1 trails the SL to the worst-fill entry level (once); then the SL there closes AI_SETUP_SL; the last target closes AI_SETUP_TARGET', () => {
    const w = { sl: 419.5, trailed: false, worstFill: 425 };
    const t1 = filledStep({ ...base, setup: dabur(), watch: w, ltp: 433.6 });
    expect(t1).toMatchObject({ action: 'TRAIL', sl: 425 });
    const trailed = { ...w, sl: 425, trailed: true };
    expect(filledStep({ ...base, setup: dabur(), watch: trailed, ltp: 434 }).action).toBe('HOLD');
    expect(filledStep({ ...base, setup: dabur(), watch: trailed, ltp: 424.9 })).toMatchObject({ action: 'CLOSE', tag: 'AI_SETUP_SL', reason: expect.stringContaining('trailed') });
    expect(filledStep({ ...base, setup: dabur(), watch: trailed, ltp: 440 })).toMatchObject({ action: 'CLOSE', tag: 'AI_SETUP_TARGET' });
  });

  it('a jump straight through the last target closes at the target (no trail first); a single target closes at T1', () => {
    expect(filledStep({ ...base, setup: dabur(), watch: { sl: 419.5, trailed: false, worstFill: 425 }, ltp: 441 })).toMatchObject({ action: 'CLOSE', tag: 'AI_SETUP_TARGET' });
    expect(filledStep({ ...base, setup: dabur({ targets: [433.5] }), watch: { sl: 419.5, trailed: false, worstFill: 425 }, ltp: 433.5 })).toMatchObject({ action: 'CLOSE', tag: 'AI_SETUP_TARGET' });
  });

  it('validUntil or the session end closes AI_SETUP_TIME, even with no price', () => {
    const w = { sl: 419.5, trailed: false, worstFill: 425 };
    expect(filledStep({ ...base, now: VALID, setup: dabur(), watch: w, ltp: null })).toMatchObject({ action: 'CLOSE', tag: 'AI_SETUP_TIME' });
    expect(filledStep({ ...base, minutesToClose: 6, setup: dabur(), watch: w, ltp: 428 })).toMatchObject({ action: 'CLOSE', tag: 'AI_SETUP_TIME' });
  });

  it('no price → HOLD', () => {
    expect(filledStep({ ...base, setup: dabur(), watch: { sl: 419.5, trailed: false, worstFill: 425 }, ltp: null }).action).toBe('HOLD');
  });

  it('PE: SL above, targets below', () => {
    const s = dabur({ instrument: { kind: 'OPT', symbol: 'DABUR', strike: 420, optionType: 'PE', expiry: '2026-12-30' }, entry: { type: 'LIMIT_PULLBACK', low: 433, high: 434, trigger: null, level: null }, sl: 437, targets: [428, 424] });
    const w = { sl: 437, trailed: false, worstFill: 433 };
    expect(filledStep({ ...base, setup: s, watch: w, ltp: 437 }).action).toBe('CLOSE');
    expect(filledStep({ ...base, setup: s, watch: w, ltp: 427.9 })).toMatchObject({ action: 'TRAIL', sl: 433 });
    expect(filledStep({ ...base, setup: s, watch: w, ltp: 424 })).toMatchObject({ action: 'CLOSE', tag: 'AI_SETUP_TARGET' });
  });
});

describe('premiumFloorSl', () => {
  it('the premium at which 1 lot loses the class ceiling (the catastrophe floor), on the tick; never ≤ 0', () => {
    // 12.4 premium, lot 1250, ceiling ₹3,000 → 12.4 − 2.4 = 10.0
    expect(premiumFloorSl({ ltp: 12.4, ceiling: 3000, qty: 1250, valueFactor: 1, tick: 0.05 })).toBe(10);
    // A ceiling bigger than the whole premium: the smallest tick (no premium floor in practice).
    expect(premiumFloorSl({ ltp: 1.2, ceiling: 3000, qty: 1250, valueFactor: 1, tick: 0.05 })).toBe(0.05);
  });
});
