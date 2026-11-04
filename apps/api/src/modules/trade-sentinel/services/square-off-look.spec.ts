import { hardRiskWindow, parseJudgeGateConfig } from './judge-gate';
import { squareOffLook, type SquareOffInput } from './square-off-look';

const cfg = parseJudgeGateConfig({});
/** 2026-10-29 at hh:mm:ss IST. */
const ist = (h: number, m: number, s = 0) => Date.UTC(2026, 9, 29, h, m, s) - 5.5 * 3_600_000;
/** NSE closes 15:30: whole minutes left from the current minute, as session-clock.ts counts. */
const mtcAt = (ms: number) => 15 * 60 + 30 - Math.floor((ms + 5.5 * 3_600_000) / 60_000) % 1440;

const input = (nowMs: number, over: Partial<SquareOffInput> = {}): SquareOffInput => ({
  cfg,
  segment: 'EQ_INTRADAY',
  kind: 'POSITION',
  exchange: 'NSE',
  minutesToClose: mtcAt(nowMs),
  expiryToday: false,
  nowMs,
  last: { verdict: 'HOLD', createdAt: new Date(ist(14, 44)) },
  ...over,
});
const verdictAt = (ms: number, verdict = 'HOLD') => ({ verdict, createdAt: new Date(ms) });

describe('squareOffLook — the deadline look (prod JPL-EQ 2026-10-29: no look between 14:44 and the 15:15 square-off)', () => {
  it('intraday cash: nothing before 15:05, then ONE first look framed against the 15:15 MIS square-off', () => {
    expect(squareOffLook(input(ist(15, 4, 59)))).toBeNull();
    const r = squareOffLook(input(ist(15, 5, 10)))!;
    expect(r.fire?.name).toBe('square-off-due');
    expect(r.fire?.detail).toContain('15:15 IST');
    expect(r.decision).toMatchObject({ deadline: 'BROKER_SQUARE_OFF', deadlineIst: '15:15', minutesLeft: 10, look: 'FIRST' });
    expect(r.decision.choice).toContain('square this intraday (MIS) position off at market at 15:15 IST');
  });

  it('once judged inside the window, no second first-look — the framing stays (IN_WINDOW)', () => {
    const r = squareOffLook(input(ist(15, 7), { last: verdictAt(ist(15, 5, 30)) }))!;
    expect(r.fire).toBeNull();
    expect(r.decision.look).toBe('IN_WINDOW');
    // The 15:05:00 opening is on the minute boundary: a verdict at 15:05:30 counts on every pass of that minute.
    expect(squareOffLook(input(ist(15, 5, 50), { last: verdictAt(ist(15, 5, 30)) }))!.fire).toBeNull();
  });

  it('one FINAL re-look in the last 5 minutes when the earlier verdict was not an exit — and only one', () => {
    expect(squareOffLook(input(ist(15, 9, 59), { last: verdictAt(ist(15, 5, 30)) }))!.fire).toBeNull();
    const fin = squareOffLook(input(ist(15, 10), { last: verdictAt(ist(15, 5, 30)) }))!;
    expect(fin.fire?.detail).toMatch(/^final look/);
    expect(fin.decision.look).toBe('FINAL');
    expect(squareOffLook(input(ist(15, 12), { last: verdictAt(ist(15, 10, 20)) }))!.fire).toBeNull();
  });

  it('no re-look after an exit verdict, after a late first look, past the deadline, or with SENTINEL_SQUARE_OFF_RELOOK_MIN=0', () => {
    expect(squareOffLook(input(ist(15, 10), { last: verdictAt(ist(15, 5, 30), 'EXIT_NOW') }))!.fire).toBeNull();
    expect(squareOffLook(input(ist(15, 10), { last: verdictAt(ist(15, 5, 30), 'EXIT_ARMED') }))!.fire).toBeNull();
    expect(squareOffLook(input(ist(15, 13), { last: verdictAt(ist(15, 11)) }))!.fire).toBeNull();
    expect(squareOffLook(input(ist(15, 16), { last: verdictAt(ist(15, 6)) }))!.fire).toBeNull();
    const noRelook = parseJudgeGateConfig({ SENTINEL_SQUARE_OFF_RELOOK_MIN: '0' });
    expect(squareOffLook(input(ist(15, 10), { cfg: noRelook, last: verdictAt(ist(15, 5, 30)) }))!.fire).toBeNull();
  });

  it('a position never judged (or first seen inside the window) gets the first look', () => {
    expect(squareOffLook(input(ist(15, 8), { last: null }))!.fire?.name).toBe('square-off-due');
  });

  it('F&O: the session-close guard (15:20 for NSE) and the 30-min expiry-day window', () => {
    const opt = { segment: 'OPT' as const, exchange: 'NFO' };
    expect(squareOffLook(input(ist(15, 19), opt))).toBeNull();
    const r = squareOffLook(input(ist(15, 20), opt))!;
    expect(r.decision).toMatchObject({ deadline: 'SESSION_CLOSE', deadlineIst: '15:30', minutesLeft: 10, look: 'FIRST' });
    expect(r.decision.choice).toContain('NFO close at 15:30 IST');
    expect(r.decision.choice).toContain('carry-forward one is held overnight');
    const exp = squareOffLook(input(ist(15, 0), { ...opt, expiryToday: true }))!;
    expect(exp.decision).toMatchObject({ deadline: 'EXPIRY_CLOSE', minutesLeft: 30, look: 'FIRST' });
    expect(exp.decision.choice).toContain('expires today');
    expect(squareOffLook(input(ist(15, 25), { ...opt, expiryToday: true, last: verdictAt(ist(15, 1)) }))!.decision.look).toBe('FINAL');
  });

  it('never for delivery, holdings, a closed session, or with SENTINEL_SQUARE_OFF_LOOK=false', () => {
    expect(squareOffLook(input(ist(15, 10), { segment: 'EQ_DELIVERY' }))).toBeNull();
    expect(squareOffLook(input(ist(15, 10), { kind: 'HOLDING' }))).toBeNull();
    expect(squareOffLook(input(ist(15, 10), { minutesToClose: null }))).toBeNull();
    expect(squareOffLook(input(ist(15, 10), { cfg: parseJudgeGateConfig({ SENTINEL_SQUARE_OFF_LOOK: 'false' }) }))).toBeNull();
  });
});

describe('squareOffLook — product type (prod 2026-11-04 LAURUSLABS 2600 CE NRML sold at 15:24 on "8 minutes to close")', () => {
  const opt = { segment: 'OPT' as const, exchange: 'NFO' };
  it('F&O CARRYFORWARD, non-expiry, 8 min to close → null (no fire, no framing)', () => {
    expect(squareOffLook(input(ist(15, 22), { ...opt, productType: 'CARRYFORWARD' }))).toBeNull();
    expect(squareOffLook(input(ist(15, 22), { ...opt, productType: 'NRML', last: null }))).toBeNull();
  });

  it('F&O CARRYFORWARD on expiry day → EXPIRY_CLOSE look as today', () => {
    const r = squareOffLook(input(ist(15, 0), { ...opt, productType: 'CARRYFORWARD', expiryToday: true }))!;
    expect(r.decision).toMatchObject({ deadline: 'EXPIRY_CLOSE', minutesLeft: 30, look: 'FIRST' });
    expect(r.fire?.name).toBe('square-off-due');
  });

  it('F&O INTRADAY → SESSION_CLOSE look as today (no carry window given); null product → as today', () => {
    for (const productType of ['INTRADAY', null]) {
      expect(squareOffLook(input(ist(15, 19), { ...opt, productType }))).toBeNull();
      const r = squareOffLook(input(ist(15, 20), { ...opt, productType }))!;
      expect(r.decision).toMatchObject({ deadline: 'SESSION_CLOSE', deadlineIst: '15:30', minutesLeft: 10, look: 'FIRST' });
      expect(r.decision.closeChoice).toBeUndefined();
    }
  });

  it('F&O INTRADAY with the carry window: ONE CARRY/EXIT look against the broker MIS square-off, no re-look', () => {
    const carry = { leadMin: 15, windowMin: 10 };
    expect(squareOffLook(input(ist(15, 4, 59), { ...opt, productType: 'INTRADAY', carry }))).toBeNull();
    const r = squareOffLook(input(ist(15, 5, 10), { ...opt, productType: 'INTRADAY', carry }))!;
    expect(r.fire?.name).toBe('square-off-due');
    expect(r.fire?.detail).toContain('close decision');
    expect(r.decision).toMatchObject({ deadline: 'BROKER_SQUARE_OFF', deadlineIst: '15:15', minutesLeft: 10, look: 'FIRST', closeChoice: 'CARRY_OR_EXIT' });
    expect(r.decision.choice).toContain('HOLD means CARRY');
    const later = squareOffLook(input(ist(15, 11), { ...opt, productType: 'INTRADAY', carry, last: verdictAt(ist(15, 6)) }))!;
    expect(later.fire).toBeNull();
    expect(later.decision.look).toBe('IN_WINDOW');
    // Past the square-off: no fire (the broker has closed it).
    expect(squareOffLook(input(ist(15, 16), { ...opt, productType: 'INTRADAY', carry, last: null }))!.fire).toBeNull();
  });

  it('carry window on expiry day or on a carry-forward position is ignored (expiry look / none)', () => {
    const carry = { leadMin: 15, windowMin: 10 };
    expect(squareOffLook(input(ist(15, 0), { ...opt, productType: 'INTRADAY', carry, expiryToday: true }))!.decision.deadline).toBe('EXPIRY_CLOSE');
    expect(squareOffLook(input(ist(15, 8), { ...opt, productType: 'CARRYFORWARD', carry }))).toBeNull();
  });
});

describe('hardRiskWindow — product type', () => {
  it('a carry-forward F&O position is outside the close window except on expiry day; null keeps today', () => {
    expect(hardRiskWindow(cfg, 'OPT', 8, false, 'CARRYFORWARD')).toBe(false);
    expect(hardRiskWindow(cfg, 'OPT', 8, true, 'CARRYFORWARD')).toBe(true);
    expect(hardRiskWindow(cfg, 'OPT', 8, false, 'INTRADAY')).toBe(true);
    expect(hardRiskWindow(cfg, 'OPT', 8, false, null)).toBe(true);
    expect(hardRiskWindow(cfg, 'OPT', 8, false)).toBe(true);
  });
});
