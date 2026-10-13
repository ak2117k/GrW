import { readFileSync } from 'fs';
import { join } from 'path';
import { Logger } from '@nestjs/common';
import { MarketCuesService, MARKET_CUES_CRONS } from './market-cues.service';
import { COMMODITY_CUE_KEYS } from './market-cues.types';
import { COMMODITY_SYMBOLS, parseCnbcCommodities } from './fetchers/commodity-cues.fetcher';
import { unavailableSnapshot } from './market-cues.snapshot';
import type { FetchLike } from './fetchers/cue-http';

const FX = join(__dirname, '__fixtures__');
const raw = (name: string) => readFileSync(join(FX, name), 'utf8');
const ist = (s: string) => new Date(`${s}+05:30`);

/** The fixture was captured Mon 2026-10-12 ~23:14 IST (13:44 New York). */
const MON_2320 = ist('2026-10-12T23:20:00');

function make(env: Record<string, string> = {}, reply: (url: string) => { status: number; body: string } | Error = () => ({ status: 200, body: raw('cnbc-commodities.json') })) {
  const config = {
    get: (k: string) => ({ MARKET_CUES_ENABLED: 'true', MARKET_CUES_RETRY_DELAY_MS: '0', ...env } as Record<string, string>)[k],
  };
  const svc = new MarketCuesService(config as never);
  const calls: string[] = [];
  const fn: FetchLike = async (url) => {
    calls.push(url);
    const out = reply(url);
    if (out instanceof Error) throw out;
    return { ok: out.status >= 200 && out.status < 300, status: out.status, text: async () => out.body };
  };
  svc.fetchImpl = fn;
  return { svc, calls };
}

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('parseCnbcCommodities', () => {
  it('reads every benchmark from the one CNBC payload, keeping the contract month', () => {
    const out = parseCnbcCommodities(JSON.parse(raw('cnbc-commodities.json')));
    expect(out.wtiCrude).toMatchObject({
      values: { symbol: 'CL=F', last: 93.85, previousClose: 91.85, change: 2, contract: "WTI Crude (Nov'26)" },
      sourceTime: '2026-10-12T17:44:17.000Z',
    });
    expect(out.brentCrude?.values.last).toBe(106.8);
    expect(out.gold?.values).toMatchObject({ symbol: 'GC=F', last: 4193, previousClose: 4216.3 });
    expect(out.silver?.values.last).toBe(60.51);
    expect(out.naturalGas?.values.last).toBe(3.144);
    expect(out.copper?.values.last).toBe(6.7535);
    expect(out.usdInr?.values).toMatchObject({ symbol: 'USDINR', last: 95.77 });
  });
});

describe('commodity cues — one batched CNBC request per refresh', () => {
  it('fetches all seven benchmarks in ONE request; each carries its own time and status', async () => {
    const { svc, calls } = make();
    const snap = await svc.ensure(['commodities'], MON_2320);
    expect(calls).toHaveLength(1);
    for (const k of COMMODITY_CUE_KEYS) expect(calls[0]).toContain(encodeURIComponent(COMMODITY_SYMBOLS[k].cnbc));
    expect(snap.commodities.wtiCrude).toMatchObject({ status: 'ok', sourceTime: '2026-10-12T17:44:17.000Z', fetchedAt: MON_2320.toISOString() });
    expect(snap.commodities.wtiCrude.source).toMatch(/CNBC.*@CL\.1/);
    expect(snap.commodities.wtiCrude.basis).toMatch(/quote time/);
    expect(snap.commodities.gold.values?.last).toBe(4193);
  });

  it('a futures quote goes stale by its own clock; USD/INR has its own, longer limit', async () => {
    const { svc } = make();
    await svc.refresh('commodities', MON_2320);
    const later = svc.snapshot(ist('2026-10-13T00:30:00'));
    expect(later.commodities.wtiCrude.status).toBe('stale');
    expect(later.commodities.wtiCrude.reason).toMatch(/minutes old/);
    // INR= was quoted at 15:32 IST — eight hours before; still inside its limit.
    expect(svc.snapshot(MON_2320).commodities.usdInr.status).toBe('ok');
  });

  it('a symbol missing from the reply is unavailable WITH the reason; the rest are kept', async () => {
    const body = JSON.parse(raw('cnbc-commodities.json'));
    body.FormattedQuoteResult.FormattedQuote = body.FormattedQuoteResult.FormattedQuote.filter((r: { symbol: string }) => r.symbol !== '@NG.1');
    const { svc } = make({}, () => ({ status: 200, body: JSON.stringify(body) }));
    const snap = await svc.ensure(['commodities'], MON_2320);
    expect(snap.commodities.naturalGas).toMatchObject({ values: null, status: 'unavailable' });
    expect(snap.commodities.naturalGas.reason).toMatch(/@NG\.1/);
    expect(snap.commodities.copper.status).toBe('ok');
  });

  it('CNBC down: every benchmark unavailable with the HTTP status, never a zero; ONE retry only', async () => {
    const { svc, calls } = make({}, () => ({ status: 503, body: '' }));
    const snap = await svc.ensure(['commodities'], MON_2320);
    expect(calls).toHaveLength(2);
    for (const k of COMMODITY_CUE_KEYS) {
      expect(snap.commodities[k].values).toBeNull();
      expect(snap.commodities[k].reason).toMatch(/HTTP 503/);
    }
  });

  it('MARKET_CUES_COMMODITIES=false turns the source off on its own, naming the switch', async () => {
    const { svc, calls } = make({ MARKET_CUES_COMMODITIES: 'false' });
    const snap = await svc.ensure(['commodities'], MON_2320);
    expect(calls).toHaveLength(0);
    expect(snap.commodities.gold.reason).toMatch(/MARKET_CUES_COMMODITIES/);
  });

  it('master switch off: nothing fetched, every benchmark says why', async () => {
    const { svc, calls } = make({ MARKET_CUES_ENABLED: 'false' });
    const snap = await svc.ensure(['commodities'], MON_2320);
    expect(calls).toHaveLength(0);
    expect(snap.commodities.wtiCrude.reason).toMatch(/MARKET_CUES_ENABLED/);
  });

  it('the unavailable snapshot carries the commodities too', () => {
    const s = unavailableSnapshot('not wired');
    for (const k of COMMODITY_CUE_KEYS) expect(s.commodities[k]).toMatchObject({ values: null, status: 'unavailable', reason: 'not wired' });
  });
});

describe('commodity cues — in-session schedule', () => {
  it('refreshes every 10 minutes, weekdays, 09:00–23:30 IST', () => {
    expect(MARKET_CUES_CRONS.commoditiesDay).toBe('0 */10 9-22 * * 1-5');
    expect(MARKET_CUES_CRONS.commoditiesLate).toBe('0 0-30/10 23 * * 1-5');
  });

  it('fires on an MCX trading day, not on a weekend, not when off', () => {
    const { svc } = make();
    expect(svc.shouldFire('commoditiesDay', ist('2026-10-12T21:00:00'))).toBe(true);
    expect(svc.shouldFire('commoditiesLate', ist('2026-10-12T23:30:00'))).toBe(true);
    expect(svc.shouldFire('commoditiesDay', ist('2026-10-10T21:00:00'))).toBe(false); // Saturday
    expect(make({ MARKET_CUES_COMMODITIES: 'false' }).svc.shouldFire('commoditiesDay', ist('2026-10-12T21:00:00'))).toBe(false);
    expect(make({ MARKET_CUES_ENABLED: 'false' }).svc.shouldFire('commoditiesDay', ist('2026-10-12T21:00:00'))).toBe(false);
  });

  it('the 23:40 and 08:25 slots refresh the commodities too, so the overnight reviews read fresh benchmarks', async () => {
    const { svc, calls } = make({ MARKET_CUES_US: 'false', MARKET_CUES_GIFT: 'false' });
    jest.useFakeTimers().setSystemTime(ist('2026-10-12T23:40:00'));
    try {
      await svc.usGiftNight();
    } finally {
      jest.useRealTimers();
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('quote.cnbc.com');
  });
});
