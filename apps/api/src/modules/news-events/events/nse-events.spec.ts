import { parseCorporateActions, parseEventCalendar, yahooEarningsEvent } from './nse-events';

it('event calendar: results vs board meeting, all-day at 09:15 IST, high impact, deduped', () => {
  const rows = [
    { symbol: 'INFY', purpose: 'Financial Results', bm_desc: 'approve results', date: '16-Oct-2026' },
    { symbol: 'INFY', purpose: 'Financial Results', bm_desc: 'approve results', date: '16-Oct-2026' },
    { symbol: 'TCS', purpose: 'Fund Raising', bm_desc: 'issue of NCDs', date: '20-Oct-2026' },
    { symbol: '', purpose: 'x', date: '20-Oct-2026' },
    { symbol: 'BAD', purpose: 'x', date: 'soon' },
  ];
  expect(parseEventCalendar({ data: rows })).toEqual([
    { scope: 'company', kind: 'results', key: 'INFY', title: 'INFY financial results: Financial Results', startsAt: new Date('2026-10-16T03:45:00.000Z'), allDay: true, impact: 'high', source: 'NSE event calendar', sourceRef: 'INFY|16-Oct-2026|Financial Results' },
    { scope: 'company', kind: 'board_meeting', key: 'TCS', title: 'TCS board meeting: Fund Raising', startsAt: new Date('2026-10-20T03:45:00.000Z'), allDay: true, impact: 'high', source: 'NSE event calendar', sourceRef: 'TCS|20-Oct-2026|Fund Raising' },
  ]);
});

it('corporate actions: ex-dividend / split / bonus by subject, medium impact', () => {
  expect(parseCorporateActions([
    { symbol: 'ITC', subject: 'Interim Dividend - Rs 6.50 Per Share', exDate: '22-Oct-2026' },
    { symbol: 'XYZ', subject: 'Face Value Split (Sub-Division) - From Rs 10/- To Rs 2/-', exDate: '23-Oct-2026' },
    { symbol: 'ABC', subject: 'Bonus 1:1', exDate: '24-Oct-2026' },
  ]).map((e) => `${e.key}:${e.kind}:${e.impact}`)).toEqual(['ITC:ex_dividend:medium', 'XYZ:split:medium', 'ABC:bonus:medium']);
});

it('a body that is not a list throws (a source failure, never "no events")', () => {
  expect(() => parseEventCalendar('<html>')).toThrow(/not a list/);
});

it('Yahoo estimate: labelled, high impact, only when the date parses', () => {
  expect(yahooEarningsEvent('INFY', '2026-10-30')).toMatchObject({ kind: 'results', key: 'INFY', source: 'yahoo (estimate)', impact: 'high', allDay: true, startsAt: new Date('2026-10-30T03:45:00.000Z') });
  expect(yahooEarningsEvent('INFY', undefined)).toBeNull();
  expect(yahooEarningsEvent('INFY', 'n/a')).toBeNull();
});
