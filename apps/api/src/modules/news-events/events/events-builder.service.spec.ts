import { EventsBuilderService } from './events-builder.service';
import { SourceHealthBook } from '../source-health';
import { parseNewsEventsConfig } from '../config';

function harness(over: { getJson?: jest.Mock; get?: jest.Mock } = {}) {
  const repo = { syncSource: jest.fn().mockResolvedValue({ upserted: 0, removed: 0 }), listFrom: jest.fn() };
  const nse = { getJson: over.getJson ?? jest.fn().mockResolvedValue([]) };
  const fundamentals = { get: over.get ?? jest.fn().mockResolvedValue({ nextEarningsDate: '2026-10-30' }) };
  const health = new SourceHealthBook();
  const svc = new EventsBuilderService(parseNewsEventsConfig({ NEWS_EVENTS_V2_ENABLED: 'observe' }), nse as never, repo as never, health, fundamentals as never);
  svc.loadFile = () => ({ version: 1, usFederalHolidays: [], eiaOverrides: [], macro: [] });
  return { svc, repo, nse, fundamentals, health };
}
const NOW = new Date('2026-10-16T02:00:00Z');
const sources = (repo: { syncSource: jest.Mock }) => repo.syncSource.mock.calls.map((c) => c[0]);

it('syncs config, EIA rules, NSE calendar, NSE corporate actions; Yahoo only for wanted symbols NSE has nothing for', async () => {
  const getJson = jest.fn()
    .mockResolvedValueOnce([{ symbol: 'TCS', purpose: 'Financial Results', date: '20-Oct-2026' }])
    .mockResolvedValueOnce([]);
  const { svc, repo, fundamentals } = harness({ getJson });
  await svc.build(NOW, ['TCS', 'INFY']);
  expect(sources(repo)).toEqual(['config/market-events.json', 'rule:eia', 'NSE event calendar', 'NSE corporate actions', 'yahoo (estimate)']);
  expect(fundamentals.get).toHaveBeenCalledTimes(1);
  expect(fundamentals.get).toHaveBeenCalledWith('INFY', 'NSE');
  expect(getJson.mock.calls[1][1]).toMatch(/from_date=16-10-2026&to_date=30-10-2026$/);
});

it('an NSE failure skips that source (stored rows kept), marks health, and the rest still syncs', async () => {
  const { svc, repo, health } = harness({ getJson: jest.fn().mockRejectedValue(new Error('NSE event-calendar: HTTP 403')) });
  await svc.build(NOW, []);
  expect(sources(repo)).toEqual(['config/market-events.json', 'rule:eia']);
  expect(health.all().filter((h) => h.source.startsWith('NSE')).map((h) => [h.source, h.consecutiveFailures])).toEqual([
    ['NSE event calendar', 1], ['NSE corporate actions', 1],
  ]);
});

it('an invalid macro file keeps the stored macro rows, still generates EIA, and reports it', async () => {
  const { svc, repo, health } = harness();
  svc.loadFile = () => { throw new Error('config/market-events.json is invalid: macro[0]: tz "X"'); };
  await svc.build(NOW, []);
  expect(sources(repo)).toEqual(['rule:eia', 'NSE event calendar', 'NSE corporate actions']);
  expect(health.all().find((h) => h.source === 'market-events.json')?.consecutiveFailures).toBe(1);
});
