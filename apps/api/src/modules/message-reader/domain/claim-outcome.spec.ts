import type { DailyBar } from '../../signal-intake/domain/info-outcome';
import type { Claim } from './reading.types';
import { evaluateClaim, marketContext, postSessionOf, scoreClaim, sectorRefOf, type ClaimScoreCtx, type IntradayBar } from './claim-outcome';

/** 30 NIFTY sessions ending 2026-11-25: every bar has a 100-point range (ATR14 = 100), closes flat at 26000. */
function niftyDays(last: Partial<DailyBar> = {}): DailyBar[] {
  const out: DailyBar[] = [];
  const start = new Date('2026-10-15T00:00:00Z');
  for (let i = 0; out.length < 29; i++) {
    const d = new Date(start.getTime() + i * 86_400_000);
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
    out.push({ day: d.toISOString().slice(0, 10), high: 26050, low: 25950, close: 26000 });
  }
  out.push({ day: '2026-11-25', high: 26150, low: 25950, close: 26000, ...last });
  return out;
}

const claim = (c: Partial<Claim>): Claim => ({
  text: 'x',
  subject: 'MARKET',
  bias: 'BULL',
  horizon: 'INTRADAY',
  verdict: 'NOT_CHECKABLE',
  evidence: [],
  claimType: 'DIRECTION',
  ...c,
});

const ctx = (c: Partial<ClaimScoreCtx> = {}): ClaimScoreCtx => ({
  niftyDaily: niftyDays(),
  subjectDaily: null,
  postSession: '2026-11-25',
  postClose: 26000,
  sessionClose: 26000,
  sessionRange: 50,
  medianRange20: 100,
  atr14: 100,
  adAtClose: 1.2,
  ...c,
});

describe('scoreClaim', () => {
  it('Stock Gainers 2026-11-25 RELATIVE_BREADTH is RIGHT when NIFTY +0.4% and A/D 0.8 at close', () => {
    const r = scoreClaim(claim({ claimType: 'RELATIVE_BREADTH', text: 'index strong, stocks weak', bias: 'NEUTRAL' }), ctx({ postClose: 26000, sessionClose: 26104, adAtClose: 0.8 }));
    expect(r.status).toBe('RIGHT');
    expect(r.why).toContain('A/D 0.8');
  });

  it('RELATIVE_BREADTH is WRONG when NIFTY rose but A/D ≥ 1 at close', () => {
    expect(scoreClaim(claim({ claimType: 'RELATIVE_BREADTH' }), ctx({ sessionClose: 26104, adAtClose: 1.3 })).status).toBe('WRONG');
  });

  it('RELATIVE_BREADTH is WRONG when NIFTY fell from the post to the close', () => {
    expect(scoreClaim(claim({ claimType: 'RELATIVE_BREADTH' }), ctx({ sessionClose: 25900, adAtClose: 0.6 })).status).toBe('WRONG');
  });

  it('RELATIVE_BREADTH is NOT_SCORED without the 15:25 A/D', () => {
    expect(scoreClaim(claim({ claimType: 'RELATIVE_BREADTH' }), ctx({ sessionClose: 26104, adAtClose: null })).status).toBe('NOT_SCORED');
  });

  it('CAUTION is RIGHT on a wide-range day', () => {
    const r = scoreClaim(claim({ claimType: 'CAUTION', bias: 'CAUTION' }), ctx({ sessionRange: 140, medianRange20: 100 }));
    expect(r.status).toBe('RIGHT');
  });

  it('CAUTION is RIGHT when NIFTY fell ≥ 0.3×ATR14 from the post to the close', () => {
    expect(scoreClaim(claim({ claimType: 'CAUTION' }), ctx({ sessionRange: 60, postClose: 26000, sessionClose: 25970 })).status).toBe('RIGHT');
  });

  it('CAUTION is WRONG on a narrow, flat day', () => {
    expect(scoreClaim(claim({ claimType: 'CAUTION' }), ctx({ sessionRange: 60, postClose: 26000, sessionClose: 25980 })).status).toBe('WRONG');
  });

  it('CAUTION is NOT_SCORED when neither check can be made', () => {
    expect(scoreClaim(claim({ claimType: 'CAUTION' }), ctx({ sessionRange: null, postClose: null })).status).toBe('NOT_SCORED');
  });

  it('MARKET BULL is RIGHT above +0.3×ATR14 close-to-close', () => {
    const r = scoreClaim(claim({ subject: 'MARKET', bias: 'BULL' }), ctx({ niftyDaily: niftyDays({ close: 26040 }) }));
    expect(r).toEqual({ status: 'RIGHT', why: expect.stringContaining('NIFTY +40') });
  });

  it('MARKET BEAR is WRONG when NIFTY closed up beyond the band', () => {
    expect(scoreClaim(claim({ subject: 'MARKET', bias: 'BEAR' }), ctx({ niftyDaily: niftyDays({ close: 26040 }) })).status).toBe('WRONG');
  });

  it('MARKET BULL inside the ±0.3×ATR14 band is NOT_SCORED flat', () => {
    const r = scoreClaim(claim({ subject: 'MARKET', bias: 'BULL' }), ctx({ niftyDaily: niftyDays({ close: 26020 }) }));
    expect(r.status).toBe('NOT_SCORED');
    expect(r.why).toContain('flat');
  });

  it('INSTRUMENT BULL uses the existing info scorer on the subject bars', () => {
    const r = scoreClaim(claim({ subject: 'RELIANCE', bias: 'BEAR' }), ctx({ subjectDaily: niftyDays({ close: 25950 }) }));
    expect(r.status).toBe('RIGHT');
    expect(r.why).toContain('RELIANCE');
  });

  it('missing bars are PENDING "data unavailable" (retried), reported NOT_SCORED by scoreClaim', () => {
    for (const [c, x] of [
      [claim({ subject: 'RELIANCE' }), ctx({ subjectDaily: [] })],
      [claim({ claimType: 'SECTOR', subject: 'IT' }), ctx({ subjectDaily: null })],
      [claim({ subject: 'MARKET' }), ctx({ niftyDaily: [] })],
      [claim({ claimType: 'CAUTION' }), ctx({ sessionRange: null, postClose: null })],
      [claim({ claimType: 'RELATIVE_BREADTH' }), ctx({ postClose: null, adAtClose: 0.8 })],
    ] as const) {
      expect(evaluateClaim(c, x)).toEqual({ status: 'PENDING', why: expect.stringContaining('data unavailable') });
      expect(scoreClaim(c, x).status).toBe('NOT_SCORED');
    }
  });

  it('a missing 15:25 A/D is NOT_SCORED at once (it never comes back)', () => {
    expect(evaluateClaim(claim({ claimType: 'RELATIVE_BREADTH' }), ctx({ adAtClose: null })).status).toBe('NOT_SCORED');
  });

  it('INSTRUMENT with no bars is NOT_SCORED', () => {
    expect(scoreClaim(claim({ subject: 'RELIANCE' }), ctx({ subjectDaily: null })).status).toBe('NOT_SCORED');
  });

  it('a DAYS claim whose third session is not in yet is NOT_SCORED pending', () => {
    const r = scoreClaim(claim({ subject: 'MARKET', horizon: 'DAYS' }), ctx());
    expect(r.status).toBe('NOT_SCORED');
    expect(r.why).toContain('pending');
  });

  it('a direction claim with no BULL/BEAR bias is NOT_SCORED', () => {
    expect(scoreClaim(claim({ bias: 'NEUTRAL' }), ctx()).status).toBe('NOT_SCORED');
  });

  it('SECTOR BULL is judged on the sector index close vs ±0.3×ATR14', () => {
    const r = scoreClaim(claim({ claimType: 'SECTOR', subject: 'IT', bias: 'BULL' }), ctx({ subjectDaily: niftyDays({ close: 26050 }) }));
    expect(r.status).toBe('RIGHT');
  });

  it('SECTOR with no sector index bars is NOT_SCORED', () => {
    expect(scoreClaim(claim({ claimType: 'SECTOR', subject: 'DEFENCE' }), ctx({ subjectDaily: null })).status).toBe('NOT_SCORED');
  });

  it.each(['GAP', 'OTHER'] as const)('%s is NOT_SCORED', (claimType) => {
    expect(scoreClaim(claim({ claimType, verdict: 'CONFIRMED' }), ctx())).toEqual({ status: 'NOT_SCORED', why: expect.stringContaining(claimType) });
  });

  it('FLOW is NOT_SCORED', () => {
    expect(scoreClaim(claim({ claimType: 'FLOW', subject: 'MARKET', bias: 'BULL' }), ctx()).status).toBe('NOT_SCORED');
  });
});

describe('postSessionOf', () => {
  const days = ['2026-11-20', '2026-11-23', '2026-11-24', '2026-11-25'];
  const at1830 = new Date('2026-11-25T13:00:00Z');

  it('a post during the session belongs to that session', () => {
    expect(postSessionOf(new Date('2026-11-25T05:00:00Z'), days, at1830)).toBe('2026-11-25');
  });

  it('a post after the close belongs to the next session', () => {
    expect(postSessionOf(new Date('2026-11-20T11:00:00Z'), days, at1830)).toBe('2026-11-23'); // Fri 16:30 IST → Mon
  });

  it('a weekend post belongs to the next session', () => {
    expect(postSessionOf(new Date('2026-11-22T04:00:00Z'), days, at1830)).toBe('2026-11-23'); // Sunday
  });

  it('null when the session is not in the bars yet (posted this evening)', () => {
    expect(postSessionOf(new Date('2026-11-25T11:00:00Z'), days, at1830)).toBeNull();
  });

  it('null while today’s session is still open', () => {
    expect(postSessionOf(new Date('2026-11-25T05:00:00Z'), days, new Date('2026-11-25T08:00:00Z'))).toBeNull();
  });
});

describe('marketContext', () => {
  const daily = niftyDays({ close: 26100 });
  // 2026-11-25 15m bars from 09:15 IST (03:45Z), 25 bars, each high/low ±10 around a rising close.
  const m15: IntradayBar[] = Array.from({ length: 25 }, (_, i) => {
    const close = 26000 + i * 4;
    return { ts: Date.parse('2026-11-25T03:45:00Z') + i * 900_000, open: close - 2, high: close + 10, low: close - 10, close };
  });

  it('in-session post: the last completed 15m close, rest-of-session range from the bar holding the post', () => {
    // 10:20 IST → completed bars 09:15..10:00 (4 bars, last close 26012); rest = bars from 10:15.
    const m = marketContext(daily, m15, new Date('2026-11-25T04:50:00Z'), '2026-11-25');
    expect(m.postClose).toBe(26012);
    expect(m.sessionClose).toBe(26100);
    expect(m.sessionRange).toBe(26096 + 10 - (26016 - 10));
    expect(m.atr14).toBe(100);
    expect(m.medianRange20).toBe(100);
  });

  it('a post inside the first 15 minutes uses the session open', () => {
    expect(marketContext(daily, m15, new Date('2026-11-25T03:50:00Z'), '2026-11-25').postClose).toBe(25998);
  });

  it('a pre-open post uses the previous close and the whole day range', () => {
    const m = marketContext(daily, m15, new Date('2026-11-25T02:00:00Z'), '2026-11-25');
    expect(m.postClose).toBe(26000);
    expect(m.sessionRange).toBe(200);
  });

  it('no 15m bars: an in-session post has no post level or range', () => {
    const m = marketContext(daily, [], new Date('2026-11-25T04:50:00Z'), '2026-11-25');
    expect(m.postClose).toBeNull();
    expect(m.sessionRange).toBeNull();
    expect(m.sessionClose).toBe(26100);
  });

  it('too few daily bars: no ATR14 / 20-day median', () => {
    const m = marketContext(daily.slice(-10), m15, new Date('2026-11-25T04:50:00Z'), '2026-11-25');
    expect(m.atr14).toBeNull();
    expect(m.medianRange20).toBeNull();
  });
});

describe('sectorRefOf', () => {
  it('maps reader sector names onto the NSE sector indices', () => {
    expect(sectorRefOf('IT')).toEqual({ exchange: 'NSE', token: '99926013' });
    expect(sectorRefOf('PSU BANK')).toEqual({ exchange: 'NSE', token: '99926033' });
    expect(sectorRefOf('BANKING')).toEqual({ exchange: 'NSE', token: '99926009' });
    expect(sectorRefOf('DEFENCE')).toBeNull();
  });
});
