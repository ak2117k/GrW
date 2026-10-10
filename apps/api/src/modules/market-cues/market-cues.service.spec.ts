import { readFileSync } from 'fs';
import { join } from 'path';
import { Logger } from '@nestjs/common';
import { MarketCuesService, MARKET_CUES_CRONS, type CronSlot } from './market-cues.service';
import type { FetchLike } from './fetchers/cue-http';

const FX = join(__dirname, '__fixtures__');
const raw = (name: string) => readFileSync(join(FX, name), 'utf8');

/** IST wall clock → Date. */
const ist = (s: string) => new Date(`${s}+05:30`);

type Route = { match: (url: string) => boolean; reply: () => { status: number; body: string } | Error };

/** A fake fetch: first matching route answers; every call is recorded. Headers are recorded too, to prove what is sent. */
function fakeFetch(routes: Route[]) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fn: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers });
    const r = routes.find((x) => x.match(url));
    if (!r) return { ok: false, status: 404, text: async () => 'not found' };
    const out = r.reply();
    if (out instanceof Error) throw out;
    return { ok: out.status >= 200 && out.status < 300, status: out.status, text: async () => out.body };
  };
  return { fn, calls };
}

const ok = (name: string) => () => ({ status: 200, body: raw(name) });
const has = (s: string) => (url: string) => url.includes(s);

const YAHOO_OK: Route[] = [
  { match: has('chart/%5EIXIC'), reply: ok('yahoo-ixic.json') },
  { match: has('chart/%5EGSPC'), reply: ok('yahoo-gspc.json') },
  { match: has('chart/%5EDJI'), reply: ok('yahoo-dji.json') },
  { match: has('chart/NQ%3DF'), reply: ok('yahoo-nqf.json') },
  { match: has('chart/ES%3DF'), reply: ok('yahoo-esf.json') },
];

function make(env: Record<string, string> = {}, routes: Route[] = []) {
  const config = {
    get: (k: string) =>
      ({ MARKET_CUES_ENABLED: 'true', MARKET_CUES_RETRY_DELAY_MS: '0', ...env } as Record<string, string>)[k],
  };
  const svc = new MarketCuesService(config as never);
  const f = fakeFetch(routes);
  svc.fetchImpl = f.fn;
  return { svc, calls: f.calls };
}

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

// Monday 08:25 IST — the morning US + GIFT fire after Friday's sessions.
const MON_0825 = ist('2026-10-12T08:25:00');

describe('MarketCuesService — switched off by default', () => {
  it('fetches nothing and reports every cue unavailable, naming the switch', async () => {
    const { svc, calls } = make({ MARKET_CUES_ENABLED: '' }, YAHOO_OK);
    const snap = await svc.ensure(['us', 'fiiDii', 'fiiOi', 'gift', 'preOpen'], MON_0825);
    expect(calls).toHaveLength(0);
    expect(snap.enabled).toBe(false);
    expect(snap.us.nasdaq).toMatchObject({ values: null, status: 'unavailable' });
    expect(snap.us.nasdaq.reason).toMatch(/MARKET_CUES_ENABLED/);
    expect(snap.gift.status).toBe('unavailable');
  });

  it('a per-source switch turns one source off on its own', async () => {
    const { svc, calls } = make({ MARKET_CUES_US: 'false' }, YAHOO_OK);
    const snap = await svc.ensure(['us'], MON_0825);
    expect(calls).toHaveLength(0);
    expect(snap.us.nasdaq.reason).toMatch(/MARKET_CUES_US/);
  });
});

describe('US cues', () => {
  it('Yahoo serves each symbol once; index closes carry the US session as their basis', async () => {
    const { svc, calls } = make({}, YAHOO_OK);
    const snap = await svc.ensure(['us'], MON_0825);
    expect(calls).toHaveLength(5);
    expect(snap.us.nasdaq).toMatchObject({
      status: 'ok',
      sourceTime: '2026-10-09T21:15:59.000Z',
      fetchedAt: MON_0825.toISOString(),
      values: { last: 27366.17, previousClose: 27193.34, change: 172.83 },
    });
    expect(snap.us.nasdaq.basis).toMatch(/previous US session close/);
    expect(snap.us.nasdaq.source).toMatch(/Yahoo/);
    // The futures quote is ~54 hours old by Monday 08:25 — stale, by its own clock.
    expect(snap.us.nasdaqFutures.basis).toMatch(/quote time/);
    expect(snap.us.nasdaqFutures.status).toBe('stale');
  });

  it('sends a browser User-Agent and an Accept header, no cookies', async () => {
    const { svc, calls } = make({}, YAHOO_OK);
    await svc.ensure(['us'], MON_0825);
    expect(calls[0].headers['User-Agent']).toMatch(/Mozilla/);
    expect(calls[0].headers.Accept).toBe('application/json');
    expect(Object.keys(calls[0].headers).map((h) => h.toLowerCase())).not.toContain('cookie');
  });

  it('a Yahoo failure is retried once, then served by CNBC in ONE request', async () => {
    const routes: Route[] = [
      { match: has('chart/%5EIXIC'), reply: () => ({ status: 503, body: '' }) },
      { match: has('quote.cnbc.com'), reply: ok('cnbc-quotes.json') },
      ...YAHOO_OK.slice(1),
    ];
    const { svc, calls } = make({}, routes);
    const snap = await svc.ensure(['us'], MON_0825);
    expect(calls.filter((c) => c.url.includes('chart/%5EIXIC'))).toHaveLength(2);
    const cnbc = calls.filter((c) => c.url.includes('quote.cnbc.com'));
    expect(cnbc).toHaveLength(1);
    expect(cnbc[0].url).toContain('.IXIC');
    expect(snap.us.nasdaq).toMatchObject({ status: 'ok', sourceTime: '2026-10-09', values: { last: 27366.17 } });
    expect(snap.us.nasdaq.source).toMatch(/CNBC.*fallback/);
    expect(snap.us.sp500.source).toMatch(/Yahoo/);
  });

  it('both sources failing stores NO value — unavailable with the reason, never a zero', async () => {
    const down: Route[] = [{ match: () => true, reply: () => ({ status: 503, body: '' }) }];
    const { svc } = make({}, down);
    const snap = await svc.ensure(['us'], MON_0825);
    expect(snap.us.nasdaq.values).toBeNull();
    expect(snap.us.nasdaq.status).toBe('unavailable');
    expect(snap.us.nasdaq.reason).toMatch(/HTTP 503/);
  });

  it('logs the HTTP status and the network cause code — never the headers', async () => {
    const netErr = Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT', message: 'Connect Timeout Error' } });
    const routes: Route[] = [
      { match: has('chart/%5EIXIC'), reply: () => netErr },
      { match: has('quote.cnbc.com'), reply: () => ({ status: 403, body: '' }) },
      ...YAHOO_OK.slice(1),
    ];
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { svc } = make({}, routes);
    await svc.ensure(['us'], MON_0825);
    const lines = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(lines).toMatch(/UND_ERR_CONNECT_TIMEOUT/);
    expect(lines).toMatch(/HTTP 403/);
    expect(lines).not.toMatch(/User-Agent|Mozilla|Accept/);
  });

  it('backs off after a failed fire: the next read inside the window sends nothing', async () => {
    const down: Route[] = [{ match: () => true, reply: () => ({ status: 503, body: '' }) }];
    const { svc, calls } = make({}, down);
    await svc.refresh('us', MON_0825);
    const n = calls.length;
    await svc.refresh('us', new Date(MON_0825.getTime() + 60_000));
    expect(calls.length).toBe(n);
    expect(svc.snapshot(MON_0825).us.nasdaq.reason).toMatch(/backoff/);
  });

  it('23:40 IST: the US session is open — index values are labelled intraday with their time, not "close"', async () => {
    const mid = JSON.parse(raw('yahoo-ixic.json'));
    const t = Date.parse('2026-10-12T18:10:00.000Z') / 1000; // Mon 14:10 EDT
    mid.chart.result[0].meta.regularMarketTime = t;
    mid.chart.result[0].meta.regularMarketPrice = 27400;
    mid.chart.result[0].timestamp.push(t);
    mid.chart.result[0].indicators.quote[0].close.push(27400);
    const routes: Route[] = [{ match: has('chart/%5EIXIC'), reply: () => ({ status: 200, body: JSON.stringify(mid) }) }, ...YAHOO_OK.slice(1)];
    const { svc } = make({}, routes);
    const at2340 = ist('2026-10-12T23:40:00');
    const snap = await svc.ensure(['us'], at2340);
    expect(snap.us.nasdaq.values).toEqual(expect.objectContaining({ phase: 'intraday', last: 27400, previousClose: 27366.17 }));
    expect(snap.us.nasdaq.basis).toMatch(/intraday — US regular session in progress/);
    expect(snap.us.nasdaq.basis).toMatch(/US holidays and early closes are not modelled/);
    expect(snap.us.nasdaq.status).toBe('ok');
    // The same intraday reading read next morning, after the close, is stale.
    const next = svc.snapshot(ist('2026-10-13T08:30:00'));
    expect(next.us.nasdaq.status).toBe('stale');
    expect(next.us.nasdaq.reason).toMatch(/intraday/);
  });

  it('08:25 IST: the same symbols read as the completed US session close', async () => {
    const { svc } = make({}, YAHOO_OK);
    const snap = await svc.ensure(['us'], MON_0825);
    expect(snap.us.nasdaq.values?.phase).toBe('close');
    expect(snap.us.nasdaq.basis).toMatch(/previous US session close/);
    expect(snap.us.nasdaqFutures.values?.phase).toBeUndefined();
  });

  it('a previous-US-session close goes stale once a later US session has closed', async () => {
    const { svc } = make({}, YAHOO_OK);
    await svc.ensure(['us'], MON_0825);
    // Tuesday 08:25 IST: Monday's US session (closed ~01:30 IST) should be the one shown.
    const snap = svc.snapshot(ist('2026-10-13T08:25:00'));
    expect(snap.us.nasdaq.status).toBe('stale');
    expect(snap.us.nasdaq.reason).toMatch(/2026-10-12/);
    expect(snap.us.nasdaq.values?.last).toBe(27366.17);
  });
});

describe('FII/DII cash', () => {
  it('NSE serves FII and DII, dated by the session', async () => {
    const { svc } = make({}, [{ match: has('fiidiiTradeReact'), reply: ok('nse-fiidii.json') }]);
    const snap = await svc.ensure(['fiiDii'], ist('2026-10-09T19:00:00'));
    expect(snap.fiiDii).toMatchObject({ status: 'ok', sourceTime: '2026-10-09', values: { fii: { net: -3568.9 }, dii: { net: 4743.26 } } });
  });

  it('falls back to NSDL — FPI only, dated to the trading day BEFORE the report', async () => {
    const { svc } = make({}, [
      { match: has('fiidiiTradeReact'), reply: () => ({ status: 401, body: '' }) },
      { match: has('fpi.nsdl.co.in'), reply: ok('nsdl-latest.html') },
    ]);
    const snap = await svc.ensure(['fiiDii'], ist('2026-10-09T19:00:00'));
    expect(snap.fiiDii.values).toMatchObject({ date: '2026-10-08', dii: null, fii: { net: -12943.17 } });
    expect(snap.fiiDii.source).toMatch(/NSDL/);
    expect(snap.fiiDii.basis).toMatch(/previous trading day/);
  });

  it('at 15:45 the previous session’s figure is shown, today’s marked not yet published', async () => {
    const { svc } = make({}, [{ match: has('fiidiiTradeReact'), reply: ok('nse-fiidii.json') }]);
    await svc.ensure(['fiiDii'], ist('2026-10-09T19:00:00'));
    const snap = svc.snapshot(ist('2026-10-12T15:45:00'));
    expect(snap.fiiDii.status).toBe('ok');
    expect(snap.fiiDii.reason).toMatch(/not yet published \(NSE publishes ~18:00–20:00/);
  });

  it('goes stale when a later session’s figure is due and missing', async () => {
    const { svc } = make({}, [{ match: has('fiidiiTradeReact'), reply: ok('nse-fiidii.json') }]);
    await svc.ensure(['fiiDii'], ist('2026-10-09T19:00:00'));
    expect(svc.snapshot(ist('2026-10-12T21:00:00')).fiiDii.status).toBe('stale');
  });
});

describe('FII index F&O positioning', () => {
  it('today’s file plus the previous one gives the change', async () => {
    const { svc, calls } = make({}, [
      { match: has('fao_participant_oi_09102026'), reply: ok('fao_participant_oi_09102026.csv') },
      { match: has('fao_participant_oi_08102026'), reply: ok('fao_participant_oi_08102026.csv') },
    ]);
    const snap = await svc.ensure(['fiiOi'], ist('2026-10-09T20:00:00'));
    expect(calls).toHaveLength(2);
    expect(snap.fiiOi.status).toBe('ok');
    expect(snap.fiiOi.values?.indexFutures).toEqual({ long: 34943, short: 328931 });
    expect(snap.fiiOi.values?.change?.previousDate).toBe('2026-10-08');
  });

  it('a missing previous file leaves the change null, not zero', async () => {
    const { svc } = make({}, [{ match: has('fao_participant_oi_09102026'), reply: ok('fao_participant_oi_09102026.csv') }]);
    const snap = await svc.ensure(['fiiOi'], ist('2026-10-09T20:00:00'));
    expect(snap.fiiOi.values?.change).toBeNull();
    expect(snap.fiiOi.reason).toMatch(/previous/);
  });
});

describe('GIFT Nifty', () => {
  const FUT: Route = { match: has('nse50_fut'), reply: ok('nse-nifty-futures.json') };

  it('NSE IX vs the NSE NIFTY current-month future close — a futures-vs-futures gap', async () => {
    const { svc } = make({}, [{ match: has('nseix.com'), reply: ok('nseix-market-rate.json') }, FUT]);
    const snap = await svc.ensure(['gift'], ist('2026-10-10T08:25:00'));
    expect(snap.gift.status).toBe('ok');
    expect(snap.gift.values).toMatchObject({ gap: -37.1, niftyFuture: { close: 22612.6, expiry: '2026-10-27' } });
    expect(snap.gift.basis).toMatch(/futures-vs-futures/);
    expect(snap.gift.sourceTime).toBe('2026-10-09T21:00:09.000Z');
  });

  it('falls back to the marketStatus giftnifty block', async () => {
    const { svc } = make({}, [
      { match: has('nseix.com'), reply: () => ({ status: 500, body: '' }) },
      { match: has('marketStatus'), reply: ok('nse-market-status.json') },
      FUT,
    ]);
    const snap = await svc.ensure(['gift'], ist('2026-10-10T08:25:00'));
    expect(snap.gift.source).toMatch(/marketStatus.*fallback/);
    expect(snap.gift.values?.gift.price).toBe(22575.5);
  });

  it('no future close: GIFT shown, gap null with the reason', async () => {
    const { svc } = make({}, [{ match: has('nseix.com'), reply: ok('nseix-market-rate.json') }]);
    const snap = await svc.ensure(['gift'], ist('2026-10-10T08:25:00'));
    expect(snap.gift.values?.gap).toBeNull();
    expect(snap.gift.reason).toMatch(/NIFTY current-month future close/);
  });
});

describe('pre-open book', () => {
  const PRE: Route = { match: has('market-data-pre-open'), reply: ok('nse-preopen-fo.json') };

  it('is ok on the day it describes and stale the next', async () => {
    const { svc } = make({}, [PRE]);
    const snap = await svc.ensure(['preOpen'], ist('2026-10-09T09:10:00'));
    expect(snap.preOpen.status).toBe('ok');
    expect(snap.preOpen.values?.entries.APOLLOHOSP.iep).toBe(7950);
    expect(svc.snapshot(ist('2026-10-12T09:10:00')).preOpen.status).toBe('stale');
  });

  it('ensure refetches a stale pre-open book, and concurrent callers share ONE request', async () => {
    const { svc, calls } = make({}, [PRE]);
    await Promise.all([
      svc.ensure(['preOpen'], ist('2026-10-09T09:10:00')),
      svc.ensure(['preOpen'], ist('2026-10-09T09:10:00')),
      svc.refresh('preOpen', ist('2026-10-09T09:10:00')),
    ]);
    expect(calls).toHaveLength(1);
  });
});

describe('boot warm-up', () => {
  const ROUTES: Route[] = [
    ...YAHOO_OK,
    { match: has('fiidiiTradeReact'), reply: ok('nse-fiidii.json') },
    { match: has('nseix.com'), reply: ok('nseix-market-rate.json') },
    { match: has('nse50_fut'), reply: ok('nse-nifty-futures.json') },
    { match: has('market-data-pre-open'), reply: ok('nse-preopen-fo.json') },
  ];

  it('with the flag on: runs after init, in the background, once per enabled source', async () => {
    const { svc, calls } = make({ MARKET_CUES_FII_OI: 'false' }, ROUTES);
    svc.onApplicationBootstrap();
    expect(calls).toHaveLength(0); // nothing on the boot path itself
    await svc.warmUpDone;
    const snap = svc.snapshot();
    expect(snap.us.nasdaq.values?.last).toBe(27366.17);
    expect(snap.fiiDii.values?.fii.net).toBe(-3568.9);
    expect(snap.gift.values?.gift.price).toBe(22575.5);
    expect(snap.preOpen.values?.entries.APOLLOHOSP.iep).toBe(7950);
    expect(calls.some((c) => c.url.includes('fao_participant_oi'))).toBe(false); // that source is off
    expect(calls.filter((c) => c.url.includes('chart/%5EIXIC'))).toHaveLength(1);
  });

  it('with the flag off: nothing runs', async () => {
    const { svc, calls } = make({ MARKET_CUES_ENABLED: 'false' }, ROUTES);
    svc.onApplicationBootstrap();
    await svc.warmUpDone;
    await new Promise((r) => setImmediate(r));
    expect(svc.warmUpDone).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('a failing source never throws out of the warm-up; it is retried once and left unavailable', async () => {
    const { svc, calls } = make({}, [{ match: () => true, reply: () => new TypeError('fetch failed') }]);
    expect(() => svc.onApplicationBootstrap()).not.toThrow();
    await expect(svc.warmUpDone).resolves.toBeUndefined();
    expect(calls.filter((c) => c.url.includes('fiidiiTradeReact'))).toHaveLength(2);
    expect(svc.snapshot().fiiDii.status).toBe('unavailable');
  });
});

describe('schedule', () => {
  it('the crons are the agreed IST times, weekdays only', () => {
    expect(MARKET_CUES_CRONS).toEqual({
      usGiftNight: '0 40 23 * * 1-5',
      usGiftMorning: '0 25 8 * * 1-5',
      fii: '0 0 19 * * 1-5',
      fiiRetry: '0 30 20 * * 1-5',
      fiiOi: '0 0 20 * * 1-5',
      fiiOiRetry: '0 0 21 * * 1-5',
      preOpen: '0 10 9 * * 1-5',
    });
  });

  it('every cron method pins Asia/Kolkata', () => {
    const src = readFileSync(join(__dirname, 'market-cues.service.ts'), 'utf8');
    const crons = [...src.matchAll(/@Cron\(([^)]*)\)/g)].map((m) => m[1]);
    expect(crons.length).toBe(7);
    for (const c of crons) expect(c).toMatch(/timeZone: 'Asia\/Kolkata'/);
  });

  it('skips NSE holidays and weekends (Dussehra, Tue 2026-10-20)', () => {
    const { svc } = make();
    const slots: CronSlot[] = ['usGiftMorning', 'usGiftNight', 'fii', 'fiiOi', 'preOpen'];
    for (const slot of slots) {
      expect({ slot, fires: svc.shouldFire(slot, ist('2026-10-20T09:10:00')) }).toEqual({ slot, fires: false });
      expect({ slot, fires: svc.shouldFire(slot, ist('2026-10-21T09:10:00')) }).toEqual({ slot, fires: true });
    }
    expect(svc.shouldFire('preOpen', ist('2026-10-10T09:10:00'))).toBe(false); // Saturday
  });

  it('a retry slot fires only when the first fire did not land today’s figure', async () => {
    const { svc } = make({}, [{ match: has('fiidiiTradeReact'), reply: ok('nse-fiidii.json') }]);
    expect(svc.shouldFire('fiiRetry', ist('2026-10-09T20:30:00'))).toBe(true);
    await svc.refresh('fiiDii', ist('2026-10-09T19:00:00'));
    expect(svc.shouldFire('fiiRetry', ist('2026-10-09T20:30:00'))).toBe(false);
  });

  it('nothing fires while the master switch is off', () => {
    const { svc } = make({ MARKET_CUES_ENABLED: 'false' });
    expect(svc.shouldFire('preOpen', ist('2026-10-21T09:10:00'))).toBe(false);
  });
});
