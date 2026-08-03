/**
 * E2E safety net for the Market page (/market).
 *
 * WHAT THIS PROVES
 *   Every section of the Market page renders REAL numbers from its endpoint,
 *   and — the regression that motivated this suite — when an endpoint has no
 *   data (null quotes / empty lists / 5xx) each section falls back to its own
 *   empty state ("--", "No … available") WITHOUT throwing. A production bug
 *   blanked the entire page because an `undefined.toFixed()` threw during
 *   render and took the whole React tree down, so every test here also fails
 *   on any uncaught page error.
 *
 *   Sections / endpoints covered:
 *     1. Indices grid       GET  /api/market-data/indices
 *     2. Commodities        GET  /api/market-data/commodities  (tab-gated)
 *     3. Market breadth     GET  /api/market-data/breadth
 *     4. Sector heatmap     GET  /api/market-data/sector-performance
 *     5. Watchlist rows     POST /api/market-data/quotes
 *
 * DETERMINISM
 *   All five endpoints are intercepted with `page.route()` and served fixture
 *   JSON whose shape mirrors the real controller (see market-fixtures.ts).
 *   No live broker, no market hours, no real quotes — runnable at any time.
 *
 * RUNNING
 *   Auth is NOT mocked: /market is behind RequireAuth, and this suite logs in
 *   through the real form with the same seeded viewer as user-surface.spec.ts
 *   (viewer@panamoure.com / ViewerPass123!). A running API (4101) + web (4100)
 *   with the seeded `td_saas` DB is therefore still required — see the header
 *   of tests/e2e/user-surface.spec.ts for the exact commands.
 *
 *     cd apps/web && npx playwright test tests/e2e/market-page.spec.ts
 */
import { test, expect, type Page } from '@playwright/test';
import {
  BREADTH_FIXTURE,
  COMMODITIES_FIXTURE,
  INDICES_FIXTURE,
  INDICES_NULL_QUOTES,
  SECTORS_FIXTURE,
  WATCHLIST_QUOTES_FIXTURE,
  collectPageErrors,
  loginAndOpenMarket,
  mockMarketApi,
} from './market-fixtures';

/** Browser noise that is never a render crash. */
const BENIGN = [/ResizeObserver loop/i];

function assertNoPageErrors(errors: string[]): void {
  const real = errors.filter((e) => !BENIGN.some((re) => re.test(e)));
  expect(real, `uncaught page error(s) while rendering /market:\n${real.join('\n')}`).toEqual([]);
}

/** The Market page shell must always be up, whatever the data looks like. */
async function expectPageAlive(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Market Overview' })).toBeVisible();
}

/** A watchlist row, anchored on the instrument's long name (unique to the panel). */
const watchlistRow = (page: Page, name: string) =>
  page.locator('div.group').filter({ hasText: name }).first();

// ---------------------------------------------------------------------------
// 1-5. Happy path: every section renders its real numbers.
// ---------------------------------------------------------------------------

test('Market page renders every section from live endpoint data', async ({ page }) => {
  const errors = collectPageErrors(page);
  await mockMarketApi(page);
  await loginAndOpenMarket(page);
  await expectPageAlive(page);

  // --- 1. Indices grid ------------------------------------------------------
  // NIFTY: ltp 24567.85 -> "24,567.85"; change +123.45 / +0.51%.
  await expect(page.getByText('24,567.85', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('+123.45 (+0.51%)')).toBeVisible();
  // A negative index renders without a "+" sign.
  await expect(page.getByText('51,234.60', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('-210.40 (-0.41%)')).toBeVisible();
  // SENSEX proves a non-NSE exchange row is wired too.
  await expect(page.getByText('80,123.45', { exact: true }).first()).toBeVisible();
  // Every index in the fixture produced a value (i.e. none fell back to "--,---").
  await expect(page.getByText('--,---')).toHaveCount(0);

  // --- 3. Market breadth ----------------------------------------------------
  await expect(page.getByRole('heading', { name: 'Market Breadth' })).toBeVisible();
  // Each legend entry is `<label><value>` in one flex row — assert the value
  // sits next to its own label rather than merely existing on the page.
  const legendRow = (label: string) =>
    page.getByText(label, { exact: true }).locator('xpath=..');
  await expect(legendRow('Advances')).toContainText(String(BREADTH_FIXTURE.advances));
  await expect(legendRow('Declines')).toContainText(String(BREADTH_FIXTURE.declines));
  await expect(legendRow('Unchanged')).toContainText(String(BREADTH_FIXTURE.unchanged));
  // A/D ratio is computed client-side: 1250 / 780 = 1.60.
  await expect(page.getByText('A/D Ratio: 1.60')).toBeVisible();

  // --- 4. Sector heatmap ----------------------------------------------------
  await expect(page.getByRole('heading', { name: 'Sector Heatmap' })).toBeVisible();
  for (const s of SECTORS_FIXTURE) {
    const sign = s.changePercent >= 0 ? '+' : '';
    await expect(
      page.getByText(`${sign}${s.changePercent.toFixed(2)}%`, { exact: true }).first(),
      `sector ${s.sector} did not render its change%`,
    ).toBeVisible();
  }
  await expect(page.getByText('IT', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Banking', { exact: true })).toBeVisible();
  await expect(page.getByText('No sector data available')).toHaveCount(0);

  // --- 5. Watchlist rows (POST /quotes) ------------------------------------
  // RELIANCE token 2885 -> ltp 2987.65, +1.23%.
  const reliance = watchlistRow(page, 'Reliance Industries');
  await expect(reliance).toContainText('2,987.65');
  await expect(reliance).toContainText('+1.23%');
  // A losing row keeps its minus sign.
  const tcs = watchlistRow(page, 'Tata Consultancy Services');
  await expect(tcs).toContainText('4,123.40');
  await expect(tcs).toContainText('-0.88%');

  // --- 2. Commodities (only fetched while its tab is active) ----------------
  await page.getByRole('button', { name: 'Commodities' }).click();
  for (const c of COMMODITIES_FIXTURE) {
    const row = page.getByRole('row', { name: new RegExp(c.symbol) });
    await expect(row, `commodity ${c.symbol} row missing`).toBeVisible();
    await expect(row).toContainText(
      c.ltp.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    );
  }
  await expect(page.getByText('No commodity data available')).toHaveCount(0);

  assertNoPageErrors(errors);
});

// ---------------------------------------------------------------------------
// Commodities-specific: the tab gates the fetch, and the section was fully
// blank in production — cover the request + the rendered rows explicitly.
// ---------------------------------------------------------------------------

test('Commodities tab: no fetch until selected, then rows render', async ({ page }) => {
  const errors = collectPageErrors(page);

  // Standard fixtures first, then a counting handler for /commodities on top —
  // Playwright matches route handlers in REVERSE registration order, so the
  // later handler wins.
  await mockMarketApi(page);

  let commodityCalls = 0;
  await page.route('**/api/market-data/commodities**', (route) => {
    commodityCalls += 1;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        commodities: COMMODITIES_FIXTURE,
        count: COMMODITIES_FIXTURE.length,
      }),
    });
  });

  await loginAndOpenMarket(page);
  await expectPageAlive(page);

  // The tab is gated: `useCommodities(activeTab === 'commodities')`.
  await expect(page.getByText('24,567.85', { exact: true }).first()).toBeVisible();
  expect(commodityCalls, 'commodities must not be fetched before its tab is open').toBe(0);

  await page.getByRole('button', { name: 'Commodities' }).click();

  const crude = page.getByRole('row', { name: /CRUDEOIL/ });
  await expect(crude).toBeVisible();
  await expect(crude).toContainText('6,234.50'); // ltp
  await expect(crude).toContainText('+54.50'); // change
  await expect(crude).toContainText('+0.88%'); // change%
  await expect(crude).toContainText('MCX');

  const silver = page.getByRole('row', { name: /SILVER/ });
  await expect(silver).toContainText('92,345.75');
  await expect(silver).toContainText('-0.70%');

  expect(commodityCalls).toBeGreaterThan(0);
  assertNoPageErrors(errors);
});

// ---------------------------------------------------------------------------
// KEY REGRESSION: no data anywhere -> empty states, page still alive.
// ---------------------------------------------------------------------------

test('empty/null payloads render "--" empty states and never crash the page', async ({
  page,
}) => {
  const errors = collectPageErrors(page);

  await mockMarketApi(page, {
    indices: INDICES_NULL_QUOTES, // every quote: null (the abandoned-feed shape)
    commodities: [],
    breadth: { advances: 0, declines: 0, unchanged: 0, adRatio: 0, total: 0 },
    sectors: [],
    quotes: [],
  });

  await loginAndOpenMarket(page);
  await expectPageAlive(page);

  // 1. Indices: every card shows the placeholder price + change.
  await expect(page.getByText('--,---').first()).toBeVisible();
  await expect(page.getByText('--,---')).toHaveCount(INDICES_FIXTURE.length);
  await expect(page.getByText('-- (--)')).toHaveCount(INDICES_FIXTURE.length);

  // 3. Breadth: rendered (not stuck on "Loading...") with a "--" A/D ratio.
  await expect(page.getByText('A/D Ratio: --')).toBeVisible();

  // 4. Sector heatmap: explicit empty state.
  await expect(page.getByText('No sector data available')).toBeVisible();

  // 5. Watchlist: every row falls back to "--" rather than a broken price.
  await expect(watchlistRow(page, 'Reliance Industries')).toContainText('--');
  await expect(watchlistRow(page, 'HDFC Bank')).toContainText('--');

  // Stock table with an empty quote store.
  await expect(page.getByText('Waiting for market data...')).toBeVisible();

  // 2. Commodities: empty list -> its own placeholder, not a blank panel.
  await page.getByRole('button', { name: 'Commodities' }).click();
  await expect(page.getByText('No commodity data available')).toBeVisible();

  assertNoPageErrors(errors);
});

// ---------------------------------------------------------------------------
// Rows PRESENT but unusable: this is the shape the API actually emits when the
// broker session can't quote a token — `ltp: null` (commodities / quotes) or a
// zeroed quote (indices). Each consumer must skip the row, not render junk or
// throw. Sections that DO have data must keep rendering alongside them.
// ---------------------------------------------------------------------------

test('rows with null/zero ltp are skipped, healthy sections still render', async ({
  page,
}) => {
  const errors = collectPageErrors(page);

  await mockMarketApi(page, {
    // Quote object present, but the price is 0 — nothing usable to show.
    indices: INDICES_FIXTURE.map((i) => ({
      ...i,
      quote: {
        symbol: i.symbol,
        token: i.token,
        exchange: i.exchange,
        ltp: 0,
        open: 0,
        high: 0,
        low: 0,
        close: 0,
        volume: 0,
        change: 0,
        changePercent: 0,
        timestamp: new Date('2026-07-31T10:00:00.000Z').toISOString(),
      },
    })),
    // Unentitled commodity: the controller returns ltp: null.
    commodities: COMMODITIES_FIXTURE.map((c) => ({ ...c, ltp: null })),
    // These two are healthy — they must NOT be collateral damage.
    breadth: BREADTH_FIXTURE,
    sectors: SECTORS_FIXTURE,
    // Rows returned for tokens the account can't quote.
    quotes: WATCHLIST_QUOTES_FIXTURE.map((q) => ({ ...q, ltp: null })),
  });

  await loginAndOpenMarket(page);
  await expectPageAlive(page);

  // Indices fall back to the placeholder rather than printing "0.00".
  await expect(page.getByText('--,---')).toHaveCount(INDICES_FIXTURE.length);

  // Watchlist rows ignore quote-less tokens instead of rendering junk.
  await expect(watchlistRow(page, 'Reliance Industries')).toContainText('--');

  // The healthy sections are unaffected.
  await expect(page.getByText('A/D Ratio: 1.60')).toBeVisible();
  await expect(page.getByText('+2.35%', { exact: true }).first()).toBeVisible();

  // Commodities with a null ltp are skipped -> placeholder, no crash.
  await page.getByRole('button', { name: 'Commodities' }).click();
  await expect(page.getByText('No commodity data available')).toBeVisible();

  assertNoPageErrors(errors);
});

// ---------------------------------------------------------------------------
// Endpoint failure (5xx): the page must survive a dead market-data backend.
// ---------------------------------------------------------------------------

test('5xx from every market-data endpoint leaves the page usable', async ({ page }) => {
  const errors = collectPageErrors(page);

  for (const path of [
    'indices',
    'commodities',
    'breadth',
    'sector-performance',
    'quotes',
  ]) {
    await page.route(`**/api/market-data/${path}**`, (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Internal server error' }),
      }),
    );
  }

  await loginAndOpenMarket(page);
  await expectPageAlive(page);

  // Indices fall back to placeholders rather than disappearing.
  await expect(page.getByText('--,---').first()).toBeVisible();
  // Sector heatmap resolves its loading state into an empty state.
  await expect(page.getByText('No sector data available')).toBeVisible();
  // Tabs still work with a dead backend.
  await page.getByRole('button', { name: 'Commodities' }).click();
  await expect(page.getByText('No commodity data available')).toBeVisible();

  assertNoPageErrors(errors);
});
