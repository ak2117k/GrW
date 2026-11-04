import { afterConversion, closeDecisionOf, decideClose, type CloseFacts } from './carry-decision';
import { parseCarryConfig } from './carry-config';

const cfg = parseCarryConfig({});
const facts = (over: Partial<CloseFacts> = {}): CloseFacts => ({
  mode: 'live',
  userAllowed: true,
  productType: 'INTRADAY',
  expiryToday: false,
  held: false,
  minutesLeft: 8,
  verdict: { verdict: 'HOLD', reason: 'trend intact, 19 days to expiry' },
  capExhausted: false,
  ...over,
});

describe('decideClose — the intraday close decision (spec 2026-11-04 §5.3)', () => {
  it('judge HOLD → CARRY; EXIT_NOW / EXIT_ARMED / ESCALATE → EXIT, with the judge reason', () => {
    expect(decideClose(facts(), cfg)).toMatchObject({ action: 'CARRY', reason: 'judge HOLD: trend intact, 19 days to expiry' });
    for (const v of ['EXIT_NOW', 'EXIT_ARMED', 'ESCALATE']) {
      expect(decideClose(facts({ verdict: { verdict: v, reason: 'r' } }), cfg).action).toBe('EXIT');
    }
    expect(closeDecisionOf('hold')).toBe('CARRY');
  });

  it('expiry today → EXIT, never CARRY (D6)', () => {
    const o = decideClose(facts({ expiryToday: true }), cfg);
    expect(o.action).toBe('EXIT');
    expect(o.reason).toMatch(/^EXPIRY_DAY/);
  });

  it('held → NONE, logged (D7: no conversion, no exit)', () => {
    const o = decideClose(facts({ held: true }), cfg);
    expect(o.action).toBe('NONE');
    expect(o.reason).toMatch(/^OWNER_HOLD/);
  });

  it('user not allowed → paper-only (a live position is left alone; paper still decides)', () => {
    const o = decideClose(facts({ userAllowed: false }), cfg);
    expect(o.action).toBe('NONE');
    expect(o.reason).toMatch(/paper-only/);
    expect(decideClose(facts({ mode: 'paper', userAllowed: false }), cfg).action).toBe('CARRY');
  });

  it('no judgement yet: WAIT until DECIDE_BY_MIN, then EXIT (never a silent broker square-off)', () => {
    expect(decideClose(facts({ verdict: null, minutesLeft: 7 }), cfg).action).toBe('WAIT');
    const o = decideClose(facts({ verdict: null, minutesLeft: 6 }), cfg);
    expect(o.action).toBe('EXIT');
    expect(o.reason).toMatch(/^NO_JUDGEMENT/);
  });

  it('cap exhausted + EXIT → CAP_BLOCKED_BROKER_SQUARE_OFF; a CARRY still runs (D11); paper has no cap', () => {
    const exitNow = { verdict: 'EXIT_NOW', reason: 'r' };
    expect(decideClose(facts({ capExhausted: true, verdict: exitNow }), cfg).action).toBe('CAP_BLOCKED_BROKER_SQUARE_OFF');
    expect(decideClose(facts({ capExhausted: true }), cfg).action).toBe('CARRY');
    expect(decideClose(facts({ mode: 'paper', capExhausted: true, verdict: exitNow }), cfg).action).toBe('EXIT');
  });

  it('not INTRADAY, or past the square-off → NONE', () => {
    expect(decideClose(facts({ productType: 'CARRYFORWARD' }), cfg).action).toBe('NONE');
    expect(decideClose(facts({ productType: null }), cfg).action).toBe('NONE');
    expect(decideClose(facts({ minutesLeft: 0 }), cfg).action).toBe('NONE');
  });
});

describe('afterConversion — verify, retry once, exit before the deadline (D4)', () => {
  const base = { minutesLeft: 8, attempts: 1, mode: 'live' as const, capExhausted: false };

  it('CONVERTED → DONE; POSITION_GONE → GONE', () => {
    expect(afterConversion({ ...base, check: 'CONVERTED' }, cfg)).toBe('DONE');
    expect(afterConversion({ ...base, check: 'POSITION_GONE' }, cfg)).toBe('GONE');
  });

  it('NOT_CONVERTED: one retry, then re-check the book', () => {
    expect(afterConversion({ ...base, check: 'NOT_CONVERTED' }, cfg)).toBe('RETRY');
    expect(afterConversion({ ...base, check: 'NOT_CONVERTED', attempts: 2 }, cfg)).toBe('RECHECK');
  });

  it('CARRY + NOT_CONVERTED at deadline-3m → EXIT', () => {
    expect(afterConversion({ ...base, check: 'NOT_CONVERTED', minutesLeft: 3 }, cfg)).toBe('EXIT');
    expect(afterConversion({ ...base, check: 'NOT_CONVERTED', minutesLeft: 3, attempts: 2 }, cfg)).toBe('EXIT');
  });

  it('cap exhausted + that EXIT → CAP_BLOCKED_BROKER_SQUARE_OFF', () => {
    expect(afterConversion({ ...base, check: 'NOT_CONVERTED', minutesLeft: 2, capExhausted: true }, cfg)).toBe('CAP_BLOCKED_BROKER_SQUARE_OFF');
  });
});

describe('parseCarryConfig', () => {
  it('defaults: live, nobody live, NFO/BFO 15 min and MCX 30 min lead, window 10, decide-by 6, safety 3', () => {
    expect(cfg).toMatchObject({
      mode: 'live', users: [], leadMin: { NFO: 15, BFO: 15, MCX: 30 }, windowMin: 10, decideByMin: 6, safetyMin: 3, retrySec: 30, problems: [],
    });
  });

  it('off, users, per-exchange leads; junk reported and ignored', () => {
    const c = parseCarryConfig({ INTRADAY_CARRY: 'off', INTRADAY_CARRY_USERS: 'u1, u2,,u1', INTRADAY_CARRY_SQUARE_OFF_LEAD_MIN: 'MCX:35,NSE:5,NFO:x' });
    expect(c.mode).toBe('off');
    expect(c.users).toEqual(['u1', 'u2']);
    expect(c.leadMin).toEqual({ NFO: 15, BFO: 15, MCX: 35 });
    expect(c.problems).toHaveLength(2);
    expect(parseCarryConfig({ INTRADAY_CARRY: 'maybe' }).mode).toBe('live');
  });
});
