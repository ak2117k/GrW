import {
  exitNearTrigger,
  feedFresh,
  lastDueReviewSession,
  noiseFollowUpFilled,
  noiseReadPresent,
  oiCheckPresent,
  paperFillVsLtp,
  pnlArithmetic,
  selfReviewRan,
} from './checks';

const at = (iso: string) => new Date(iso);
const MIN = 60_000;

// Fixtures rebuilt from prod rows, 28–30 Oct 2026.
describe('paperFillVsLtp', () => {
  const base = { tradeId: 't', side: 'BUY', openedAt: at('2026-10-30T04:02:19Z') };

  it('flags the NIFTY FUT fill at the marketable limit (23169.07 vs LTP 23048)', () => {
    const f = paperFillVsLtp({ ...base, tradeId: 'cmvug4obs2powqm01k3x6f2oj', symbol: 'NIFTY23NOV26FUT', entryPrice: 23169.06942173134, planLtp: 23048 });
    expect(f).not.toBeNull();
    expect(f!.subjectId).toBe('cmvug4obs2powqm01k3x6f2oj');
    expect(f!.detail.offPct).toBeCloseTo(0.53, 2);
    expect(f!.message).toContain('NIFTY23NOV26FUT');
    expect(f!.message).toContain('23048');
  });

  it('passes the SENSEX fill after the fix (539.75 vs LTP 539.6, slippage model)', () => {
    expect(paperFillVsLtp({ ...base, symbol: 'SENSEX26N0574500CE', entryPrice: 539.7498350667818, planLtp: 539.6 })).toBeNull();
  });

  it('flags a SELL filled too far below the LTP, and skips rows without a price', () => {
    expect(paperFillVsLtp({ ...base, side: 'SELL', symbol: 'X', entryPrice: 99, planLtp: 100 })).not.toBeNull();
    expect(paperFillVsLtp({ ...base, symbol: 'X', entryPrice: null, planLtp: 100 })).toBeNull();
    expect(paperFillVsLtp({ ...base, symbol: 'X', entryPrice: 100, planLtp: null })).toBeNull();
  });
});

describe('pnlArithmetic', () => {
  const base = { tradeId: 't', exitAt: at('2026-10-30T04:16:34Z'), partialExits: 0 };

  it('passes the NIFTY FUT close: BUY 65 23169.07 → 23020, pnl −9690', () => {
    expect(pnlArithmetic({ ...base, symbol: 'NIFTY23NOV26FUT', side: 'BUY', quantity: 65, entryPrice: 23169.06942173134, exitPrice: 23020, pnl: -9689.51241253706 })).toBeNull();
  });

  it('flags the 28 Oct double-counted close (SENSEX 72800PE: 4779.92 vs 2551.46)', () => {
    const f = pnlArithmetic({ ...base, symbol: 'SENSEX26OCT72800PE', side: 'BUY', quantity: 20, entryPrice: 346.7770729951516, exitPrice: 474.35, pnl: 4779.918540096968 });
    expect(f).not.toBeNull();
    expect(f!.detail.expected).toBeCloseTo(2551.46, 1);
  });

  it('signs a SELL and skips partially exited trades (cumulative pnl over a shrunken qty)', () => {
    expect(pnlArithmetic({ ...base, symbol: 'X', side: 'SELL', quantity: 10, entryPrice: 100, exitPrice: 90, pnl: 100 })).toBeNull();
    expect(pnlArithmetic({ ...base, symbol: 'X', side: 'SELL', quantity: 10, entryPrice: 100, exitPrice: 90, pnl: -100 })).not.toBeNull();
    // WATCH cmszt6nmv031qf901d8qniqnu: 6 partial exits, qty 1, pnl 1087.43 — legit.
    expect(pnlArithmetic({ ...base, symbol: 'X', side: 'BUY', quantity: 1, entryPrice: 1070.25, exitPrice: 1077.05, pnl: 1087.43, partialExits: 6 })).toBeNull();
  });

  it('tolerates ₹1 of rounding', () => {
    expect(pnlArithmetic({ ...base, symbol: 'X', side: 'BUY', quantity: 10, entryPrice: 100, exitPrice: 101, pnl: 10.9 })).toBeNull();
  });
});

describe('exitNearTrigger', () => {
  const exitAt = at('2026-10-30T07:24:40Z');
  const base = { subjectId: 's', kind: 'paper' as const, exitAt, notes: null };

  it('passes an underlying-trigger option exit 10 min after the look (LAURUSLABS 57.6 → 52.7, −8.5 %)', () => {
    expect(exitNearTrigger({ ...base, symbol: 'LAURUSLABS23NOV262400CE', exitPrice: 52.7, lookLtp: 57.6, lookAt: new Date(exitAt.getTime() - 10 * MIN) })).toBeNull();
  });

  it('flags an option exit far from the last look', () => {
    const f = exitNearTrigger({ ...base, symbol: 'NIFTY27OCT2622300PE', exitPrice: 40, lookLtp: 72.5, lookAt: new Date(exitAt.getTime() - 1 * MIN) });
    expect(f).not.toBeNull();
    expect(f!.detail.anchorSource).toBe('last sentinel look');
  });

  it('holds a stock / future to 3 %, and penny options to the ₹2 floor', () => {
    expect(exitNearTrigger({ ...base, symbol: 'SAKAR-EQ', exitPrice: 967.4, lookLtp: 976.6, lookAt: new Date(exitAt.getTime() - 9 * MIN) })).toBeNull();
    expect(exitNearTrigger({ ...base, symbol: 'NIFTY23NOV26FUT', exitPrice: 22300, lookLtp: 23031, lookAt: new Date(exitAt.getTime() - 1 * MIN) })).not.toBeNull();
    // Real BHARTIARTL 1800PE: look 1.85, filled 0.85 — a rupee on a deep-OTM option.
    expect(exitNearTrigger({ ...base, kind: 'real', symbol: 'BHARTIARTL27OCT261800PE', exitPrice: 0.85, lookLtp: 1.85, lookAt: new Date(exitAt.getTime() - 1 * MIN) })).toBeNull();
  });

  it('judges a premium trigger against its crossing price', () => {
    const notes = 'AI trigger: AI trigger PREMIUM BELOW 147.43 crossed (147.41) | shadow: trail 12:12';
    expect(exitNearTrigger({ ...base, symbol: 'STEAMHOUSE-EQ', exitPrice: 147.41, notes, lookLtp: 147.6, lookAt: new Date(exitAt.getTime() - 9 * MIN) })).toBeNull();
    const f = exitNearTrigger({ ...base, symbol: 'STEAMHOUSE-EQ', exitPrice: 152, notes, lookLtp: 151, lookAt: new Date(exitAt.getTime() - 1 * MIN) });
    expect(f).not.toBeNull();
    expect(f!.detail.anchorSource).toBe('premium trigger crossing');
  });

  it('does not judge without a recent look', () => {
    expect(exitNearTrigger({ ...base, symbol: 'X26CE', exitPrice: 10, lookLtp: 100, lookAt: new Date(exitAt.getTime() - 45 * MIN) })).toBeNull();
    expect(exitNearTrigger({ ...base, symbol: 'X26CE', exitPrice: 10, lookLtp: null, lookAt: null })).toBeNull();
  });
});

describe('oiCheckPresent', () => {
  const openedAt = at('2026-10-30T11:58:11.127Z');
  const base = { decisionId: 'd', tradeId: 't', symbol: 'CRUDEOIL17NOV2610400CE', openedAt };

  it('passes when the check landed within 5 min', () => {
    expect(oiCheckPresent({ ...base, hasOiCheck: true, oiCheckAt: at('2026-10-30T11:58:11.135Z') }, at('2026-10-30T12:30:00Z'))).toBeNull();
  });

  it('waits out the 5 min, then flags a missing check', () => {
    expect(oiCheckPresent({ ...base, hasOiCheck: false, oiCheckAt: null }, new Date(openedAt.getTime() + 4 * MIN))).toBeNull();
    expect(oiCheckPresent({ ...base, hasOiCheck: false, oiCheckAt: null }, new Date(openedAt.getTime() + 6 * MIN))!.subjectId).toBe('d');
  });

  it('flags a late check; ignores opens before the feature shipped', () => {
    expect(oiCheckPresent({ ...base, hasOiCheck: true, oiCheckAt: new Date(openedAt.getTime() + 7 * MIN) }, at('2026-10-30T13:00:00Z'))).not.toBeNull();
    expect(oiCheckPresent({ ...base, openedAt: at('2026-10-30T04:02:19Z'), hasOiCheck: false, oiCheckAt: null }, at('2026-10-30T13:00:00Z'))).toBeNull();
  });
});

describe('noiseReadPresent', () => {
  const exitAt = at('2026-10-30T12:02:00.233Z');
  const base = { subjectId: 'cmvux4mmt0lzxmq014s5g0q0v', kind: 'paper' as const, symbol: 'CRUDEOIL17NOV2610400CE', exitAt };

  it('passes the 30 Oct CRUDEOIL read (written 4 s after the exit)', () => {
    expect(noiseReadPresent({ ...base, readAt: at('2026-10-30T12:02:04.468Z') }, at('2026-10-30T13:00:00Z'))).toBeNull();
  });

  it('flags a missing read after 5 min, not before; ignores exits before the feature shipped', () => {
    expect(noiseReadPresent({ ...base, readAt: null }, new Date(exitAt.getTime() + 3 * MIN))).toBeNull();
    expect(noiseReadPresent({ ...base, readAt: null }, new Date(exitAt.getTime() + 6 * MIN))).not.toBeNull();
    expect(noiseReadPresent({ ...base, exitAt: at('2026-10-30T08:29:35Z'), readAt: null }, at('2026-10-30T13:00:00Z'))).toBeNull();
  });
});

describe('feedFresh', () => {
  const now = at('2026-10-30T06:00:00Z');
  it('passes a fresh feed, flags a stale or empty one once per IST day', () => {
    expect(feedFresh({ feed: 'oi-nfo', label: 'NFO', lastAt: new Date(now.getTime() - 3 * MIN), dueNow: true }, now)).toBeNull();
    const f = feedFresh({ feed: 'oi-nfo', label: 'NFO', lastAt: new Date(now.getTime() - 12 * MIN), dueNow: true }, now);
    expect(f!.subjectId).toBe('oi-nfo:2026-10-30');
    expect(feedFresh({ feed: 'oi-nfo-fut', label: 'NFO fut', lastAt: null, dueNow: true }, now)!.message).toContain('none');
    expect(feedFresh({ feed: 'oi-nfo', label: 'NFO', lastAt: null, dueNow: false }, now)).toBeNull();
  });
});

describe('noiseFollowUpFilled', () => {
  const exitAt = at('2026-10-30T09:59:56Z');
  const base = { id: 'r', symbol: 'CRUDEOIL17NOV2610500CE', exitAt, after30m: null, venueOpenAt30m: true };
  it('flags an empty follow-up past 60 min while the venue traded, not before, not after its close', () => {
    expect(noiseFollowUpFilled(base, new Date(exitAt.getTime() + 50 * MIN))).toBeNull();
    expect(noiseFollowUpFilled(base, new Date(exitAt.getTime() + 70 * MIN))!.subjectId).toBe('noise-follow:r');
    // WIPRO-EQ exited 15:23 IST: +30 min is after the NSE close — no bar can exist.
    expect(noiseFollowUpFilled({ ...base, venueOpenAt30m: false }, new Date(exitAt.getTime() + 70 * MIN))).toBeNull();
    expect(noiseFollowUpFilled({ ...base, after30m: 9880 }, new Date(exitAt.getTime() + 70 * MIN))).toBeNull();
  });
});

describe('lastDueReviewSession / selfReviewRan', () => {
  const weekdays = (d: Date) => ![0, 6].includes(new Date(d.getTime() + 5.5 * 3_600_000).getUTCDay());

  it('picks the session whose 01:00 IST deadline passed last', () => {
    // Sat 31 Oct 01:30 IST → Fri 30 Oct, due Sat 01:00 IST.
    expect(lastDueReviewSession(at('2026-10-30T20:00:00Z'), weekdays)).toEqual({ session: '2026-10-30', deadline: at('2026-10-30T19:30:00Z') });
    // Sat 00:30 IST → Thu 29 Oct (Fri's deadline not passed yet).
    expect(lastDueReviewSession(at('2026-10-30T19:00:00Z'), weekdays)!.session).toBe('2026-10-29');
    // Mon 2 Nov 10:00 IST → Fri 30 Oct (weekend skipped).
    expect(lastDueReviewSession(at('2026-11-02T04:30:00Z'), weekdays)!.session).toBe('2026-10-30');
  });

  it('passes the 30 Oct run (DONE 18:45 IST), flags a missing or late one', () => {
    const r = { session: '2026-10-30', deadline: at('2026-10-30T19:30:00Z') };
    const now = at('2026-10-30T20:00:00Z');
    expect(selfReviewRan({ ...r, firstDoneAt: at('2026-10-30T13:15:00.048Z') }, now)).toBeNull();
    expect(selfReviewRan({ ...r, firstDoneAt: null }, now)!.subjectId).toBe('self-review:2026-10-30');
    expect(selfReviewRan({ ...r, firstDoneAt: at('2026-10-31T03:30:00Z') }, at('2026-10-31T04:00:00Z'))).not.toBeNull();
  });
});
