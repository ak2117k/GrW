# Stock Overview Panel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the floating AnalysisPanel with a Groww-style scrollable info panel below a 70vh chart, containing 7 stacked cards (Setup+Context, Quote, Depth, Indicators, Options preview, News, Fundamentals stub).

**Architecture:** Three thin backend additions (vwap field, depth endpoint, indicators endpoint) plus a frontend layout restructure of ChartsPage with one orchestrator + 7 card components. Each card fetches its own data — no shared loading state.

**Tech Stack:** NestJS 10, React 18, TypeScript, TailwindCSS, Zustand, React Query (or hand-rolled effects matching existing patterns), Angel One SmartAPI.

**Spec:** `docs/superpowers/specs/2026-05-07-stock-overview-panel-design.md`

---

## File structure

**Backend:**
- Modify: `packages/shared/src/types/index.ts` (add `vwap?: number` to `Quote`, add `MarketDepth` + `MarketDepthLevel` types)
- Modify: `apps/api/src/modules/market-data/services/angel-one-adapter.service.ts` (add `getMarketDepth` method)
- Modify: `apps/api/src/modules/market-data/controllers/market-data.controller.ts` (add `/instruments/:token/depth` route, populate vwap on quote response)
- Modify: `apps/api/src/modules/signal-generator/services/signal-generator.service.ts` (extract `computeIndicatorsFor` public method)
- Modify: `apps/api/src/modules/signal-generator/controllers/signal-generator.controller.ts` (add `/signals/indicators` route)

**Frontend:**
- Modify: `apps/web/src/pages/charts/ChartsPage.tsx` (chart 70vh + new panel)
- Create: `apps/web/src/components/stock-overview/StockOverviewPanel.tsx`
- Create: `apps/web/src/components/stock-overview/SetupContextCard.tsx` (refactor of `AnalysisPanel.tsx` body)
- Create: `apps/web/src/components/stock-overview/LiveQuoteCard.tsx`
- Create: `apps/web/src/components/stock-overview/MarketDepthCard.tsx`
- Create: `apps/web/src/components/stock-overview/IndicatorsCard.tsx`
- Create: `apps/web/src/components/stock-overview/OptionsChainPreviewCard.tsx`
- Create: `apps/web/src/components/stock-overview/SymbolNewsCard.tsx`
- Create: `apps/web/src/components/stock-overview/FundamentalsStubCard.tsx`
- Create: `apps/web/src/hooks/useMarketDepth.ts`
- Create: `apps/web/src/hooks/useIndicators.ts`
- Modify: `apps/web/src/types/index.ts` (mirror new shared types)
- Delete (after wiring): `apps/web/src/components/charts/AnalysisPanel.tsx` — keep until Task F2 is done and ChartsPage no longer imports it.

---

## Task B1 — Add `vwap` to Quote + populate from LevelBookService

**Files:**
- Modify: `packages/shared/src/types/index.ts`
- Modify: `apps/api/src/modules/market-data/controllers/market-data.controller.ts` (the quote-building method)
- Modify: `apps/api/src/modules/market-data/repositories/market-data.repository.ts` if it builds Quote objects

- [ ] **Step 1:** Add `vwap?: number` to the `Quote` interface in `packages/shared/src/types/index.ts`.

```typescript
export interface Quote {
  symbol: string;
  token: string;
  exchange: string;
  ltp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  change: number;
  changePercent: number;
  timestamp: number;
  vwap?: number;  // NEW — intraday VWAP from LevelBookService when available
}
```

- [ ] **Step 2:** Find the quote-building site(s). Grep for `ltp:` inside `apps/api/src/modules/market-data/`. There is at least one mapping in the controller's `/instruments/:token/quote` handler and possibly one in the repository.

- [ ] **Step 3:** Inject `LevelBookService` into the controller (or repository — wherever the Quote object is constructed). Read `LevelBookService.getSnapshot(token)?.vwap` and set it on the response (omit when undefined — it's optional).

- [ ] **Step 4:** Same for the WebSocket tick coalesce flush (search `apps/api/src/modules/market-data/gateways/market-data.gateway.ts` for the tick emit) — set `vwap` on the broadcast payload too.

- [ ] **Step 5:** Type-check.

```bash
cd apps/api
npx tsc --noEmit 2>&1 | grep -E "market-data|Quote\b" | head -20
```

Expected: zero errors in those paths.

- [ ] **Step 6:** Commit.

```bash
git add packages/shared/src/types/index.ts apps/api/src/modules/market-data/
git commit -m "$(cat <<'EOF'
feat(market-data): surface intraday vwap on Quote (REST + WS)

Quote already carried OHLCV — VWAP was computed in LevelBookService but
not exposed. Adds optional vwap to the shared Quote type and populates
it on both the REST quote endpoint and the WS tick coalesce flush so
the new LiveQuoteCard can read it without a second fetch.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task B2 — Market depth endpoint

**Files:**
- Modify: `packages/shared/src/types/index.ts` (add MarketDepth types)
- Modify: `apps/api/src/modules/market-data/services/angel-one-adapter.service.ts`
- Modify: `apps/api/src/modules/market-data/controllers/market-data.controller.ts`

- [ ] **Step 1:** Add types to shared:

```typescript
export interface MarketDepthLevel {
  price: number;
  qty: number;
  orders: number;
}

export interface MarketDepth {
  token: string;
  exchange: string;
  bids: MarketDepthLevel[];   // length up to 5
  asks: MarketDepthLevel[];   // length up to 5
  totalBidQty: number;
  totalAskQty: number;
  ts: number;                 // server timestamp (ms)
}
```

- [ ] **Step 2:** Find Angel One's depth call. Look at `apps/api/src/modules/market-data/services/angel-one-adapter.service.ts` for existing `smartApi.getLTP` / `getMarketData` calls and the SmartAPI docs URL referenced there. The SmartAPI method for depth is typically `getMarketData({ mode: 'FULL', exchangeTokens: { NSE: ['<token>'] } })` which returns a `depth: { buy: [...], sell: [...] }` block on the response. Confirm the exact shape from existing code patterns; if uncertain, log a sample response in dev once and adjust the mapper.

- [ ] **Step 3:** Add the adapter method:

```typescript
async getMarketDepth(token: string, exchange: string): Promise<MarketDepth | null> {
  try {
    const resp = await this.smartApi.getMarketData('FULL', {
      [exchange]: [token],
    });
    const node = resp?.data?.fetched?.[0];
    if (!node?.depth) return null;
    const bids = (node.depth.buy ?? []).slice(0, 5).map((b: any) => ({
      price: Number(b.price),
      qty: Number(b.quantity),
      orders: Number(b.orders),
    }));
    const asks = (node.depth.sell ?? []).slice(0, 5).map((a: any) => ({
      price: Number(a.price),
      qty: Number(a.quantity),
      orders: Number(a.orders),
    }));
    return {
      token,
      exchange,
      bids,
      asks,
      totalBidQty: bids.reduce((s, l) => s + l.qty, 0),
      totalAskQty: asks.reduce((s, l) => s + l.qty, 0),
      ts: Date.now(),
    };
  } catch (err) {
    this.logger.warn(`getMarketDepth failed for ${token}: ${(err as Error).message}`);
    return null;
  }
}
```

NB: respect the existing 350ms serial pacer / TTL cache pattern in this adapter (per memory: Angel One historical is rate-limited to ~3 req/sec; depth is a different API but the same SmartAPI session, so don't bypass any throttling already in place).

- [ ] **Step 4:** Add 1.5s in-memory cache keyed by `${exchange}:${token}` so frontend polling at 2s doesn't hammer Angel One:

```typescript
private depthCache = new Map<string, { data: MarketDepth; expiresAt: number }>();

async getMarketDepth(token: string, exchange: string): Promise<MarketDepth | null> {
  const key = `${exchange}:${token}`;
  const cached = this.depthCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  // ... existing fetch code from Step 3 ...

  if (depth) this.depthCache.set(key, { data: depth, expiresAt: Date.now() + 1500 });
  return depth;
}
```

- [ ] **Step 5:** Add the controller endpoint in `market-data.controller.ts`:

```typescript
@Get('instruments/:token/depth')
async getDepth(
  @Param('token') token: string,
  @Query('exchange') exchange: string,
): Promise<{ depth: MarketDepth | null }> {
  if (!exchange) throw new BadRequestException('exchange is required');
  const depth = await this.adapter.getMarketDepth(token, exchange);
  return { depth };
}
```

- [ ] **Step 6:** Smoke-test with curl:

```bash
curl "http://127.0.0.1:4001/api/market-data/instruments/3045/depth?exchange=NSE"
# expect: { "depth": { "bids": [...5], "asks": [...5], ... } }  (3045 = SBIN)
```

- [ ] **Step 7:** Commit.

```bash
git add packages/shared/src/types/index.ts apps/api/src/modules/market-data/
git commit -m "$(cat <<'EOF'
feat(market-data): GET /instruments/:token/depth (5-level bid/ask)

Wraps Angel One getMarketData(FULL) to surface 5-level depth for the
new MarketDepthCard. 1.5s in-memory cache keyed by exchange:token so
frontend polling at 2s doesn't double-call SmartAPI per refresh.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task B3 — Extract `computeIndicatorsFor` + new endpoint

**Files:**
- Modify: `apps/api/src/modules/signal-generator/services/signal-generator.service.ts`
- Modify: `apps/api/src/modules/signal-generator/controllers/signal-generator.controller.ts`

- [ ] **Step 1:** In `signal-generator.service.ts`, find the existing private indicator computation inside `analyze()` (the block that fills `IndicatorReadings`). Lift it out into a public method with this signature:

```typescript
async computeIndicatorsFor(
  token: string,
  exchange: string,
  timeframe: string,
): Promise<IndicatorReadings | null> {
  const candles = await this.candleService.getRecent(token, exchange, timeframe, 100);
  if (!candles || candles.length < 30) return null;

  // ... existing EMA9/EMA21/RSI14/MACD/Bollinger/ROC10 computation moved here ...
  // For the alignment object (which currently uses the SETUP direction):
  // when called standalone (no setup), align against price direction:
  const lastClose = candles[candles.length - 1].close;
  const prevClose = candles[candles.length - 2].close;
  const direction: 'BUY' | 'SELL' = lastClose >= prevClose ? 'BUY' : 'SELL';

  return buildIndicatorReadings(candles, direction);  // refactor existing inline code into this helper
}
```

`analyze()` now calls `await this.computeIndicatorsFor(token, exchange, tf)` (or — better — call the same internal `buildIndicatorReadings` helper directly so it doesn't re-fetch candles it already has). Keep the existing behavior 1:1 — this refactor must not change what `analyze()` returns.

- [ ] **Step 2:** Quick smoke test of the refactor: trigger an analyze on a known token and confirm the `setupContext.indicators` payload is byte-identical to before. Run the existing `level-book.service.spec.ts` and `setup-tracker.service.spec.ts` to make sure nothing in the signal pipeline regressed.

```bash
cd apps/api
npx jest --testPathPattern="signal-generator" --silent 2>&1 | tail -10
```

- [ ] **Step 3:** Add the controller route in `signal-generator.controller.ts`:

```typescript
@Get('indicators')
async getIndicators(
  @Query('token') token: string,
  @Query('exchange') exchange: string,
  @Query('timeframe') timeframe: string,
): Promise<{ indicators: IndicatorReadings | null }> {
  if (!token || !exchange || !timeframe) {
    throw new BadRequestException('token, exchange, timeframe are required');
  }
  const indicators = await this.signalGen.computeIndicatorsFor(token, exchange, timeframe);
  return { indicators };
}
```

- [ ] **Step 4:** Smoke-test:

```bash
curl "http://127.0.0.1:4001/api/signals/indicators?token=3045&exchange=NSE&timeframe=15m"
# expect: { "indicators": { "ema9": ..., "rsi14": ..., ... } }
```

- [ ] **Step 5:** Commit.

```bash
git add apps/api/src/modules/signal-generator/
git commit -m "$(cat <<'EOF'
feat(signals): GET /signals/indicators (standalone indicator readings)

Extracts the EMA/RSI/MACD/BB/ROC computation from analyze() into a
public computeIndicatorsFor() method on SignalGeneratorService. analyze()
keeps using the same code path so the setup pipeline is byte-compat.
A new thin controller route exposes it for the IndicatorsCard, which
needs indicators even when no setup is active.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task F1 — ChartsPage layout: 70vh chart + StockOverviewPanel below

**Files:**
- Modify: `apps/web/src/pages/charts/ChartsPage.tsx`
- Create: `apps/web/src/components/stock-overview/StockOverviewPanel.tsx`

- [ ] **Step 1:** Open `ChartsPage.tsx`. Find the existing chart container (the `<div>` that wraps `<TradingChart>` or whatever the chart component is). Change its height to `70vh` (use Tailwind `h-[70vh]` or inline style — match the existing styling approach).

- [ ] **Step 2:** Remove the floating `<AnalysisPanel>` mount (currently at line ~290-292). Below the chart container, add:

```tsx
<StockOverviewPanel
  token={token}
  exchange={exchange}
  symbol={symbol}
  timeframe={timeframe}
  analysis={analysis}
  analysisLoading={analysisLoading}
/>
```

- [ ] **Step 3:** Create the orchestrator with all 7 cards stubbed initially as `<div>Card N placeholder</div>` so we can verify layout before each card lands:

```tsx
// apps/web/src/components/stock-overview/StockOverviewPanel.tsx
import type { AnalysisDto } from '@/components/charts/AnalysisPanel';

interface Props {
  token: string;
  exchange: string;
  symbol: string;
  timeframe: string;
  analysis: AnalysisDto | null;
  analysisLoading: boolean;
}

export default function StockOverviewPanel(props: Props) {
  return (
    <div className="flex flex-col gap-4 mt-4 max-w-full">
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">Card 1: Setup & Context (placeholder)</div>
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">Card 2: Live Quote (placeholder)</div>
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">Card 3: Market Depth (placeholder)</div>
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">Card 4: Indicators (placeholder)</div>
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">Card 5: Options Chain Preview (placeholder)</div>
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">Card 6: News (placeholder)</div>
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">Card 7: Fundamentals (placeholder)</div>
    </div>
  );
}
```

- [ ] **Step 4:** Open the page in the browser. Verify:
  - Chart takes ~70vh, no floating overlay.
  - 7 placeholder cards render below in a stack.
  - Page scrolls.
  - Window resize: chart re-fits to its container (existing chart-resize hook should handle this; if it doesn't, check `useChartData` for a resize observer that needs updating to the new container).

- [ ] **Step 5:** Commit.

```bash
git add apps/web/src/pages/charts/ChartsPage.tsx apps/web/src/components/stock-overview/StockOverviewPanel.tsx
git commit -m "$(cat <<'EOF'
refactor(web): ChartsPage 70vh chart + StockOverviewPanel scaffold

Layout shift: chart goes to 70vh full-width, scrollable info panel
below in stacked cards. Placeholders only — cards land in subsequent
commits. AnalysisPanel floating overlay is removed in this commit
(its body becomes Card 1 in the next task).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task F2 — SetupContextCard (extract AnalysisPanel body)

**Files:**
- Create: `apps/web/src/components/stock-overview/SetupContextCard.tsx`
- Modify: `apps/web/src/components/stock-overview/StockOverviewPanel.tsx`
- Delete (or keep until verified): `apps/web/src/components/charts/AnalysisPanel.tsx`

- [ ] **Step 1:** Copy the body of `AnalysisPanel.tsx` (everything inside the draggable wrapper) into a new `SetupContextCard.tsx`. Strip out:
  - The drag wrapper / position state / mouse handlers
  - `position: absolute` styling
  - `top-4 right-4` etc.

The new component takes `{ analysis, loading }` props (same as before) and renders inside a normal card container — same `bg-zinc-900/50 border border-zinc-800 rounded-lg p-4` shell as the other cards.

- [ ] **Step 2:** Preserve everything else exactly: the Setup section (entry/SL/target/TP1 with obstacle subtitle, RR bar, grade) AND the Market Context section (score, tier, coverage, factor breakdown — landed in commit `b1470aa`). These render inside the card body in the existing order.

- [ ] **Step 3:** When `analysis?.kind !== 'setup'`, render a compact "No active setup" placeholder inside the card so the slot is consistent.

```tsx
{analysis?.kind === 'setup' ? (
  <SetupBody analysis={analysis} />
) : (
  <p className="text-sm text-zinc-500">No active setup on this instrument right now.</p>
)}
```

- [ ] **Step 4:** Wire into the orchestrator — replace placeholder Card 1 with `<SetupContextCard analysis={analysis} loading={analysisLoading} />`.

- [ ] **Step 5:** Visual check in the browser. Use a symbol that has an active setup (or trigger one via the universe scanner) — verify the card shows entry/SL/target AND the Market Context section with score/tier/factors.

- [ ] **Step 6:** Once verified, delete `apps/web/src/components/charts/AnalysisPanel.tsx`. Verify no remaining imports:

```bash
cd apps/web
grep -r "AnalysisPanel" src/ --include="*.tsx" --include="*.ts"
```

If anything still imports it (e.g. tests), update or remove those references.

- [ ] **Step 7:** Commit.

```bash
git add apps/web/src/components/stock-overview/SetupContextCard.tsx \
        apps/web/src/components/stock-overview/StockOverviewPanel.tsx
git rm apps/web/src/components/charts/AnalysisPanel.tsx
git commit -m "$(cat <<'EOF'
refactor(web): AnalysisPanel → SetupContextCard (no longer floating)

Lifts the AnalysisPanel body into Card 1 of the StockOverviewPanel,
keeping the setup details + Market Context block intact. Drag wrapper
is gone — the card is now in normal document flow. Old file deleted
once nothing imports it.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task F3 — LiveQuoteCard

**Files:**
- Create: `apps/web/src/components/stock-overview/LiveQuoteCard.tsx`
- Modify: `apps/web/src/components/stock-overview/StockOverviewPanel.tsx`

- [ ] **Step 1:** Read `apps/web/src/hooks/useMarketData.ts` to understand the existing quote/tick API. Confirm it exposes a quote per token (LTP, change, OHLC, volume). After Task B1 it should also include `vwap`.

- [ ] **Step 2:** Create `LiveQuoteCard.tsx`:

```tsx
import type { Quote } from '@td/shared/types';
import { useMarketData } from '@/hooks/useMarketData';

interface Props { token: string; exchange: string; symbol: string; }

export default function LiveQuoteCard({ token, exchange, symbol }: Props) {
  const { quotes } = useMarketData();  // adapt to actual hook API
  const q: Quote | undefined = quotes[token];

  if (!q) return <Card title="Live Quote"><p className="text-sm text-zinc-500">Loading…</p></Card>;

  const positive = q.change >= 0;
  const rangePct = q.high === q.low ? 0 : ((q.ltp - q.low) / (q.high - q.low)) * 100;

  return (
    <Card title="Live Quote">
      <div className="flex flex-wrap gap-x-8 gap-y-2 items-baseline">
        <div className={`text-3xl font-semibold ${positive ? 'text-green-400' : 'text-red-400'}`}>
          {q.ltp.toFixed(2)}
        </div>
        <div className={`text-sm ${positive ? 'text-green-400' : 'text-red-400'}`}>
          {positive ? '+' : ''}{q.change.toFixed(2)} ({q.changePercent.toFixed(2)}%)
        </div>
        <Stat label="Day H" value={q.high.toFixed(2)} />
        <Stat label="Day L" value={q.low.toFixed(2)} />
        <Stat label="Open" value={q.open.toFixed(2)} />
        <Stat label="Prev Close" value={q.close.toFixed(2)} />
        {q.vwap !== undefined && <Stat label="VWAP" value={q.vwap.toFixed(2)} />}
        <Stat label="Volume" value={q.volume.toLocaleString()} />
      </div>
      {/* range bar — LTP position within day H/L */}
      <div className="mt-3">
        <div className="relative h-1 bg-zinc-700 rounded-full">
          <div
            className="absolute top-1/2 -translate-y-1/2 w-2 h-3 bg-blue-400 rounded-sm"
            style={{ left: `${rangePct}%` }}
          />
        </div>
        <div className="flex justify-between text-xs text-zinc-500 mt-1">
          <span>{q.low.toFixed(2)}</span>
          <span>{q.high.toFixed(2)}</span>
        </div>
      </div>
    </Card>
  );
}

// Re-usable Card and Stat (pull into a shared file if you build more)
function Card({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-zinc-300">{title}</h3>
        {action}
      </div>
      {children}
    </div>
  );
}
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="text-sm text-zinc-200">{value}</div>
    </div>
  );
}
```

(Move `Card` and `Stat` to `apps/web/src/components/stock-overview/_shared.tsx` so the other cards can reuse them. Do this on first need — don't pre-build.)

- [ ] **Step 3:** Wire into the orchestrator. Visual check: confirm LTP, change, OHLC, VWAP all render.

- [ ] **Step 4:** Commit.

```bash
git add apps/web/src/components/stock-overview/
git commit -m "feat(web): LiveQuoteCard with VWAP + day range bar

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task F4 — MarketDepthCard + useMarketDepth hook

**Files:**
- Create: `apps/web/src/hooks/useMarketDepth.ts`
- Create: `apps/web/src/components/stock-overview/MarketDepthCard.tsx`
- Modify: `apps/web/src/components/stock-overview/StockOverviewPanel.tsx`

- [ ] **Step 1:** Create the hook with 2s polling:

```typescript
// apps/web/src/hooks/useMarketDepth.ts
import { useEffect, useRef, useState } from 'react';
import api from '@/services/api';
import type { MarketDepth } from '@td/shared/types';

export function useMarketDepth(token: string, exchange: string) {
  const [depth, setDepth] = useState<MarketDepth | null>(null);
  const [loading, setLoading] = useState(false);
  const cancelRef = useRef(false);

  useEffect(() => {
    if (!token || token === '0' || !exchange) {
      setDepth(null);
      return;
    }
    cancelRef.current = false;
    setLoading(true);

    const fetch = async () => {
      try {
        const r = await api.get<{ depth: MarketDepth | null }>(
          `/market-data/instruments/${token}/depth`,
          { params: { exchange } },
        );
        if (!cancelRef.current) setDepth(r.data.depth);
      } catch {
        if (!cancelRef.current) setDepth(null);
      } finally {
        if (!cancelRef.current) setLoading(false);
      }
    };

    fetch();
    const id = setInterval(fetch, 2000);
    return () => { cancelRef.current = true; clearInterval(id); };
  }, [token, exchange]);

  return { depth, loading };
}
```

- [ ] **Step 2:** Create the card. Hide for indices (NFO/MCX/BSE — anywhere depth is meaningless). Quick check: `exchange === 'NSE' || exchange === 'BSE'` AND not an index — but the simplest gate is "render the card; if depth is null after first fetch, show 'Depth unavailable'".

```tsx
import { useMarketDepth } from '@/hooks/useMarketDepth';
import { Card } from './_shared';

export default function MarketDepthCard({ token, exchange }: { token: string; exchange: string }) {
  const { depth, loading } = useMarketDepth(token, exchange);

  // Hide for index exchanges (no depth concept)
  if (exchange === 'NSE_INDEX' || exchange === 'BSE_INDEX') return null;

  return (
    <Card title="Market Depth">
      {!depth && loading && <p className="text-sm text-zinc-500">Loading depth…</p>}
      {!depth && !loading && <p className="text-sm text-zinc-500">Depth unavailable.</p>}
      {depth && (
        <div className="grid grid-cols-2 gap-4">
          <DepthLadder side="BID" levels={depth.bids} total={depth.totalBidQty} />
          <DepthLadder side="ASK" levels={depth.asks} total={depth.totalAskQty} />
        </div>
      )}
    </Card>
  );
}

function DepthLadder({ side, levels, total }: { side: 'BID' | 'ASK'; levels: any[]; total: number }) {
  const tone = side === 'BID' ? 'text-green-400' : 'text-red-400';
  return (
    <div>
      <div className={`text-xs font-semibold mb-2 ${tone}`}>{side}</div>
      <table className="w-full text-xs">
        <thead className="text-zinc-500">
          <tr><th className="text-left">Price</th><th className="text-right">Qty</th><th className="text-right">Orders</th></tr>
        </thead>
        <tbody>
          {levels.map((l, i) => (
            <tr key={i}>
              <td className={tone}>{l.price.toFixed(2)}</td>
              <td className="text-right text-zinc-300">{l.qty.toLocaleString()}</td>
              <td className="text-right text-zinc-500">{l.orders}</td>
            </tr>
          ))}
        </tbody>
        <tfoot className="text-zinc-400 border-t border-zinc-800">
          <tr><td>Total</td><td className="text-right" colSpan={2}>{total.toLocaleString()}</td></tr>
        </tfoot>
      </table>
    </div>
  );
}
```

- [ ] **Step 3:** Wire + visual check.

- [ ] **Step 4:** Commit.

```bash
git commit -am "feat(web): MarketDepthCard (REST poll 2s, 5-level ladder)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task F5 — IndicatorsCard + useIndicators hook

**Files:**
- Create: `apps/web/src/hooks/useIndicators.ts`
- Create: `apps/web/src/components/stock-overview/IndicatorsCard.tsx`

- [ ] **Step 1:** Hook (refetches when token or timeframe changes):

```typescript
import { useEffect, useState } from 'react';
import api from '@/services/api';
import type { IndicatorReadings } from '@/types';  // mirror from backend

export function useIndicators(token: string, exchange: string, timeframe: string) {
  const [indicators, setIndicators] = useState<IndicatorReadings | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!token || token === '0') return;
    setLoading(true);
    let cancelled = false;
    api.get<{ indicators: IndicatorReadings | null }>('/signals/indicators', {
      params: { token, exchange, timeframe },
    })
      .then(r => { if (!cancelled) setIndicators(r.data.indicators); })
      .catch(() => { if (!cancelled) setIndicators(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [token, exchange, timeframe]);

  return { indicators, loading };
}
```

- [ ] **Step 2:** Card. Inline strip with 5 chips. Color tone driven by `alignment.<key>` from the `IndicatorReadings`.

```tsx
import { useIndicators } from '@/hooks/useIndicators';
import { Card } from './_shared';

export default function IndicatorsCard({ token, exchange, timeframe }: { token: string; exchange: string; timeframe: string }) {
  const { indicators: ind, loading } = useIndicators(token, exchange, timeframe);
  if (!ind && !loading) return <Card title="Indicators"><p className="text-sm text-zinc-500">Indicators unavailable.</p></Card>;
  if (!ind) return <Card title="Indicators"><p className="text-sm text-zinc-500">Loading…</p></Card>;

  return (
    <Card title="Indicators">
      <div className="flex flex-wrap gap-2">
        <Chip label="RSI14" value={ind.rsi14?.toFixed(1) ?? '—'} alignment={ind.alignment.rsi} />
        <Chip label="MACD-H" value={ind.macdHistogram?.toFixed(2) ?? '—'} alignment={ind.alignment.macd} />
        <Chip label="EMA9/21" value={ind.ema9 != null && ind.ema21 != null ? (ind.ema9 > ind.ema21 ? '↑' : '↓') : '—'} alignment={ind.alignment.ema} />
        <Chip label="BB pos" value={ind.bollingerPosition?.toFixed(2) ?? '—'} alignment={ind.alignment.bollinger} />
        <Chip label="ROC10" value={ind.roc10 != null ? `${ind.roc10.toFixed(1)}%` : '—'} alignment={ind.alignment.momentum} />
      </div>
      <div className="text-xs text-zinc-500 mt-2">Agreement: {ind.agreement} / 5</div>
    </Card>
  );
}

function Chip({ label, value, alignment }: { label: string; value: string; alignment: 1 | 0 | -1 }) {
  const tone = alignment === 1 ? 'border-green-700 text-green-300' : alignment === -1 ? 'border-red-700 text-red-300' : 'border-zinc-700 text-zinc-300';
  return (
    <div className={`px-2 py-1 rounded-md border text-xs ${tone}`}>
      <span className="text-zinc-500 mr-2">{label}</span>{value}
    </div>
  );
}
```

- [ ] **Step 3:** Wire + visual check across timeframes (1m / 5m / 15m / 1h). Confirm refetch on TF switch.

- [ ] **Step 4:** Commit.

```bash
git commit -am "feat(web): IndicatorsCard (RSI/MACD/EMA/BB/ROC chips)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task F6 — OptionsChainPreviewCard

**Files:**
- Create: `apps/web/src/components/stock-overview/OptionsChainPreviewCard.tsx`

- [ ] **Step 1:** Read `apps/web/src/hooks/useOptionsChain.ts` to see how the existing chain hook is shaped. It probably takes `(underlying, expiry)` and returns `{ chain, expiries, loading }`.

- [ ] **Step 2:** Build the card. It must:
  - Hide entirely if the symbol is not an F&O underlying. Detection fallback: hide if `useOptionsChain` returns `chain.length === 0` after loading.
  - Use the nearest expiry (first item from `expiries`).
  - Find ATM strike (closest strike to LTP). Slice ATM ± 3 strikes (7 rows).
  - Render mini-table: CE LTP | CE OI Δ | Strike | PE OI Δ | PE LTP. ATM row highlighted.
  - Footer: `<Link to="/options/<underlying>">View full chain →</Link>`

```tsx
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useOptionsChain } from '@/hooks/useOptionsChain';
import { useMarketData } from '@/hooks/useMarketData';
import { Card } from './_shared';

export default function OptionsChainPreviewCard({ symbol, token }: { symbol: string; token: string }) {
  const { quotes } = useMarketData();
  const ltp = quotes[token]?.ltp;
  const { chain, expiries, loading } = useOptionsChain(symbol);
  const expiry = expiries?.[0];

  const slice = useMemo(() => {
    if (!chain || chain.length === 0 || ltp == null) return [];
    const sorted = [...chain].sort((a, b) => a.strike - b.strike);
    const atmIdx = sorted.reduce((best, row, i) =>
      Math.abs(row.strike - ltp) < Math.abs(sorted[best].strike - ltp) ? i : best, 0);
    return sorted.slice(Math.max(0, atmIdx - 3), atmIdx + 4);
  }, [chain, ltp]);

  if (loading) return <Card title="Options Chain"><p className="text-sm text-zinc-500">Loading…</p></Card>;
  if (!chain || chain.length === 0) return null;  // not F&O — hide

  return (
    <Card
      title={`Options Chain — ${expiry ?? ''}`}
      action={<Link to={`/options/${symbol}`} className="text-xs text-blue-400">View full chain →</Link>}
    >
      <table className="w-full text-xs">
        <thead className="text-zinc-500">
          <tr>
            <th className="text-right">CE LTP</th>
            <th className="text-right">CE OI Δ</th>
            <th className="text-center">Strike</th>
            <th className="text-right">PE OI Δ</th>
            <th className="text-right">PE LTP</th>
          </tr>
        </thead>
        <tbody>
          {slice.map((row) => {
            const isAtm = ltp != null && Math.abs(row.strike - ltp) === Math.min(...slice.map(s => Math.abs(s.strike - ltp)));
            return (
              <tr key={row.strike} className={isAtm ? 'bg-blue-900/30' : ''}>
                <td className="text-right text-green-300">{row.ce?.ltp?.toFixed(2) ?? '—'}</td>
                <td className="text-right text-zinc-400">{row.ce?.oiChange?.toLocaleString() ?? '—'}</td>
                <td className="text-center text-zinc-200 font-medium">{row.strike}</td>
                <td className="text-right text-zinc-400">{row.pe?.oiChange?.toLocaleString() ?? '—'}</td>
                <td className="text-right text-red-300">{row.pe?.ltp?.toFixed(2) ?? '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}
```

(Adjust property names to match the actual `OptionsChainEntry` / `OptionData` types from the codebase — the implementer should grep for these and align.)

- [ ] **Step 3:** Wire + visual check on RELIANCE (F&O underlying) and on NIFTY (also F&O index — should show). On a non-F&O cash-only stock (e.g. small-cap), confirm the card hides.

- [ ] **Step 4:** Commit.

```bash
git commit -am "feat(web): OptionsChainPreviewCard (ATM ± 3, F&O only)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task F7 — SymbolNewsCard

**Files:**
- Create: `apps/web/src/components/stock-overview/SymbolNewsCard.tsx`

- [ ] **Step 1:** Read `apps/web/src/hooks/useNews.ts` and `/api/news/symbol/:symbol` shape. Likely returns `{ news: NewsItem[] }`.

- [ ] **Step 2:** Card:

```tsx
import { useNews } from '@/hooks/useNews';
import { Link } from 'react-router-dom';
import { Card } from './_shared';

export default function SymbolNewsCard({ symbol }: { symbol: string }) {
  const { news, loading } = useNews({ symbol, limit: 10 });
  if (loading) return <Card title="News"><p className="text-sm text-zinc-500">Loading…</p></Card>;
  if (!news || news.length === 0) {
    return <Card title="News"><p className="text-sm text-zinc-500">No recent news for {symbol}.</p></Card>;
  }

  return (
    <Card title="News" action={<Link to={`/news?symbol=${symbol}`} className="text-xs text-blue-400">View all →</Link>}>
      <ul className="space-y-2">
        {news.slice(0, 10).map(n => (
          <li key={n.id} className="text-sm">
            <a href={n.url} target="_blank" rel="noreferrer" className="text-zinc-200 hover:text-blue-400">
              {n.headline}
            </a>
            <div className="text-xs text-zinc-500 mt-0.5">
              {n.source} · {timeAgo(n.publishedAt)}
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
```

(Field names — `id`, `url`, `headline`, `source`, `publishedAt` — must match the actual `NewsItem` type. Implementer to verify.)

- [ ] **Step 3:** Wire + visual check. Test with both a high-news symbol (RELIANCE) and a low-news symbol.

- [ ] **Step 4:** Commit.

```bash
git commit -am "feat(web): SymbolNewsCard (last 10 headlines, symbol-filtered)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task F8 — FundamentalsStubCard

**Files:**
- Create: `apps/web/src/components/stock-overview/FundamentalsStubCard.tsx`

- [ ] **Step 1:** Pure stub. No data, no hooks.

```tsx
import { Card } from './_shared';

const FIELDS: { label: string }[] = [
  { label: 'Sector' },
  { label: 'Industry' },
  { label: 'Market Cap' },
  { label: 'P/E' },
  { label: 'P/B' },
  { label: 'EPS' },
  { label: 'ROE' },
  { label: 'Debt / Equity' },
];

export default function FundamentalsStubCard() {
  return (
    <Card
      title="Fundamentals"
      action={<span className="text-xs text-zinc-500 italic">Coming soon</span>}
    >
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {FIELDS.map(f => (
          <div key={f.label}>
            <div className="text-xs text-zinc-500">{f.label}</div>
            <div className="text-sm text-zinc-400">—</div>
          </div>
        ))}
      </div>
    </Card>
  );
}
```

- [ ] **Step 2:** Wire + visual check.

- [ ] **Step 3:** Commit.

```bash
git commit -am "feat(web): FundamentalsStubCard (placeholder grid, 'Coming soon')

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task F9 — Final integration + polish

**Files:**
- Modify: `apps/web/src/components/stock-overview/StockOverviewPanel.tsx`

- [ ] **Step 1:** Confirm all 7 cards are wired in order:

```tsx
<div className="flex flex-col gap-4 mt-4 max-w-full">
  <SetupContextCard analysis={analysis} loading={analysisLoading} />
  <LiveQuoteCard token={token} exchange={exchange} symbol={symbol} />
  <MarketDepthCard token={token} exchange={exchange} />
  <IndicatorsCard token={token} exchange={exchange} timeframe={timeframe} />
  <OptionsChainPreviewCard symbol={symbol} token={token} />
  <SymbolNewsCard symbol={symbol} />
  <FundamentalsStubCard />
</div>
```

- [ ] **Step 2:** Smoke-test matrix:
  - **NIFTY (index, F&O)** — Setup card may or may not have a setup; Quote OK; Depth: hidden or "unavailable"; Indicators OK; Options OK (NIFTY chain); News OK; Fundamentals stub.
  - **RELIANCE (cash + F&O)** — all cards present.
  - **A small-cap cash-only stock** — Options card hidden, others present.
  - **Symbol switch** — all cards refetch with new symbol/token.
  - **Timeframe switch** — Indicators card refetches; others unaffected.

- [ ] **Step 3:** Filtered typecheck:

```bash
cd apps/web
npx tsc --noEmit 2>&1 | grep -E "stock-overview|ChartsPage|hooks/(useMarketDepth|useIndicators)" | head -20
```

Expected: zero errors in those paths.

- [ ] **Step 4:** Final commit:

```bash
git commit -am "feat(web): wire all 7 cards in StockOverviewPanel + final polish

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Self-review

- [x] Spec coverage: every section in the spec maps to a task (B1=vwap, B2=depth, B3=indicators endpoint, F1=layout, F2=Setup card, F3=Quote, F4=Depth, F5=Indicators, F6=Options, F7=News, F8=Fundamentals stub, F9=integration).
- [x] Placeholder scan: code blocks present for every step that changes code; no "TBD" / "fill in details" / "similar to Task N".
- [x] Type consistency: `Quote` extension named `vwap?: number` consistently; `MarketDepth` shape stable across backend types and frontend hook.
- [x] One known-unknown: exact Angel One depth response shape in Step B2.3 — the plan flags this and tells the implementer to log a sample if uncertain.
