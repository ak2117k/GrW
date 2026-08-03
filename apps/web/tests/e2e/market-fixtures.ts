/**
 * Deterministic fixtures + route mocks for the /market E2E suite.
 *
 * WHY MOCK: every section of the Market page is fed by an Angel One-backed
 * endpoint. Hitting the real broker makes the suite depend on market hours,
 * live credentials and a warm feed cache — i.e. it would be red most of the
 * day for reasons that have nothing to do with the UI. Instead we intercept
 * the five market-data endpoints with `page.route()` and serve payloads whose
 * SHAPE mirrors the real controller exactly
 * (apps/api/src/modules/market-data/controllers/market-data.controller.ts):
 *
 *   GET  /api/market-data/indices            -> { indices: [{ key, symbol, token, exchange, quote }] }
 *   GET  /api/market-data/commodities        -> { commodities: [...], count }
 *   GET  /api/market-data/breadth            -> { advances, declines, unchanged, adRatio, total }
 *   GET  /api/market-data/sector-performance -> { sectors: [{ sector, symbol, changePercent, ltp }] }
 *   POST /api/market-data/quotes             -> { quotes: [{ token, exchange, ltp, ... }], count }
 *
 * Auth is NOT mocked — the suite logs in through the real form exactly like
 * tests/e2e/user-surface.spec.ts, so a running API + seeded `td_saas` DB is
 * still required (see that file's header for how to bring the stack up).
 */
import type { Page } from '@playwright/test';

export const VIEWER_EMAIL = 'viewer@panamoure.com';
export const VIEWER_PASSWORD = 'ViewerPass123!';

/** One index entry as returned by GET /api/market-data/indices. */
export interface IndexEntry {
  key: string;
  symbol: string;
  token: string;
  exchange: string;
  quote: Record<string, unknown> | null;
}

/**
 * Build a full Quote body (the contract the client renders). Field names match
 * `Quote` in packages/shared/src/types.
 */
function quote(
  symbol: string,
  token: string,
  exchange: string,
  ltp: number,
  change: number,
  changePercent: number,
): Record<string, unknown> {
  return {
    symbol,
    token,
    exchange,
    ltp,
    open: Number((ltp - change).toFixed(2)),
    high: Number((ltp + Math.abs(change)).toFixed(2)),
    low: Number((ltp - Math.abs(change) * 2).toFixed(2)),
    close: Number((ltp - change).toFixed(2)),
    volume: 1234567,
    change,
    changePercent,
    timestamp: new Date('2026-07-31T10:00:00.000Z').toISOString(),
  };
}

/**
 * Indices fixture. Keys/symbols/tokens mirror INDICES in @td/shared, which is
 * what IndicesBar iterates over — the store is keyed by SYMBOL, so a symbol
 * that isn't in that constant would never render.
 *
 * Numbers are deliberately odd (not round) so a text assertion on them cannot
 * accidentally match unrelated UI.
 */
export const INDICES_FIXTURE: IndexEntry[] = [
  {
    key: 'NIFTY_50',
    symbol: 'NIFTY',
    token: '99926000',
    exchange: 'NSE',
    quote: quote('NIFTY', '99926000', 'NSE', 24567.85, 123.45, 0.51),
  },
  {
    key: 'BANK_NIFTY',
    symbol: 'BANKNIFTY',
    token: '99926009',
    exchange: 'NSE',
    quote: quote('BANKNIFTY', '99926009', 'NSE', 51234.6, -210.4, -0.41),
  },
  {
    key: 'FIN_NIFTY',
    symbol: 'FINNIFTY',
    token: '99926037',
    exchange: 'NSE',
    quote: quote('FINNIFTY', '99926037', 'NSE', 23456.15, 88.2, 0.38),
  },
  {
    key: 'SENSEX',
    symbol: 'SENSEX',
    token: '99919000',
    exchange: 'BSE',
    quote: quote('SENSEX', '99919000', 'BSE', 80123.45, 412.7, 0.52),
  },
  {
    key: 'NIFTY_MIDCAP',
    symbol: 'NIFTY MIDCAP 50',
    token: '99926025',
    exchange: 'NSE',
    quote: quote('NIFTY MIDCAP 50', '99926025', 'NSE', 15678.9, -34.6, -0.22),
  },
  {
    key: 'NIFTY_IT',
    symbol: 'NIFTY IT',
    token: '99926013',
    exchange: 'NSE',
    quote: quote('NIFTY IT', '99926013', 'NSE', 37890.25, 655.3, 1.76),
  },
];

/** Same six indices, but every quote is null — the abandoned-feed failure mode. */
export const INDICES_NULL_QUOTES: IndexEntry[] = INDICES_FIXTURE.map((i) => ({
  ...i,
  quote: null,
}));

/**
 * Commodities fixture (GET /api/market-data/commodities).
 * CRUDEOIL / SILVER are deliberately NOT in the default watchlist, so any
 * assertion on them proves the COMMODITIES endpoint rendered — not the
 * watchlist quote poll.
 */
export const COMMODITIES_FIXTURE = [
  {
    symbol: 'CRUDEOIL',
    token: '429022',
    exchange: 'MCX',
    contractSymbol: 'CRUDEOIL21AUG26FUT',
    expiry: '21AUG2026',
    ltp: 6234.5,
    open: 6180.0,
    high: 6250.0,
    low: 6155.0,
    close: 6180.0,
    volume: 98765,
    change: 54.5,
    changePercent: 0.88,
  },
  {
    symbol: 'SILVER',
    token: '457532',
    exchange: 'MCX',
    contractSymbol: 'SILVER05SEP26FUT',
    expiry: '05SEP2026',
    ltp: 92345.75,
    open: 93000.0,
    high: 93110.0,
    low: 92200.0,
    close: 93000.0,
    volume: 4321,
    change: -654.25,
    changePercent: -0.7,
  },
  {
    symbol: 'GOLD',
    token: '477904',
    exchange: 'MCX',
    contractSymbol: 'GOLD05OCT26FUT',
    expiry: '05OCT2026',
    ltp: 71234.5,
    open: 70900.0,
    high: 71400.0,
    low: 70850.0,
    close: 70900.0,
    volume: 15432,
    change: 334.5,
    changePercent: 0.47,
  },
];

/** Breadth fixture (GET /api/market-data/breadth). A/D ratio = 1250/780 = 1.60. */
export const BREADTH_FIXTURE = {
  advances: 1250,
  declines: 780,
  unchanged: 45,
  adRatio: 1.6,
  total: 2075,
};

/** Sector performance fixture (GET /api/market-data/sector-performance). */
export const SECTORS_FIXTURE = [
  { sector: 'IT', symbol: 'NIFTY IT', changePercent: 2.35, ltp: 37890.25 },
  { sector: 'Banking', symbol: 'NIFTY BANK', changePercent: -1.12, ltp: 51234.6 },
  { sector: 'Pharma', symbol: 'NIFTY PHARMA', changePercent: 0.64, ltp: 21456.3 },
  { sector: 'Auto', symbol: 'NIFTY AUTO', changePercent: -0.33, ltp: 25678.4 },
];

/**
 * Watchlist quotes fixture (POST /api/market-data/quotes). Tokens match
 * DEFAULT_WATCHLIST in apps/web/src/stores/watchlist-store.ts. Note the real
 * endpoint keys rows by TOKEN only (no symbol) — the client re-attaches the
 * symbol from its own watchlist entry.
 */
export const WATCHLIST_QUOTES_FIXTURE = [
  {
    token: '2885',
    exchange: 'NSE',
    ltp: 2987.65,
    open: 2951.3,
    high: 2999.0,
    low: 2945.1,
    close: 2951.3,
    volume: 5432100,
    change: 36.35,
    changePercent: 1.23,
  },
  {
    token: '11536',
    exchange: 'NSE',
    ltp: 4123.4,
    open: 4160.0,
    high: 4165.5,
    low: 4110.0,
    close: 4160.0,
    volume: 987600,
    change: -36.6,
    changePercent: -0.88,
  },
  {
    token: '1333',
    exchange: 'NSE',
    ltp: 1678.95,
    open: 1670.0,
    high: 1682.0,
    low: 1665.4,
    close: 1670.0,
    volume: 7654300,
    change: 8.95,
    changePercent: 0.54,
  },
];

export interface MarketApiMocks {
  indices?: IndexEntry[];
  commodities?: typeof COMMODITIES_FIXTURE | unknown[];
  breadth?: Record<string, number>;
  sectors?: typeof SECTORS_FIXTURE | unknown[];
  quotes?: typeof WATCHLIST_QUOTES_FIXTURE | unknown[];
}

const json = (body: unknown) => ({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify(body),
});

/**
 * Install deterministic handlers for the five Market page endpoints.
 * Call BEFORE navigating to /market. Anything not listed here still hits the
 * real API (auth, instrument search, AI insight, ...).
 */
export async function mockMarketApi(
  page: Page,
  overrides: MarketApiMocks = {},
): Promise<void> {
  const indices = overrides.indices ?? INDICES_FIXTURE;
  const commodities = overrides.commodities ?? COMMODITIES_FIXTURE;
  const breadth = overrides.breadth ?? BREADTH_FIXTURE;
  const sectors = overrides.sectors ?? SECTORS_FIXTURE;
  const quotes = overrides.quotes ?? WATCHLIST_QUOTES_FIXTURE;

  await page.route('**/api/market-data/indices**', (route) =>
    route.fulfill(json({ indices })),
  );
  await page.route('**/api/market-data/commodities**', (route) =>
    route.fulfill(json({ commodities, count: commodities.length })),
  );
  await page.route('**/api/market-data/breadth**', (route) =>
    route.fulfill(json(breadth)),
  );
  await page.route('**/api/market-data/sector-performance**', (route) =>
    route.fulfill(json({ sectors })),
  );
  await page.route('**/api/market-data/quotes**', (route) =>
    route.fulfill(json({ quotes, count: quotes.length })),
  );
}

/**
 * Session cache — the tokens written to localStorage by the first successful
 * login in this worker.
 *
 * WHY: POST /auth/login is account-rate-limited to 5 attempts per 15 minutes
 * (ACCOUNT_THROTTLE in apps/api/.../auth.controller.ts). A suite that logged in
 * once per test tripped the limiter and every later test 429'd. So we drive the
 * real login form ONCE and replay its localStorage into each later test's fresh
 * context — same auth path as user-surface.spec.ts, one round trip.
 */
let cachedSession: { name: string; value: string }[] | null = null;

/**
 * Put `page` on /market with an authenticated session.
 * First call performs the real form login; later calls seed localStorage.
 */
export async function loginAndOpenMarket(page: Page): Promise<void> {
  if (cachedSession) {
    await page.addInitScript((entries: { name: string; value: string }[]) => {
      for (const e of entries) window.localStorage.setItem(e.name, e.value);
    }, cachedSession);
  } else {
    await page.goto('/login');
    await page.locator('input[type="email"]').fill(VIEWER_EMAIL);
    await page.locator('input[type="password"]').fill(VIEWER_PASSWORD);
    await page.locator('button[type="submit"]').click();

    // Session established once the login route is gone from the URL (the
    // post-login destination varies by role, so don't pin it).
    await page.waitForURL((url) => !url.pathname.startsWith('/login'), {
      timeout: 30_000,
    });

    cachedSession = await page.evaluate(() =>
      Object.keys(window.localStorage).map((name) => ({
        name,
        value: window.localStorage.getItem(name) ?? '',
      })),
    );
  }

  await page.goto('/market');
  await page.waitForURL('**/market', { timeout: 30_000 });
}

/**
 * Collect uncaught page errors. A blank Market section in production was caused
 * by an `undefined.toFixed()` throw that unmounted the whole React tree, so
 * every test asserts this array stayed empty.
 */
export function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  return errors;
}
