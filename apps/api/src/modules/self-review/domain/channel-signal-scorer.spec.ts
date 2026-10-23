import { scoreChannelSignal, type ChannelSignalVerifyRow } from './scorers';
import { channelStats } from './summary';

const row = (outcomeStatus: string, over: Partial<ChannelSignalVerifyRow> = {}): ChannelSignalVerifyRow => ({
  id: 'sig1', sessionDate: '2026-10-23', channelId: 'chA', underlying: 'NIFTY', instrumentKind: 'CE', strike: 24000, side: 'BUY',
  entryType: 'ABOVE', entryLow: 120, entryHigh: 120, sl: 100, targets: [140, 160], horizon: 'INTRADAY', parser: 'rule', outcomeStatus, ...over,
});

describe('scoreChannelSignal (CHANNEL_SIGNAL)', () => {
  it('target 1 before the SL → right (+1), subject = channel', () => {
    expect(scoreChannelSignal(row('TARGET1'))).toMatchObject({
      kind: 'CHANNEL_SIGNAL', refId: 'sig1', subject: 'chA', symbol: 'NIFTY', correct: true, score: 1,
      predicted: 'BUY NIFTY 24000 CE ABOVE 120 SL 100 T1 140', actual: 'target 1 before the SL',
    });
  });
  it('SL first → wrong (−1)', () => {
    expect(scoreChannelSignal(row('SL'))).toMatchObject({ correct: false, score: -1, actual: 'SL before target 1' });
  });
  it.each(['NEITHER', 'NOT_TRIGGERED', 'NO_DATA', 'NO_LEVELS', 'UNRESOLVED'])('%s → null', (status) => {
    expect(scoreChannelSignal(row(status))).toMatchObject({ correct: null, score: null });
  });
  it('a range entry / cash call reads cleanly', () => {
    expect(scoreChannelSignal(row('SL', { instrumentKind: 'EQ', strike: null, underlying: 'RELIANCE', entryType: 'RANGE', entryLow: 1250, entryHigh: 1255, sl: 1238, targets: [1270] })).predicted).toBe(
      'BUY RELIANCE EQ RANGE 1250-1255 SL 1238 T1 1270',
    );
  });
});

describe('channelStats', () => {
  it('session counts + rolling 20 per channel', () => {
    const today = [scoreChannelSignal(row('TARGET1')), scoreChannelSignal(row('SL', { id: 's2' })), scoreChannelSignal(row('NEITHER', { id: 's3', channelId: 'chB' }))];
    const history = [
      ...today.map((d) => ({ sessionDate: d.sessionDate, subject: d.subject, correct: d.correct })),
      { sessionDate: '2026-10-22', subject: 'chA', correct: true },
      { sessionDate: '2026-09-01', subject: 'chA', correct: false }, // outside the 20 sessions
    ];
    const s = channelStats(today, history, ['2026-10-23', '2026-10-22']);
    expect(s.chA).toEqual({ n: 2, right: 1, wrong: 1, hitRate: 0.5, rolling20: 0.667, rolling20Right: 2, rolling20Wrong: 1 });
    expect(s.chB).toMatchObject({ n: 1, hitRate: null, rolling20: null });
  });
});
