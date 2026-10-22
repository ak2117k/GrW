import { scoreTradeSetup, type TradeSetupVerifyRow } from './scorers';

const row = (outcomeStatus: string, outcomeR: number | null, over: Partial<TradeSetupVerifyRow> = {}): TradeSetupVerifyRow => ({
  id: 's1', sessionDate: '2026-10-23', symbol: 'RELIANCE', side: 'LONG', instrument: 'RELIANCE27OCT26FUT (NFO futures, near month)',
  entryRef: 1400, stopDistance: 28, outcomeStatus, outcomeR, outcomeHitT1: outcomeStatus === 'TARGET1', outcomeEntryPrice: 1410, outcomeExitPrice: 1452, ...over,
});

describe('scoreTradeSetup (TRADE_SETUP)', () => {
  it('right when T1 came before the stop; score = R', () => {
    expect(scoreTradeSetup(row('TARGET1', 1.5))).toMatchObject({ kind: 'TRADE_SETUP', refId: 's1', correct: true, score: 1.5, subject: 'LONG', actual: 'hit T1 (+1.5R)' });
  });
  it('wrong on the stop or a 15:10 time exit without T1', () => {
    expect(scoreTradeSetup(row('STOP', -1))).toMatchObject({ correct: false, score: -1, actual: 'stopped out (-1R)' });
    expect(scoreTradeSetup(row('TIME_EXIT', 0.4))).toMatchObject({ correct: false, score: 0.4 });
  });
  it('null when the entry never triggered or there were no bars', () => {
    expect(scoreTradeSetup(row('NOT_TRIGGERED', null))).toMatchObject({ correct: null, score: null, actual: 'entry never triggered' });
    expect(scoreTradeSetup(row('NO_DATA', null))).toMatchObject({ correct: null, score: null });
  });
});
