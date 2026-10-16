import { allEventsAbsent, allNewsAbsent, eventsBlocks, newsBlocksV2, shadowSummary } from './news-events-blocks';
import type { EventsPeek, NewsPeek } from '../../news-events/types';

const AT = '2026-10-16T05:00:00.000Z';
const headline = (i: number, titleLen: number) => ({
  title: 'T'.repeat(titleLen), source: 'Economic Times Markets', sentiment: 'bearish', publishedAt: '2026-10-16T04:50:00.000Z',
  layer: (['instrument', 'sector', 'index', 'market'] as const)[i % 4], key: 'NIFTY PSU BANK', ageMin: 120 + i,
});
const event = (i: number, titleLen: number) => ({
  id: `e${i}`, kind: 'eia_petroleum', scope: 'commodity' as const, title: 'E'.repeat(titleLen), atIst: '2026-10-16 20:00 IST',
  minutesAway: 1000 + i, impact: 'high' as const, source: 'rule: EIA weekly petroleum status (Wed 10:30 ET)', allDay: false,
});
const news = (n: number, len: number, asOf = { lastIngestAt: AT, downSources: ['MoneyControl', 'Reuters Business'], stale: true }): NewsPeek => ({
  status: 'ok', headlines: Array.from({ length: n }, (_, i) => headline(i, len)), newestAt: AT, freshCount: 3,
  fresh: [], asOf,
});
const events = (n: number, len: number): EventsPeek => ({
  status: 'ok', events: Array.from({ length: n }, (_, i) => event(i, len)), minutesToNextHighImpact: 1000, noHighImpactReason: null,
  notes: ['macro schedule ends 2026-11-01'], fetchedAt: AT,
});
const tokens = (x: unknown) => Math.ceil(JSON.stringify(x).length / 4);

it('token budget (spec §12, plan "differs" 8): worst case ≤ 1,300, typical ≤ 700 (chars/4)', () => {
  const worst = tokens({ news: newsBlocksV2(news(8, 160), AT), events: eventsBlocks(events(5, 80), AT, 3) });
  const typical = tokens({ news: newsBlocksV2(news(5, 90, { lastIngestAt: AT, downSources: [], stale: false }), AT), events: eventsBlocks(events(2, 40), AT, 3) });
  // Recorded for the plan's report: worst/typical token estimates.
  expect({ worst: worst <= 1300, typical: typical <= 700 }).toEqual({ worst: true, typical: true });
});

it('stale ingestion and down sources are named — in the source when there are headlines, in the reason when there are none', () => {
  expect(newsBlocksV2(news(1, 20), AT).headlines).toMatchObject({ source: expect.stringMatching(/STALE: news as of 10:30 IST$/) });
  expect(newsBlocksV2(news(0, 20), AT).headlines).toEqual({
    available: false,
    reason: expect.stringMatching(/no headline .* last 6 hours — but news ingestion is stale \(last at 10:30 IST\) and these sources are down: MoneyControl, Reuters Business, so this may be a failure to see/),
  });
});

it('a healthy feed with no headline is a plain stated absence; freshCount stays a present 0 (we looked and saw none)', () => {
  const b = newsBlocksV2(news(0, 20, { lastIngestAt: AT, downSources: [], stale: false }), AT);
  expect(b.headlines).toEqual({ available: false, reason: 'no headline about this instrument, its sector, its index or the market was published in the last 6 hours' });
  expect(b.freshCount).toMatchObject({ available: true, value: 3 });
});

it('warming / unavailable / not wired: every block absent with the reason', () => {
  expect(newsBlocksV2({ status: 'warming', reason: 'loading' }, AT)).toEqual(allNewsAbsent('loading'));
  expect(newsBlocksV2(null, AT).freshCount).toEqual({ available: false, reason: 'the news index is not wired into this process' });
  expect(eventsBlocks({ status: 'unavailable', reason: 'down' }, AT, 3)).toEqual(allEventsAbsent('down'));
  expect(eventsBlocks(null, AT, 3).upcoming).toEqual({ available: false, reason: 'the events calendar is not wired into this process' });
});

it('events: the packet carries the seven fields only (no id, no allDay); at most what the peek gave', () => {
  const b = eventsBlocks(events(2, 10), AT, 3);
  expect(b.upcoming).toMatchObject({ available: true });
  const v = (b.upcoming as unknown as { value: Array<Record<string, unknown>> }).value;
  expect(Object.keys(v[0])).toEqual(['kind', 'scope', 'title', 'atIst', 'minutesAway', 'impact', 'source']);
  expect(b.upcoming).toMatchObject({ source: expect.stringMatching(/ — macro schedule ends 2026-11-01$/) });
});

it('events: none in the horizon is a stated absence naming the horizon and the notes', () => {
  expect(eventsBlocks({ status: 'ok', events: [], minutesToNextHighImpact: null, noHighImpactReason: 'no timed high-impact event in the next 3 trading days', notes: [], fetchedAt: null }, AT, 3)).toEqual({
    upcoming: { available: false, reason: 'no scheduled event relevant to this position in the next 3 trading days' },
    minutesToNextHighImpact: { available: false, reason: 'no timed high-impact event in the next 3 trading days' },
  });
});

it('shadowSummary is one short log line', () => {
  expect(shadowSummary({ news: newsBlocksV2(news(4, 20), AT), events: eventsBlocks(events(2, 20), AT, 3) })).toBe(
    'headlines=4 (instrument 1, sector 1, index 1, market 1) fresh=3 events=2 nextHigh=1000m stale=true down=[MoneyControl,Reuters Business]',
  );
});
