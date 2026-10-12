import { Prisma } from '@prisma/client';
import { isPaperPair, parsePaperValue, REQUIRED_PAPER_PAIRS, resolvePaperSettings, type PaperKey } from './paper-settings';
import { SEED_ROWS } from './testing/paper-fixtures';

const ok = (key: PaperKey, v: unknown) => parsePaperValue(key, v).ok;

describe('paper settings vocabulary (spec §4.5)', () => {
  it('knows each fixed pair, and any upper-case underlying for maxLotsPerOrder', () => {
    expect(isPaperPair('startingCapital', 'ALL')).toBe(true);
    expect(isPaperPair('startingCapital', 'MTF')).toBe(false);
    expect(isPaperPair('slippageBps', 'OPTIONS_BUY')).toBe(true);
    expect(isPaperPair('intradayLeverage', 'MTF')).toBe(false);
    expect(isPaperPair('maxLotsPerOrder', 'NIFTY')).toBe(true);
    expect(isPaperPair('maxLotsPerOrder', 'M&M')).toBe(true);
    expect(isPaperPair('maxLotsPerOrder', 'nifty')).toBe(false);
    expect(isPaperPair('maxLotsPerOrder', 'ALL')).toBe(false);
    expect(isPaperPair('maxLotsPerOrder', 'MTF')).toBe(false);
    expect(isPaperPair('nope', 'ALL')).toBe(false);
  });

  it('parses each key within its shape bounds', () => {
    expect(ok('startingCapital', 1000000)).toBe(true);
    expect(ok('startingCapital', 0)).toBe(false);
    expect(ok('startingCapital', -5)).toBe(false);
    expect(ok('startingCapital', '1.234')).toBe(false);
    expect(ok('startingCapital', 'abc')).toBe(false);
    expect(ok('startingCapital', null)).toBe(false);
    expect(ok('intradayLeverage', 1)).toBe(true);
    expect(ok('intradayLeverage', 0.5)).toBe(false);
    expect(ok('slippageBps', 0)).toBe(true);
    expect(ok('slippageBps', 10001)).toBe(false);
    expect(ok('noPriceRejectMs', 30000)).toBe(true);
    expect(ok('noPriceRejectMs', 999)).toBe(false);
    expect(ok('noPriceRejectMs', '1500.5')).toBe(false);
    expect(ok('mtfFundedShare', 0.5)).toBe(true);
    expect(ok('mtfFundedShare', 1)).toBe(false);
    expect(ok('mtfAnnualRatePct', 18)).toBe(true);
    expect(ok('mtfAnnualRatePct', 100.01)).toBe(false);
    expect(ok('mtfPledgeFee', '23.60')).toBe(true);
    expect(ok('maxLotsPerOrder', 10)).toBe(true);
    expect(ok('maxLotsPerOrder', 0)).toBe(false);
    expect(ok('maxLotsPerOrder', 2.5)).toBe(false);
  });

  it('resolves the seed rows', () => {
    const r = resolvePaperSettings(SEED_ROWS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.settings.startingCapital.toFixed(2)).toBe('1000000.00');
    expect(r.settings.intradayLeverage.toFixed(2)).toBe('5.00');
    expect(Object.fromEntries(Object.entries(r.settings.slippageBps).map(([v, d]) => [v, d.toFixed(2)]))).toEqual({ CASH_INTRADAY: '5.00', MTF: '5.00', OPTIONS_BUY: '50.00' });
    expect(r.settings.noPriceRejectMs).toBe(30000);
    expect(r.settings.mtfFundedShare.toFixed(2)).toBe('0.50');
    expect(r.settings.maxLotsPerOrder).toEqual({ NIFTY: 10, BANKNIFTY: 10, FINNIFTY: 10, MIDCPNIFTY: 10, SENSEX: 10 });
  });

  it('fails closed, naming every missing or malformed required pair', () => {
    const rows = SEED_ROWS.filter((r) => r.key !== 'mtfPledgeFee').map((r) => (r.key === 'intradayLeverage' ? { ...r, numValue: new Prisma.Decimal('0.5') } : r));
    expect(resolvePaperSettings(rows)).toEqual({ ok: false, missing: ['intradayLeverage@CASH_INTRADAY', 'mtfPledgeFee@MTF'] });
    expect(resolvePaperSettings([])).toEqual({ ok: false, missing: [...REQUIRED_PAPER_PAIRS] });
  });

  it('an underlying with no maxLotsPerOrder row does not block the rest (its orders are rejected one by one)', () => {
    const r = resolvePaperSettings(SEED_ROWS.filter((row) => row.key !== 'maxLotsPerOrder'));
    expect(r.ok && r.settings.maxLotsPerOrder).toEqual({});
  });
});
