/**
 * Golden days for the desk manager (plan Task 8), at the decision level: the real reply parser, the real code
 * validation, the real per-trade ceiling maths and the real guard rule. The order plumbing under them has its
 * own specs (signal-executor, desk-actions, desk-exit-actions).
 */
import { parseDeskManagerConfig } from './desk-manager.config';
import { evaluateGuard } from './domain/desk-guard';
import type { ClosedTrade, DeskPacket } from './domain/desk.types';
import { validateDecision } from './domain/decision-validate';
import { parseManagerReply } from './domain/manager-schema';
import { dayPnlPath } from './domain/pnl-path';
import { ceilingFor, estimatePremiumLoss } from './domain/premium-risk';

const cfg = parseDeskManagerConfig({ DESK_MANAGER: 'live', HUB_OWNER_USER_ID: 'owner' });
const present = <T>(value: T, source = 'golden') => ({ status: 'present' as const, value, source });

/** 2026-11-26 ~09:35 IST: the BSE post is a reading the rules missed; BSE trades ~3890 above VWAP. */
function bseMorningPacket(): DeskPacket {
  return {
    at: '2026-11-26T04:05:00.000Z',
    mode: 'live',
    day: present({ ist: '2026-11-26 09:35', nseMinToClose: 355, mcxMinToClose: 830, liveFromIst: '09:30' }),
    pnl: present({ realised: 0, open: 0, total: 0, peak: 0, drawdownFromPeak: 0, lossStreak: 0, closed: [] }),
    guard: present({ blocked: false, reasons: [], path: dayPnlPath([], 0), pausedUntil: null, pauseScope: null }),
    positions: present([]),
    recentExits: present([]),
    proposals: present([
      {
        ref: 'reading:cmwx0lfkd2v0ylp01u045nj0j',
        kind: 'reading' as const,
        at: '2026-11-26T03:50:27.000Z',
        underlying: 'BSE',
        text: 'BSE CASH ABOVE 3860, support 3760, view 4000',
        detail: { kind: 'CALL', missedByRules: true, call: { side: 'BUY', underlying: 'BSE', entryLow: 3860, stopLoss: 3760, targets: [4000] } },
      },
    ]),
    instruments: present({
      BSE: { underlying: 'BSE', ltp: 3890, dayOpen: 3820, dayHigh: 3898, dayLow: 3808.9, vwap: 3884.4, trend15m: 'UP (15m close 3890 vs EMA20 3871, EMA rising)', levels: [3900, 3863, 3860, 3850], chainWalls: { call: 3900, put: 3850 }, missing: [] },
    }),
    health: present({ notCheckableToday: 0, notCheckableReasons: {}, feed: 'ok', agents: {}, failedBlocks: [] }),
    memory: present({ today: [], scorecard: null, lessons: [] }),
  };
}

/** What we expect a sound manager reply to look like on that morning: the channel's view, a stop inside the ceiling. */
const BSE_REPLY = JSON.stringify({
  summary: 'BSE: channel CALL above 3860 the rules missed; price 3890 holds above VWAP 3884 with a rising 15m trend.',
  decisions: [
    {
      action: 'OPEN', underlying: 'BSE', side: 'BUY_CE', strikePolicy: 'ATM', expiryPolicy: 'NEAREST',
      entry: { type: 'NOW', low: null, high: null, triggerAbove: null, triggerBelow: null, validMin: 30 },
      stop: { underlying: 3868 }, targets: { underlying: [3950, 4000] }, proposalRef: 'reading:cmwx0lfkd2v0ylp01u045nj0j', confidence: 'medium',
      reason: 'Channel view 4000 from 3860 is acting: price above VWAP and the 3860 trigger; stop 3868 (22 pts) keeps the lot inside the ₹3,000 stock-option ceiling.',
      evidence: ['ltp 3890', 'vwap 3884.4', 'trend15m UP', 'level 3863', 'target 4000 from the reading'],
    },
  ],
});

describe('golden: the 2026-11-26 BSE morning', () => {
  it('the reply parses, the OPEN (stop 3868, inside the ceiling) passes every code check', () => {
    const parsed = parseManagerReply(BSE_REPLY);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const [d] = parsed.reply.decisions;
    expect(d.action).toBe('OPEN');
    expect(validateDecision(d, bseMorningPacket())).toEqual([]);
  });

  it('the ₹3,000 stock-option ceiling on BSE (lot 200, ATM): a 22-pt stop fits, the 27-pt 3863 and the channel\'s 3760 are refused', () => {
    const ceiling = ceilingFor('BSE', 'NFO', 'BSE29DEC263900CE', cfg);
    expect(ceiling).toBe(3000);
    // prod 2026-11-27: BSE options lotSize 200; premium ~175 → spread estimate max(tick, 1%) = 1.75.
    const lot = { side: 'BUY_CE' as const, strikePolicy: 'ATM' as const, underlyingEntry: 3890, lotQty: 200, valueFactor: 1, delta: null, spread: 1.75 };
    expect(estimatePremiumLoss({ ...lot, underlyingStop: 3868 })).toBe(2550);
    expect(estimatePremiumLoss({ ...lot, underlyingStop: 3863 })).toBe(3050);
    expect(estimatePremiumLoss({ ...lot, underlyingStop: 3863 })).toBeGreaterThan(ceiling);
    expect(estimatePremiumLoss({ ...lot, underlyingStop: 3760 })).toBeGreaterThan(ceiling);
  });

  it('a reply without evidence is kept but rejected by code', () => {
    const parsed = parseManagerReply(BSE_REPLY.replace(/"evidence":\[[^\]]*\]/, '"evidence":[]'));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(validateDecision(parsed.reply.decisions[0], bseMorningPacket()).join(' ')).toMatch(/evidence/i);
  });
});

describe('golden: an 11-13-style day (losers in a row)', () => {
  const at = (h: number, m: number) => new Date(Date.UTC(2026, 10, 13, h - 5, m - 30));
  const t = (h: number, m: number, pnl: number, origin: ClosedTrade['origin']): ClosedTrade => ({ trackerId: `t${h}${m}`, symbol: 'X', underlying: 'NIFTY', exitAt: at(h, m), pnl, origin });

  it('two losers do not block; the third (a manual one) blocks the next automatic live entry', () => {
    const two = dayPnlPath([t(9, 50, -1800, 'signal'), t(10, 20, -2100, 'signal')], 0);
    expect(evaluateGuard(two, cfg.guard, { until: null, scope: null }, 'NIFTY', at(10, 25)).blocked).toBe(false);
    const three = dayPnlPath([t(9, 50, -1800, 'signal'), t(10, 20, -2100, 'signal'), t(10, 40, -900, 'manual')], 0);
    const g = evaluateGuard(three, cfg.guard, { until: null, scope: null }, 'NIFTY', at(10, 45));
    expect(g.blocked).toBe(true);
    expect(g.reasons.join(' ')).toMatch(/3 losers in a row/);
  });

  it('a green morning given back: ₹5,000 off the peak blocks even without a streak', () => {
    const path = dayPnlPath([t(9, 40, 6200, 'signal'), t(10, 30, -500, 'signal')], -700);
    expect(path.drawdownFromPeak).toBe(1200);
    const deep = dayPnlPath([t(9, 40, 6200, 'signal'), t(10, 30, 500, 'signal'), t(11, 0, -4000, 'manual')], -1800);
    expect(deep.drawdownFromPeak).toBeGreaterThanOrEqual(5000);
    expect(evaluateGuard(deep, cfg.guard, { until: null, scope: null }, null, at(11, 5)).blocked).toBe(true);
  });
});
