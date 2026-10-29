import { fundsCheck, isFundsRejection, requiredFunds } from './funds';
import { decisionIdFromTags, paperAlert, paperExitDecision, paperTags } from './paper';
import { judgeCallOf, liveSummary, paperByJudge, paperSummary } from './paper-summary';
import { parseSignalTraderConfig } from './signal-trader.config';

const cfg = { fundsBufferPct: 1, futMarginPct: 25 };

describe('requiredFunds', () => {
  it('option BUY = premium × qty + 1% charges', () => {
    const r = requiredFunds({ side: 'BUY', limitPrice: 100, qty: 150 }, { instrumentKind: 'CE', strike: 25000 }, cfg);
    expect(r).toMatchObject({ required: 15150, method: 'premium' });
  });
  it('futures = a conservative ESTIMATE (25% of notional) and says so', () => {
    const r = requiredFunds({ side: 'SELL', limitPrice: 25000, qty: 75 }, { instrumentKind: 'FUT', strike: null }, cfg);
    expect(r.method).toBe('estimate');
    expect(r.required).toBeCloseTo(25000 * 75 * 0.25 * 1.01, 2);
    expect(r.detail).toMatch(/ESTIMATE \(no broker margin API wired\)/);
  });
  it('option SELL estimates on the strike notional, cash on the full notional', () => {
    expect(requiredFunds({ side: 'SELL', limitPrice: 50, qty: 75 }, { instrumentKind: 'PE', strike: 24000 }, cfg).required).toBeCloseTo(24000 * 75 * 0.25 * 1.01, 2);
    expect(requiredFunds({ side: 'BUY', limitPrice: 1000, qty: 10 }, { instrumentKind: 'EQ', strike: null }, cfg)).toMatchObject({ required: 10100, method: 'notional' });
  });
  it('config: defaults and bounds', () => {
    expect(parseSignalTraderConfig({})).toMatchObject({ fundsBufferPct: 1, futMarginPct: 25 });
    const bad = parseSignalTraderConfig({ SIGNAL_FUT_MARGIN_PCT: '1' });
    expect(bad.futMarginPct).toBe(25);
    expect(bad.problems.join()).toMatch(/SIGNAL_FUT_MARGIN_PCT/);
  });
});

describe('fundsCheck', () => {
  const need = { required: 15150, method: 'premium' as const, detail: 'x' };
  it('records available / required / ok', () => {
    expect(fundsCheck(20000, need)).toMatchObject({ name: 'funds', ok: true, required: true, funds: { available: 20000, required: 15150, ok: true } });
    expect(fundsCheck(9000, need)).toMatchObject({ ok: false, required: true, funds: { available: 9000, ok: false } });
  });
  it('unreadable → unknown, NOT blocking (the order goes as before)', () => {
    const c = fundsCheck(null, need);
    expect(c).toMatchObject({ ok: null, required: false, funds: { available: null, ok: null } });
    expect(c.detail).toMatch(/unknown/);
  });
});

describe('isFundsRejection', () => {
  it.each([
    'Insufficient Funds',
    'RMS:Margin Exceeds,Required:85000.00, Available:12000.00 for entity account-XYZ',
    'insufficient margin available',
    'Margin shortfall',
  ])('funds: %s', (t) => expect(isFundsRejection(t)).toBe(true));
  it.each(['Price out of circuit limit', 'Invalid symbol token', '', null])('not funds: %s', (t) => expect(isFundsRejection(t)).toBe(false));
});

describe('paper exits', () => {
  const base = { side: 'BUY', sl: 90, target: 120, product: 'INTRADAY', minutesToClose: 100 };
  it('BUY: SL at the observed LTP, target at the target price, else hold', () => {
    expect(paperExitDecision({ ...base, ltp: 88 })).toMatchObject({ exit: true, tag: 'STOPPED_OUT', price: 88 });
    expect(paperExitDecision({ ...base, ltp: 121 })).toMatchObject({ exit: true, tag: 'HIT_TARGET', price: 120 });
    expect(paperExitDecision({ ...base, ltp: 105 })).toEqual({ exit: false });
    expect(paperExitDecision({ ...base, ltp: null })).toEqual({ exit: false });
  });
  it('SELL mirrors; INTRADAY squares off near the close', () => {
    expect(paperExitDecision({ ...base, side: 'SELL', sl: 110, target: 80, ltp: 111 })).toMatchObject({ tag: 'STOPPED_OUT' });
    expect(paperExitDecision({ ...base, side: 'SELL', sl: 110, target: 80, ltp: 79 })).toMatchObject({ tag: 'HIT_TARGET', price: 80 });
    expect(paperExitDecision({ ...base, ltp: 105, minutesToClose: 4 })).toMatchObject({ tag: 'TIME_EXIT', price: 105 });
    expect(paperExitDecision({ ...base, ltp: 105, minutesToClose: 4, product: 'CARRYFORWARD' })).toEqual({ exit: false });
  });
  it('tags carry the decision id; the alert reads as the owner asked', () => {
    expect(decisionIdFromTags(paperTags('dec9'))).toBe('dec9');
    expect(paperAlert({ required: 15150, available: 9000, what: 'BUY NIFTY 25000 CE', channel: 'Alpha', result: 'ok' })).toMatch(/^PAPER \(insufficient funds\): need ₹15,150, available ₹9,000 — BUY NIFTY 25000 CE/);
  });
});

describe('summaries', () => {
  it('paper vs live', () => {
    expect(paperSummary([{ status: 'CLOSED', pnl: 500 }, { status: 'CLOSED', pnl: -200 }, { status: 'OPEN', pnl: 50 }, null])).toMatchObject({ n: 4, closed: 2, open: 1, noTrade: 1, wins: 1, losses: 1, pnl: 350, realised: 300, winRate: 0.5 });
    expect(liveSummary([{ status: 'FILLED', trackerStatus: 'CLOSED', pnl: 100 }, { status: 'CANCELLED', trackerStatus: null, pnl: null }])).toMatchObject({ n: 2, closed: 1, wins: 1, noTrade: 1, realised: 100 });
  });

  it('paper P&L by the AI entry judge: TAKE / SKIP / NONE, gross from entry, exit and quantity (not the booked pnl)', () => {
    const tr = (side: string, entry: number, exit: number | null, qty: number, pnl: number | null = 999_999) => ({ status: exit === null ? 'OPEN' : 'CLOSED', side, quantity: qty, entryPrice: entry, exitPrice: exit, pnl });
    const s = paperByJudge([
      { aiDecision: 'TAKE', trade: tr('BUY', 100, 110, 10) },
      { aiDecision: 'TAKE', trade: tr('SELL', 100, 104, 5) },
      { aiDecision: 'TAKE', trade: tr('BUY', 100, null, 10, 30) },
      // ACUTAAS 2026-10-29 (AI SKIP): 3986.06 → 3958 × 25.
      { aiDecision: 'SKIP', trade: tr('BUY', 3986.06, 3958, 25) },
      { aiDecision: 'SKIP', trade: null },
      { aiDecision: 'NONE', trade: tr('BUY', 50, 50, 1) },
    ]);
    expect(s.TAKE).toEqual({ n: 3, closed: 2, open: 1, wins: 1, losses: 1, gross: 80, openMark: 30, winRate: 0.5 });
    expect(s.SKIP).toEqual({ n: 1, closed: 1, open: 0, wins: 0, losses: 1, gross: -701.5, openMark: 0, winRate: 0 });
    expect(s.NONE).toMatchObject({ n: 1, closed: 1, wins: 0, losses: 0, gross: 0, winRate: null });
  });

  it("the judge's call: learning mode's aiDecision, else a no-funds PAPER decision's verdict (only a TAKE gets there)", () => {
    expect(judgeCallOf({ verdict: 'TAKE', aiDecision: 'SKIP' })).toBe('SKIP');
    expect(judgeCallOf({ verdict: 'TAKE' })).toBe('TAKE');
    expect(judgeCallOf(null)).toBe('NONE');
  });
});
