import { ENGINE_MIN_SAMPLE, engineDigest, engineGross, engineStats, type EngineDecisionRow, type EngineTradeRow } from './engine-trades';

const S = '2026-10-30';
const SESSIONS = [S, '2026-10-29'];
const at = (ymd: string, hhmm = '10:05') => new Date(`${ymd}T${hhmm}:00+05:30`);
const dec = (ymd: string, action: string, underlying = 'CRUDEOIL', tradeId: string | null = null): EngineDecisionRow => ({ at: at(ymd), underlying, action, mode: 'paper', tradeId, reasons: ['news: x', 'trend: y', 'oi: z'] });
const trade = (ymd: string, entry: number, exit: number | null, status = exit === null ? 'OPEN' : 'CLOSED'): EngineTradeRow => ({
  id: `${ymd}-${entry}`, createdAt: at(ymd), underlying: 'CRUDEOIL', symbol: 'CRUDEOIL17NOV269650PE', status, side: 'BUY', quantity: 100, entryPrice: entry, exitPrice: exit, exitReasonTag: exit ? 'AI_EXIT' : null,
});

describe('engine-trades (self-review)', () => {
  it('gross is side × (exit − entry) × qty of a CLOSED trade, null otherwise', () => {
    expect(engineGross(trade(S, 250, 280))).toBe(3000);
    expect(engineGross({ ...trade(S, 250, 280), side: 'SELL' })).toBe(-3000);
    expect(engineGross(trade(S, 250, null))).toBeNull();
  });

  it('session vs rolling-20 counts, by action and underlying; S lists its ENTER decisions and trades', () => {
    const s = engineStats(
      {
        decisions: [dec(S, 'ENTER_PE', 'CRUDEOIL', 't1'), dec(S, 'NO_TRADE', 'NIFTY'), dec('2026-10-29', 'ENTER_CE', 'NIFTY'), dec('2026-09-01', 'ENTER_CE')],
        trades: [trade(S, 250, 280), trade('2026-10-29', 100, 80), trade(S, 90, null)],
      },
      SESSIONS,
    );
    expect(s.session).toMatchObject({ decisions: 2, enters: 1, byAction: { ENTER_PE: 1, NO_TRADE: 1 }, trades: 2, closed: 1, wins: 1, gross: 3000 });
    expect(s.session.byUnderlying.NIFTY).toEqual({ decisions: 1, enters: 0 });
    expect(s.session.enterList).toEqual([expect.objectContaining({ underlying: 'CRUDEOIL', action: 'ENTER_PE', traded: true })]);
    expect(s.rolling20).toMatchObject({ decisions: 3, enters: 2, trades: 3, closed: 2, wins: 1, losses: 1, winRate: 0.5, gross: 1000 });
  });

  it('the digest says the sample is not enough under the minimum, and is null with no decisions', () => {
    const d = engineDigest(engineStats({ decisions: [dec(S, 'ENTER_PE')], trades: [trade(S, 250, 280)] }, SESSIONS));
    expect(d).toMatchObject({ sampleOk: false, rolling20: { closed: 1 } });
    expect(d?.basis).toMatch(new RegExp(`under ${ENGINE_MIN_SAMPLE} closed trades = insufficient sample`));
    expect(engineDigest(engineStats({ decisions: [], trades: [] }, SESSIONS))).toBeNull();
    expect(engineDigest(undefined)).toBeNull();
  });
});
