import { readFileSync } from 'fs';
import { join } from 'path';
import { parseYahooChart } from '../domain/global-chart';
import type { PreOpenOutlook } from '../domain/outlook';
import { PreOpenOutlookService } from './pre-open-outlook.service';

const chart = parseYahooChart(JSON.parse(readFileSync(join(__dirname, '..', '__fixtures__', 'yahoo-clf-1h-2026-11-02.json'), 'utf8')), 'CL=F');
// The live read at 08:30 would carry the 08:30 quote; the fixture's meta is the later fetch, so drop it.
const at0830 = { ...chart, price: null, priceAt: null };
const NOW = new Date('2026-11-02T03:00:00Z'); // 08:30 IST Monday

function make(o: { live?: boolean; stored?: boolean; nseOpen?: boolean; stale?: PreOpenOutlook[] } = {}) {
  const repo = {
    nearestFuture: jest.fn(async () => ({ exchange: 'MCX', token: '573422', symbol: 'CRUDEOIL19NOV26FUT' })),
    lastBarBefore: jest.fn(async (exchange: string) => (exchange === 'MCX' ? { price: 9917, at: new Date('2026-10-30T18:24:00Z') } : { price: 25_000, at: new Date('2026-10-30T09:59:00Z') })),
    latestChart: jest.fn(async () => (o.stored ? at0830 : null)),
    clustersBetween: jest.fn(async () => [{ id: 'k1', headline: 'Oil slips more than 1% as talks continue on ending Iran war', firstSeen: new Date('2026-11-02T02:30:00Z') }]),
    insertOutlook: jest.fn(async () => 'id'),
    latestOutlooks: jest.fn(async () => o.stale ?? []),
    lastVixClose: jest.fn(async () => ({ close: 15.87, at: new Date('2026-10-30T09:59:00Z') })),
  };
  const impacts = { impacts: jest.fn(async () => []) };
  const prices = { chart: jest.fn(async (symbol: string) => (o.live !== false && symbol === 'CL=F' ? { ok: true as const, chart: at0830, source: 'Yahoo chart CL=F' } : { ok: false as const, reason: 'HTTP 503', source: `Yahoo chart ${symbol}` })) };
  const clock = { isTradingDay: jest.fn((ex: string) => (ex === 'NSE' ? o.nseOpen ?? false : true)) };
  const svc = new PreOpenOutlookService(repo as never, impacts as never, prices as never, clock, undefined);
  return { svc, repo, prices, clock };
}

describe('PreOpenOutlookService', () => {
  const env = { ...process.env };
  beforeEach(() => {
    delete process.env.TELEGRAM_ALERT_BOT_TOKEN;
    delete process.env.TELEGRAM_ALERT_CHAT_ID;
  });
  afterAll(() => {
    process.env = { ...env };
  });

  it('08:30 run: CRUDEOIL BEARISH from WTI −3.21 % (gap ≈ −318 off 9917), stored; NSE holiday → indices skipped; alert no-ops unconfigured', async () => {
    const { svc, repo } = make();
    const r = await svc.run(NOW);
    expect(r.outlooks).toHaveLength(1);
    const o = r.outlooks[0];
    expect(o).toMatchObject({ underlying: 'CRUDEOIL', sessionDate: '2026-11-02', bias: 'BEARISH', confidence: 0.75, gap: { pct: -3.21, points: -318 } });
    expect(o.lastClose).toEqual({ price: 9917, at: '2026-10-30T18:25:00.000Z' });
    expect(o.headlineMoves.n).toBe(1);
    expect(repo.insertOutlook).toHaveBeenCalledTimes(1);
    expect(r.skipped.map((s) => s.underlying)).toEqual(['NIFTY', 'BANKNIFTY']);
    expect(r.alerted).toBe(false);
  });

  it('live fetch fails → the stored snapshot serves; both fail → NO_DATA and the weak headline-only read (capped confidence)', async () => {
    const a = await make({ live: false, stored: true }).svc.compute('CRUDEOIL', NOW, true);
    expect(a.global).toMatchObject({ status: 'OK', movePct: -3.21, source: 'global_price_snapshots CL=F' });
    const b = await make({ live: false, stored: false }).svc.compute('CRUDEOIL', NOW, true);
    expect(b.global?.status).toBe('NO_DATA');
    expect(b.gap?.basis).toBe('HEADLINES');
    expect(b.confidence).toBeLessThanOrEqual(0.5);
  });

  it('indices without GIFT (market-cues absent) fall back to ES=F; NO_DATA when that fails too', async () => {
    const { svc } = make({ nseOpen: true, live: false });
    const o = await svc.compute('NIFTY', NOW, true);
    expect(o.global?.status).toBe('NO_DATA');
    expect(o.bias).toBe('NEUTRAL');
  });

  it('night report: fresh stored rows as-is; otherwise a preview from DB data with NO live fetch', async () => {
    const stored = { underlying: 'CRUDEOIL', at: NOW.toISOString() } as PreOpenOutlook;
    expect(await make({ stale: [stored] }).svc.forReport(NOW)).toMatchObject({ source: 'stored', items: [stored] });
    const m = make({ stored: true });
    const p = await m.svc.forReport(NOW);
    expect(p.source).toBe('preview');
    expect(p.items.find((i) => i.underlying === 'CRUDEOIL')?.bias).toBe('BEARISH');
    expect(m.prices.chart).not.toHaveBeenCalled();
    expect(m.repo.insertOutlook).not.toHaveBeenCalled();
  });

  it('NSE trading: NIFTY / BANKNIFTY carry ONE US overnight section (VIX, event line; no direction); CRUDEOIL does not', async () => {
    const prev = process.env.MARKET_EVENT_DAYS;
    process.env.MARKET_EVENT_DAYS = '2026-11-02:US_MIDTERM_RESULTS';
    try {
      const { svc, repo, prices } = make({ nseOpen: true });
      const r = await svc.run(NOW, { alert: false });
      expect(r.outlooks.map((o) => o.underlying)).toEqual(['CRUDEOIL', 'NIFTY', 'BANKNIFTY']);
      expect(r.outlooks[0].usOvernight).toBeUndefined();
      expect(r.outlooks[1].usOvernight).toBe(r.usOvernight);
      expect(r.outlooks[2].usOvernight).toBe(r.usOvernight);
      expect(r.usOvernight?.vix).toMatchObject({ close: 15.87, typicalDayMovePct: 1 });
      expect(r.usOvernight?.indianCloseAt).toBe('2026-10-30T10:00:00.000Z');
      expect(r.usOvernight?.lines).toContain('Event: US midterm results overnight — expect a bigger-than-usual opening move; direction not predicted');
      expect(repo.lastVixClose).toHaveBeenCalledTimes(1);
      expect(prices.chart).toHaveBeenCalledWith('ES=F');
    } finally {
      if (prev === undefined) delete process.env.MARKET_EVENT_DAYS;
      else process.env.MARKET_EVENT_DAYS = prev;
    }
  });
});
