# Stock Overview Panel — Design Spec

**Date:** 2026-05-07
**Status:** Approved (in conversation, 2026-05-07)
**Owner:** Aryan Kumar
**Related:** Context-Scoring Engine spec (`2026-05-07-context-scoring-engine-design.md`)

---

## 1. Problem

Today the Charts page shows a chart with a small floating `AnalysisPanel` pinned to the top-right corner. The trader has no in-context view of:

- The instrument's live quote details beyond what the chart axis shows
- Market depth (5-level bid/ask)
- Standalone indicators when no setup is active
- Options chain at a glance (for F&O underlyings)
- Symbol-filtered news
- Company fundamentals

Switching pages for each of these is friction. Broker apps like Groww solve this with a **chart + scrollable info panel** pattern — chart up top, all secondary information stacked below in cards.

## 2. Goal

Replace the current ChartsPage layout with a Groww-style two-zone view:

1. **Chart zone** — top 70% of viewport, full width, distraction-free (no floating panels).
2. **Info zone** — scrollable section below the chart, full-width stacked cards covering setup, quote, depth, indicators, options preview, news, fundamentals.

The trader sees the chart fully unobstructed; everything secondary scrolls into view below.

## 3. Non-goals (v1)

- Mobile-first redesign — desktop continues to be primary; cards must not break on mobile but mobile polish is v2.
- Real fundamentals data — v1 ships a placeholder card; integration with NSE/BSE/Yahoo is a separate effort.
- Persistent depth WebSocket subscriptions — v1 polls REST every 2s. WS push is a v2 optimization.
- Full options chain UI inside the panel — v1 shows ATM ± 3 strikes preview with a link to the existing `/options` page.

## 4. Page layout

```
┌────────────────────────────────────────────────────────────────────┐
│  Symbol header strip (existing — symbol search, timeframe pills)    │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│                                                                    │
│                       CHART  (~70vh, full width)                    │
│                                                                    │
│                  no floating overlay panels                         │
│                                                                    │
├────────────────────────────────────────────────────────────────────┤
│  [Card 1]  Setup & Market Context     ← was floating AnalysisPanel │
│                                                                    │
│  [Card 2]  Live Quote                                               │
│                                                                    │
│  [Card 3]  Market Depth                                             │
│                                                                    │
│  [Card 4]  Indicators                                               │
│                                                                    │
│  [Card 5]  Options Chain Preview      (F&O only — hidden for cash)  │
│                                                                    │
│  [Card 6]  News                                                     │
│                                                                    │
│  [Card 7]  Fundamentals (stub)                                      │
└────────────────────────────────────────────────────────────────────┘
                          ↓ page scroll
```

- Chart container: `height: 70vh`. Existing chart resize logic must be re-wired to listen to this container, not the previous absolute-positioned wrapper.
- Info panel: standard document flow below the chart, max-width matching the chart's container, full-width stacked cards with consistent vertical spacing (`gap-4`).
- Each card: header row (title + optional action link e.g. "View all →") + body. Dark-theme styling matching existing components.

## 5. Section-by-section design

### Card 1 — Setup & Market Context

- **Component:** `SetupContextCard.tsx` (refactor of existing `AnalysisPanel.tsx`, drag wrapper removed)
- **Data source:** `GET /api/signals/analyze?token=...` (existing) — returns `analysis` with `setupContext` for active setups, or a NoSetupAnalysis response otherwise.
- **Visible when:** `analysis.kind === 'setup'`. When no setup is active, the card renders a compact "No active setup" placeholder so the slot is consistent (don't unmount — visual bouncing is annoying).
- **Body:** Entry / SL / Target / TP1 (with obstacle subtitle if `tp1Source==='obstacle'`), RR bar, Grade chip, then the **Market Context** block (score, tier, coverage, factor breakdown — exactly what we shipped in commit `b1470aa`).

### Card 2 — Live Quote

- **Component:** `LiveQuoteCard.tsx` (new)
- **Data source:** existing `useMarketData()` (WebSocket tick coalesce) + `GET /api/market-data/instruments/:token/quote` for first paint.
- **Backend gap:** `Quote` type needs a new `vwap?: number` field. `LevelBookService` already computes intraday VWAP; surface it on the quote DTO.
- **Body (single horizontal row, wraps on narrow):**
  - LTP (large, color-coded by sign)
  - Day change abs + %
  - Day H / L (range bar showing where LTP sits in today's range)
  - Open
  - Prev Close
  - VWAP
  - Volume + delta vs 20d-avg-volume (small caption)

### Card 3 — Market Depth

- **Component:** `MarketDepthCard.tsx` (new)
- **Data source:** **NEW** `GET /api/market-data/instruments/:token/depth` — wraps Angel One `getMarketDepth()`. Returns `{ bids: [{ price, qty, orders }], asks: [{ price, qty, orders }] }` (5 levels each).
- **Frontend polls:** every 2 seconds via React Query (or hand-rolled `setInterval`). No WS subscription in v1.
- **Body:** Two-column ladder. Left = bids (green tinted), right = asks (red tinted). Each row: price | qty | orders. 5 levels each. Total bid/ask qty shown at the bottom.
- **Edge cases:** stocks halted / no depth available → show "Depth unavailable" caption. Index instruments → hide the card (depth makes no sense for indices).

### Card 4 — Indicators

- **Component:** `IndicatorsCard.tsx` (new)
- **Data source:** **NEW** `GET /api/signals/indicators?token=...&exchange=...&timeframe=...` — extracts the existing `computeIndicators()` logic from `signal-generator.service.ts::analyze()` into a reusable method, exposed via a thin controller endpoint.
  - Returns just `IndicatorReadings` (RSI14, MACD-histogram, EMA9, EMA21, BB position, ROC10, alignment object).
  - The setup-side `analyze()` continues to use the same method internally — single source of truth.
- **Body:** Inline strip of 5 indicator chips: `RSI14: 62.3 (bullish)`, `MACD: +0.42`, `EMA9>EMA21 (cross 3 bars ago)`, `BB: +0.8 (upper)`, `ROC10: +1.2%`. Color = green/red/gray for aligned/opposed/neutral relative to chart's last close (since there's no setup direction to align against here, use price direction).
- **Edge cases:** insufficient candle history → render dashes for the missing indicators, not a hard error.

### Card 5 — Options Chain Preview *(F&O only)*

- **Component:** `OptionsChainPreviewCard.tsx` (new)
- **Data source:** existing `GET /api/options/chain/:underlying?expiry=...` via `useOptionsChain()` hook. Filter to ATM ± 3 strikes (7 rows total).
- **Visible when:** the current symbol is an F&O underlying. Detection: existing instrument metadata likely tags F&O. If unsure, fall back to "show if `useOptionsChain` returns non-empty".
- **Body:** 7-row mini table. Columns: CE LTP | CE OI Δ | Strike | PE OI Δ | PE LTP. ATM row highlighted. Header shows nearest expiry. Footer: "View full chain →" link to `/options/:underlying`.
- **Edge cases:** non-F&O stock → hide entire card. F&O stock with no chain data yet → "Loading chain…" placeholder.

### Card 6 — News

- **Component:** `SymbolNewsCard.tsx` (new)
- **Data source:** existing `GET /api/news/symbol/:symbol` — already supports symbol filter.
- **Body:** 5–10 most recent headlines. Each row: source logo / name | headline (link) | timestamp ("2h ago"). Footer: "View all →" links to `/news?symbol=...`.
- **Edge cases:** no news for symbol → "No recent news for {symbol}" caption.

### Card 7 — Fundamentals (stub)

- **Component:** `FundamentalsStubCard.tsx` (new)
- **Data source:** none.
- **Body:** Grid of placeholder labels: Sector, Industry, Market Cap, P/E, P/B, EPS, ROE, Debt/Equity. Each value renders as `—`. Top-right corner: "Coming soon" pill.
- **Edge cases:** none — pure stub. Gives the slot visual presence so v2 fundamentals integration is a drop-in.

## 6. Backend changes (the three real gaps)

| Gap | File | Change |
|-----|------|--------|
| 1. VWAP on Quote | `packages/shared/src/types/index.ts` + `apps/api/src/modules/market-data/...quote DTO/mapper` | Add optional `vwap?: number` to `Quote`. Populate from `LevelBookService.getSnapshot(token).vwap` when building the quote response (and when emitting the WS tick coalesce). |
| 2. Market depth endpoint | `apps/api/src/modules/market-data/services/angel-one-adapter.service.ts` + `market-data.controller.ts` | Add `getMarketDepth(token, exchange)` to the adapter (wraps SmartAPI). Add `GET /instruments/:token/depth` to the controller. Cache for 1.5s (REST polling slop). |
| 3. Standalone indicators endpoint | `apps/api/src/modules/signal-generator/services/signal-generator.service.ts` + `signal-generator.controller.ts` | Extract the indicator-computation logic out of `analyze()` into a public `computeIndicatorsFor(token, exchange, timeframe): Promise<IndicatorReadings | null>` method. Add `GET /signals/indicators` controller route that calls it. `analyze()` should also use this method internally (DRY). |

No schema migrations needed.

## 7. Frontend changes summary

- **`apps/web/src/pages/charts/ChartsPage.tsx`** — restructure layout. Chart container is `height: 70vh`. Below it, a `<StockOverviewPanel symbol={...} token={...} exchange={...} timeframe={...} />` component.
- **`apps/web/src/components/charts/StockOverviewPanel.tsx`** *(new)* — orchestrator that mounts the 7 cards in order, passing the symbol/token/exchange/timeframe down. Owns no data — each card fetches its own.
- **7 new card components** under `apps/web/src/components/charts/` (or a new `apps/web/src/components/stock-overview/` subdirectory — implementer's call, prefer the latter for tidiness).
- **`AnalysisPanel.tsx` deletion / refactor** — its body becomes `SetupContextCard.tsx`. The drag wrapper goes away. The old file can be deleted once nothing imports it.
- **Chart resize logic** — verify `useChartData()` / chart resize observer adjusts to the new 70vh container correctly. The existing TradingView Lightweight Charts wrapper should re-fit on container resize.

## 8. Data flow

```
ChartsPage
├─ symbol/token/exchange/timeframe (URL params + symbol search)
├─ <Chart>                                       ← existing data flow unchanged
└─ <StockOverviewPanel>
   ├─ <SetupContextCard>      ← useChartAnalysis  (existing)
   ├─ <LiveQuoteCard>          ← useMarketData    (existing, +vwap)
   ├─ <MarketDepthCard>        ← useMarketDepth   (new — REST poll 2s)
   ├─ <IndicatorsCard>         ← useIndicators    (new — REST, refetch on tf change)
   ├─ <OptionsChainPreviewCard> ← useOptionsChain (existing, slice ATM ± 3)
   ├─ <SymbolNewsCard>          ← useNews(symbol) (existing)
   └─ <FundamentalsStubCard>    (no data)
```

Each card is independent — one slow card doesn't block others. Loading states are per-card.

## 9. Edge cases

| Case | Behavior |
|------|----------|
| Symbol not selected (initial page load) | Cards render their empty/loading states. No errors. |
| Token = "0" or invalid | All cards short-circuit fetches (existing pattern from `useChartAnalysis`). |
| Index instrument (NIFTY, BANKNIFTY) | Depth card hidden (no depth for indices). Options card hidden (use the existing /options page for index chains — or could be shown later, but v1 hides for simplicity). Fundamentals card hidden. Other cards render normally. |
| F&O stock with no chain data yet (boot lag) | Options card shows "Loading chain…" placeholder. |
| Backend down | Each card shows its individual error caption. Chart continues to work because it has its own data path. |
| User scrolls to bottom and back | Cards keep their data (no remount on scroll). |
| Symbol changes (search) | All cards refetch with new symbol/token. URL params update. |
| Network flap | React Query retries with backoff (existing config). |

## 10. Visual / styling

- Match existing dark theme: card background `bg-zinc-900/50` (or whatever the existing AnalysisPanel uses), border `border-zinc-800`, padding `p-4`, rounded `rounded-lg`.
- Card header: `text-sm font-semibold text-zinc-300 mb-2` with optional right-aligned action link in `text-xs text-blue-400`.
- Spacing between cards: `gap-4` in a `flex flex-col`.
- Container max-width: matches the chart container above (probably the page's main content max-width — implementer to verify).

## 11. Test plan

**Backend:**
- Unit test: `getMarketDepth` adapter returns shape `{ bids: [...5], asks: [...5] }` from a mock SmartAPI response.
- Unit test: `computeIndicatorsFor` returns same numbers as `analyze()` for the same input candles (regression — single source of truth).
- E2E: hit `/market-data/instruments/:token/depth` and `/signals/indicators` against a known token, assert response shape.

**Frontend:**
- Visual smoke test: load Charts page for NIFTY, RELIANCE, TCS. Confirm cards render correctly, F&O card hides for cash-only stocks, indices hide depth.
- Manual test: switch symbol via search, confirm all cards refetch.
- Manual test: scroll behavior, no jank.
- Manual test: chart resize on window resize (confirm 70vh adjusts).

## 12. Rollout

Single PR / branch. No feature flag. The change is large but visually obvious — easy to roll back if needed.

---

## Self-review

- [x] Placeholders: none.
- [x] Internal consistency: page layout, section list, backend gaps, data flow all match.
- [x] Scope: focused on a single feature (panel restructure + 3 backend gaps). Fundamentals deliberately stubbed.
- [x] Ambiguity: implementer decisions called out (subdirectory naming, F&O detection fallback) with a default.
