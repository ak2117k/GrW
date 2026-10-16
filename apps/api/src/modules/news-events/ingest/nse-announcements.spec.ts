import { readFileSync } from 'fs';
import { join } from 'path';
import { announcementsDue, parseAnnouncements } from './nse-announcements';

const row = {
  symbol: 'TATAMOTORS', desc: 'Outcome of Board Meeting', attchmntFile: 'https://nsearchives.nseindia.com/corporate/a.pdf',
  sm_name: 'Tata Motors Limited', an_dt: '16-Oct-2026 10:05:12', sort_date: '2026-10-16 10:05:12',
  attchmntText: 'Tata Motors has informed the Exchange about the outcome of the board meeting',
};

it('maps a row to an article: title, summary, url, IST time, exchange symbol', () => {
  expect(parseAnnouncements([row])).toEqual([{
    symbol: 'TATAMOTORS',
    title: 'TATAMOTORS: Outcome of Board Meeting — Tata Motors has informed the Exchange about the outcome of the board meeting',
    summary: 'Tata Motors has informed the Exchange about the outcome of the board meeting',
    url: 'https://nsearchives.nseindia.com/corporate/a.pdf',
    publishedAt: new Date('2026-10-16T04:35:12.000Z'),
    dateInferred: false,
  }]);
});

it('accepts {data:[…]}, skips rows without a symbol, synthesises a stable url, flags a missing date', () => {
  const out = parseAnnouncements({ data: [{ ...row, attchmntFile: '', an_dt: '', sort_date: '' }, { desc: 'x' }] });
  expect(out).toHaveLength(1);
  expect(out[0].url).toMatch(/^https:\/\/www\.nseindia\.com\/companies-listing\/corporate-filings-announcements#TATAMOTORS-[0-9a-f]{12}$/);
  expect(out[0].dateInferred).toBe(true);
  expect(out[0].publishedAt).toBeNull();
  const again = parseAnnouncements({ data: [{ ...row, attchmntFile: '', an_dt: '', sort_date: '' }] });
  expect(again[0].url).toBe(out[0].url); // stable across polls ⇒ the url-unique dedupe holds
});

it('falls back to sort_date when an_dt is missing', () => {
  expect(parseAnnouncements([{ ...row, an_dt: '' }])[0]).toMatchObject({ publishedAt: new Date('2026-10-16T04:35:12.000Z'), dateInferred: false });
});

it('a non-array, non-{data} body is an error (counted as a failure, never "0 announcements")', () => {
  expect(() => parseAnnouncements('<html>')).toThrow(/not an announcements list/);
});

it('titles are capped at 300 chars', () => {
  expect(parseAnnouncements([{ ...row, attchmntText: 'x'.repeat(1000) }])[0].title.length).toBeLessThanOrEqual(300);
});

it('the M0 capture (real NSE rows) parses with times and symbols', () => {
  const rows = JSON.parse(readFileSync(join(__dirname, '..', '__fixtures__', 'nse-announcements.json'), 'utf8'));
  const out = parseAnnouncements(rows);
  expect(out.length).toBe(rows.length);
  for (const a of out) {
    expect(a.symbol).toMatch(/^[A-Z0-9&-]+$/);
    expect(a.dateInferred).toBe(false);
    expect(a.url).toMatch(/^https:\/\//);
  }
});

describe('announcementsDue (N3: 3 min 09:00–17:30 on NSE trading days, 15 min 07:00–22:00 otherwise)', () => {
  const ist = (hhmm: string, day = '2026-10-16') => new Date(`${day}T${hhmm}:00+05:30`);
  it.each([
    ['09:30', null, true, true],
    ['09:30', '09:28', true, false],
    ['09:30', '09:27', true, true],
    ['18:00', '17:50', true, false],
    ['18:00', '17:45', true, true],
    ['06:30', null, true, false],
    ['22:30', null, true, false],
    ['10:00', '09:50', false, false], // a holiday: 15-min cadence
    ['10:00', '09:45', false, true],
  ])('%s last=%s tradingDay=%s → %s', (now, last, trading, want) => {
    expect(announcementsDue(ist(now), last ? ist(last) : null, 3, trading as boolean)).toBe(want);
  });
});
