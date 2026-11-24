import { BANKNIFTY_23NOV_1M, BANKNIFTY_REF, ist } from '../market-hub/testing/banknifty-2026-11-23-preopen';
import { MemoryCandleRepo } from '../market-hub/testing/memory-candle-repo';
import type { InstrumentRef } from '../market-hub/hub.types';
import { firstSessionBars, IntradayCarryScoreService } from './intraday-carry-score.service';

const toBar = (b: { ts: number; open: number; high: number; low: number; close: number }) => ({ ts: b.ts, open: b.open, high: b.high, low: b.low, close: b.close });

describe('firstSessionBars: session bars only (2026-11-24)', () => {
  it('BANKNIFTY 23-Nov: the first bar is the 09:15 open, not the 08:50 flat copy; no pre-open range', () => {
    const s = firstSessionBars(BANKNIFTY_23NOV_1M.map(toBar), '2026-11-20', 'NSE');
    expect(s.ymd).toBe('2026-11-23');
    expect(s.bars[0]).toMatchObject({ ts: ist('2026-11-23 09:15'), open: 65003.7 });
    expect(Math.max(...s.bars.map((b) => b.high))).toBe(65182.45);
  });

  it('a day with only off-session copies is skipped; no exchange = every bar (as before)', () => {
    const copy = { ts: ist('2026-11-21 02:00'), open: 1, high: 1, low: 1, close: 1 };
    expect(firstSessionBars([copy, ...BANKNIFTY_23NOV_1M.map(toBar)], '2026-11-20', 'NSE').ymd).toBe('2026-11-23');
    expect(firstSessionBars([copy], '2026-11-20').ymd).toBe('2026-11-21');
  });
});

describe('IntradayCarryScoreService reads session minutes (gapPct from the real open)', () => {
  it('scores a CARRY decided 20-Nov 15:10 on the 23-Nov 09:15 open, not the 02:00 / pre-open copies', async () => {
    const candles = new MemoryCandleRepo();
    const ref = BANKNIFTY_REF as unknown as InstrumentRef;
    await candles.upsert('1m', ref, [{ ts: ist('2026-11-23 02:00'), open: 64635.2, high: 64635.2, low: 64635.2, close: 64635.2, volume: 0 }, ...BANKNIFTY_23NOV_1M], 'tick');
    const row = {
      id: 'r1', userId: 'u', mode: 'live', trackerId: 't', tradeId: null, istDay: '2026-11-20', symbol: 'Nifty Bank', exchange: 'NSE', token: '99926009',
      productType: 'MIS', positionSide: 'LONG', qty: 30, decision: 'CARRY', reason: '', verdictId: null, facts: {}, decisionPrice: 64635.2,
      conversionStatus: null, conversionAttempts: 0, brokerMessage: null, decidedAt: new Date(ist('2026-11-20 15:10')),
    };
    const repo = { dueForScoring: jest.fn().mockResolvedValue([row]), update: jest.fn().mockResolvedValue(undefined), scoredSince: jest.fn().mockResolvedValue([]) };
    const moduleRef = { get: () => null };
    const svc = new IntradayCarryScoreService(repo as never, candles, moduleRef as never);
    const out = await svc.runOnce(new Date(ist('2026-11-23 10:20')));
    expect(out.scored).toBe(1);
    const patch = repo.update.mock.calls[0][1];
    expect(patch.gapPct).toBeCloseTo(((65003.7 - 64635.2) / 64635.2) * 100, 2); // 0.57 %, was 0 off the 02:00 copy
    expect(patch.maxAfter).toBe(65182.45); // not the pre-open 65,489.6
    expect(patch.scoreNote).toMatch(/^candles_1m, 15 bars/);
  });
});
