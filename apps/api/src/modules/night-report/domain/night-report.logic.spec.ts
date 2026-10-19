import { SessionClock } from '../../market-hub/session-clock';
import { MARKET_HOLIDAYS } from '../../market-data/services/market-holidays.service';
import {
  chartHref,
  isHeld,
  lastSessionDates,
  nightWindow,
  parseOvernightReason,
  pickVerdicts,
  planInForce,
  splitNews,
  symbolRef,
  underlyingName,
  underlyingRef,
  type HeldKey,
  type NewsRow,
  type VerdictRow,
} from './night-report.logic';

const clock = new SessionClock({ holidays: MARKET_HOLIDAYS });

describe('nightWindow', () => {
  it('spans Dussehra (Tue 2026-10-20): Monday close → Wednesday open, with a holiday note', () => {
    const now = new Date('2026-10-20T02:30:00Z'); // 08:00 IST on the holiday
    const w = nightWindow(now, clock);
    expect(w.from).toBe('2026-10-19T10:00:00.000Z'); // Mon 15:30 IST
    expect(w.to).toBe(now.toISOString());
    expect(w.nextOpen).toBe('2026-10-21T03:45:00.000Z'); // Wed 09:15 IST
    expect(w.holidayNote).toBe('Today is an NSE holiday (Dussehra)');
  });

  it('on the morning after the holiday the night still starts at Monday close', () => {
    const w = nightWindow(new Date('2026-10-21T02:30:00Z'), clock);
    expect(w.from).toBe('2026-10-19T10:00:00.000Z');
    expect(w.nextOpen).toBe('2026-10-21T03:45:00.000Z');
    expect(w.holidayNote).toBeNull();
  });

  it('the last two sessions skip the holiday and the weekend', () => {
    expect(lastSessionDates(new Date('2026-10-20T02:30:00Z'), clock, 2)).toEqual(['2026-10-19', '2026-10-16']);
    expect(lastSessionDates(new Date('2026-10-21T12:00:00Z'), clock, 2)).toEqual(['2026-10-21', '2026-10-19']);
  });
});

describe('chart links', () => {
  it('match the web buildChartHref format', () => {
    expect(chartHref('RELIANCE-EQ', '2885', 'NSE')).toBe('/charts?symbol=RELIANCE-EQ&token=2885&exchange=NSE');
    expect(chartHref('M&M', null, 'NSE')).toBe('/charts?symbol=M%26M&exchange=NSE');
    expect(symbolRef('GOLD', 'MCX', '')).toEqual({ symbol: 'GOLD', exchange: 'MCX', token: null, chartHref: '/charts?symbol=GOLD&exchange=MCX' });
  });

  it('resolves an option or future to its underlying', () => {
    expect(underlyingName('NIFTY27OCT2625000CE', 'NFO')).toBe('NIFTY');
    expect(underlyingName('CRUDEOIL19NOV26FUT', 'MCX')).toBe('CRUDEOIL');
    expect(underlyingName('RELIANCE-EQ', 'NSE')).toBeNull();
    expect(underlyingRef('NIFTY', 'NFO', null)).toMatchObject({ exchange: 'NSE', token: '99926000' });
    expect(underlyingRef('KEI', 'NFO', '13310')).toMatchObject({ symbol: 'KEI', exchange: 'NSE', token: '13310' });
    expect(underlyingRef('CRUDEOIL', 'MCX', null)).toMatchObject({ exchange: 'MCX', token: null });
  });
});

describe('verdicts', () => {
  const row = (over: Partial<VerdictRow>): VerdictRow => ({
    trackerId: 't1', verdict: 'HOLD', confidence: 'medium', reason: 'fine', invalidationPoint: null,
    triggeredBy: ['heartbeat'], createdAt: new Date('2026-10-19T09:00:00Z'), ...over,
  });

  it('splits the overnight reason like the web does', () => {
    expect(parseOvernightReason('OVERNIGHT RISK: gap down on results\nOPEN PLAN: exit\nbelow 500')).toEqual({
      risk: 'gap down on results', plan: 'exit below 500',
    });
    expect(parseOvernightReason('just text')).toEqual({ risk: 'just text', plan: null });
  });

  it('picks the latest of each window and ignores non-overnight values in overnight rows', () => {
    const p = pickVerdicts([
      row({ verdict: 'HOLD', createdAt: new Date('2026-10-19T08:00:00Z') }),
      row({ verdict: 'EXIT_ARMED', createdAt: new Date('2026-10-19T09:55:00Z'), reason: 'latest live' }),
      row({ verdict: 'HOLD_OVERNIGHT', triggeredBy: ['OVERNIGHT_REVIEW', 'window:OVERNIGHT_REVIEW:EQUITY:2026-10-16'], createdAt: new Date('2026-10-16T10:15:00Z') }),
      row({ verdict: 'EXIT_AT_OPEN', triggeredBy: ['OVERNIGHT_REVIEW', 'window:OVERNIGHT_REVIEW:EQUITY:2026-10-19'], createdAt: new Date('2026-10-19T10:15:00Z'),
        reason: 'OVERNIGHT RISK: results tonight\nOPEN PLAN: sell at open', invalidationPoint: ' 512 ' }),
      row({ verdict: 'ESCALATE', triggeredBy: ['OVERNIGHT_REVIEW'], createdAt: new Date('2026-10-19T11:00:00Z') }),
      row({ verdict: 'TIGHTEN_AT_OPEN', triggeredBy: ['PRE_OPEN_CHECK'], createdAt: new Date('2026-10-21T03:40:00Z') }),
    ]);
    expect(p.overnight).toMatchObject({ verdict: 'EXIT_AT_OPEN', window: 'OVERNIGHT_REVIEW', risk: 'results tonight', plan: 'sell at open', invalidation: '512' });
    expect(p.preOpen).toMatchObject({ verdict: 'TIGHTEN_AT_OPEN', window: 'PRE_OPEN_CHECK' });
    expect(p.live).toMatchObject({ verdict: 'EXIT_ARMED', window: 'LIVE', risk: 'latest live', plan: null });
    expect(planInForce(p)?.verdict).toBe('TIGHTEN_AT_OPEN');
  });

  it('matches AI_AUTO_EXIT_HOLD by symbol or tracker id', () => {
    expect(isHeld(['KEI27OCT26FUT'], { id: 'x', symbol: 'kei27oct26fut' })).toBe(true);
    expect(isHeld(['T9'], { id: 't9', symbol: 'A' })).toBe(true);
    expect(isHeld([], { id: 't9', symbol: 'A' })).toBe(false);
  });
});

describe('splitNews', () => {
  const art = (id: string, over: Partial<NewsRow>): NewsRow => ({
    id, title: id, summary: null, source: 'src', url: `https://x/${id}`, category: 'company', sentiment: null,
    sentimentScore: null, relatedSymbols: [], instruments: [], sectors: [], indices: [], markets: [],
    publishedAt: new Date('2026-10-19T12:00:00Z'), ...over,
  });
  const held: HeldKey[] = [
    { label: 'KEI', exchange: 'NFO', ref: symbolRef('KEI', 'NSE', '13310') },
    { label: 'NIFTY', exchange: 'NFO', ref: symbolRef('NIFTY', 'NSE', '99926000') },
  ];

  it('groups position news by underlying and keeps the rest as market news', () => {
    const r = splitNews(
      [
        art('a', { instruments: ['KEI'], publishedAt: new Date('2026-10-19T13:00:00Z') }),
        art('b', { relatedSymbols: ['KEI-EQ'] }), // legacy tag
        art('c', { indices: ['NIFTY'], instruments: ['KEI'] }), // both groups
        art('d', { markets: ['GLOBAL'] }),
        art('e', { instruments: ['TCS'] }), // neither
      ],
      held,
    );
    const kei = r.onPositions.find((g) => g.symbol.symbol === 'KEI')!;
    expect(kei.items.map((i) => i.id)).toEqual(['a', 'b', 'c']);
    expect(r.onPositions.find((g) => g.symbol.symbol === 'NIFTY')!.items.map((i) => i.id)).toEqual(['c']);
    expect(r.market.map((i) => i.id)).toEqual(['d']);
    expect(kei.items[0].symbols[0]).toEqual({ symbol: 'KEI', exchange: 'NSE', token: null, chartHref: '/charts?symbol=KEI&exchange=NSE' });
  });

  it('caps market news at the limit, newest first', () => {
    const rows = Array.from({ length: 25 }, (_, i) =>
      art(`m${i}`, { category: 'indian', publishedAt: new Date(Date.UTC(2026, 9, 19, 12, i)) }),
    );
    const r = splitNews(rows, []);
    expect(r.market).toHaveLength(20);
    expect(r.market[0].id).toBe('m24');
  });
});
