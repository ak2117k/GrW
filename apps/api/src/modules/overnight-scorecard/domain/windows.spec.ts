import { SessionClock } from '../../market-hub/session-clock';
import { MARKET_HOLIDAYS } from '../../market-data/services/market-holidays.service';
import { outcomeFor } from './outcome';
import { isOvernightCandidate, shapeOf } from './positions';
import { newsBatchDue, scorecardJobDue } from './windows';

const clock = new SessionClock({ holidays: MARKET_HOLIDAYS });
const ist = (s: string) => new Date(`${s}+05:30`);

describe('job windows across Dussehra (Tue 2026-10-20, NSE holiday)', () => {
  it('OVERNIGHT 15:40 runs Mon and Wed, not on the holiday or a weekend', () => {
    expect(scorecardJobDue('OVERNIGHT', ist('2026-10-19T15:40:00'), clock)).toBe(true);
    expect(scorecardJobDue('OVERNIGHT', ist('2026-10-20T15:40:00'), clock)).toBe(false);
    expect(scorecardJobDue('OVERNIGHT', ist('2026-10-21T15:40:00'), clock)).toBe(true);
    expect(scorecardJobDue('OVERNIGHT', ist('2026-10-24T15:40:00'), clock)).toBe(false);
    expect(scorecardJobDue('OVERNIGHT', ist('2026-10-19T15:10:00'), clock)).toBe(false); // before the close
  });

  it('PRE_OPEN 08:50 skips the holiday morning, runs Wed', () => {
    expect(scorecardJobDue('PRE_OPEN', ist('2026-10-20T08:50:00'), clock)).toBe(false);
    expect(scorecardJobDue('PRE_OPEN', ist('2026-10-21T08:50:00'), clock)).toBe(true);
    expect(scorecardJobDue('PRE_OPEN', ist('2026-10-21T09:30:00'), clock)).toBe(false);
  });

  it('news NIGHT 23:30 runs every night there is a next NSE session (weekends and holidays included)', () => {
    expect(newsBatchDue('NIGHT', ist('2026-10-19T23:30:00'), clock)).toBe(true); // Tue holiday: still analysed, for Wed
    expect(newsBatchDue('NIGHT', ist('2026-10-20T23:30:00'), clock)).toBe(true); // Wed opens
    expect(newsBatchDue('NIGHT', ist('2026-10-23T23:30:00'), clock)).toBe(true); // Fri night → Mon (every night)
    expect(newsBatchDue('NIGHT', ist('2026-10-24T23:30:00'), clock)).toBe(true); // Sat night → Mon
    expect(newsBatchDue('NIGHT', ist('2026-10-25T23:30:00'), clock)).toBe(true); // Sun night → Mon
  });

  it('news MORNING 08:40 only on a trading day', () => {
    expect(newsBatchDue('MORNING', ist('2026-10-20T08:40:00'), clock)).toBe(false);
    expect(newsBatchDue('MORNING', ist('2026-10-21T08:40:00'), clock)).toBe(true);
  });
});

describe('outcome filler', () => {
  const bars = [
    { day: '2026-10-19', open: 100, close: 101 },
    { day: '2026-10-21', open: 1250, close: 1275 },
  ];
  it('a Monday-after-close row is filled from Wednesday (the holiday is skipped), after Wednesday closes', () => {
    const at = ist('2026-10-19T15:40:00');
    expect(outcomeFor(at, bars, ist('2026-10-21T12:00:00'), clock)).toBeNull(); // not closed yet
    expect(outcomeFor(at, bars, ist('2026-10-21T18:30:00'), clock)).toEqual({ nextOpen: 1250, nextClose: 1275, moveBp: 200 });
  });
  it('missing bar ⇒ null (retried next run)', () => {
    expect(outcomeFor(ist('2026-10-21T15:40:00'), bars, ist('2026-10-22T18:30:00'), clock)).toBeNull();
  });
  it('a pre-open row is that same session', () => {
    expect(outcomeFor(ist('2026-10-21T08:50:00'), bars, ist('2026-10-21T18:30:00'), clock)?.moveBp).toBe(200);
  });
});

describe('positions', () => {
  const t = (over: Partial<Parameters<typeof isOvernightCandidate>[0]>) => ({
    id: 't', userId: 'u', symbol: 'RELIANCE28OCT261400CE', exchange: 'NFO', kind: 'POSITION', qty: 500, status: 'OPEN', ...over,
  });
  it('only OPEN broker POSITIONs on equity venues (no holdings, no MCX, no flat)', () => {
    expect(isOvernightCandidate(t({}))).toBe(true);
    expect(isOvernightCandidate(t({ symbol: 'TCS-EQ', exchange: 'NSE' }))).toBe(true);
    expect(isOvernightCandidate(t({ kind: 'HOLDING' }))).toBe(false);
    expect(isOvernightCandidate(t({ exchange: 'MCX', symbol: 'CRUDEOIL19NOV26FUT' }))).toBe(false);
    expect(isOvernightCandidate(t({ qty: 0 }))).toBe(false);
    expect(isOvernightCandidate(t({ status: 'CLOSED' }))).toBe(false);
  });
  it('side and shape: long CE bull, long PE bear, short PE bull, future, cash, index', () => {
    expect(shapeOf('RELIANCE28OCT261400CE', 'NFO', 500)).toMatchObject({ underlying: 'RELIANCE', side: 'BULLISH', isLongOption: true, expiry: '2026-10-28', isIndex: false });
    expect(shapeOf('NIFTY27OCT2625000PE', 'NFO', 75)).toMatchObject({ underlying: 'NIFTY', side: 'BEARISH', isLongOption: true, isIndex: true });
    expect(shapeOf('NIFTY27OCT2625000PE', 'NFO', -75)).toMatchObject({ side: 'BULLISH', isLongOption: false, isOption: true });
    expect(shapeOf('RELIANCE28OCT26FUT', 'NFO', -500)).toMatchObject({ side: 'BEARISH', isOption: false, expiry: '2026-10-28' });
    expect(shapeOf('TCS-EQ', 'NSE', 10)).toMatchObject({ underlying: 'TCS', side: 'BULLISH', isOption: false, expiry: null });
  });
});
