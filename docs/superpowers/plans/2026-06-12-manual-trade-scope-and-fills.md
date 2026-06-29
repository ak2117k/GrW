# Manual-Trade Scope + ₹0-Fill Fix — Plan

> Branch `worktree-fix+manual-trade-scope-and-fills`. Off `main` @ d448426.

## Problem (root-caused)
The manual-trade page mixes user orders with Chartink/watch auto-trades, shows wrong capital, and a top/bottom position mismatch.
- Chartink alerts reach the trade-engine ONLY via the gated-watch track (`watch.service.ts:498` → `trade.executeTrade`). ungated/adaptive/intraday/swing use their own tables.
- `entryPrice` fills at **₹0** for symbols with no live quote (paper sim uses live price; MARKET has no fallback). `trade-execution.service.ts:147` logs the error but persists anyway.
- Top Positions/capital read the in-memory **position-manager** (`getCapitalDeployed`), which only holds trades that passed the `&& entryPrice` guard at `trade-execution.service.ts:237` → only the one non-₹0 (RELIANCE) trade. Bottom reads the DB (all). Hence divergence + wrong capital.

## Decisions
- Keep the watch track executing as-is. **Scope the manual-trade page to MANUAL trades only.**
- Reject paper orders that can't resolve a real fill price (no silent ₹0).
- Derive the manual-trade page's positions + count + capital-deployed from the fetched MANUAL open trades (one source = DB), not the position-manager.

## Contract (frozen; FE+BE rely on it)
`GET /api/trades/open?source=MANUAL` → only `Trade` rows with `source = 'MANUAL'`. Omitted `source` ⇒ unchanged (all open trades) so other consumers are unaffected. Trade rows gain a `source` field: `MANUAL | WATCH | AUTO | SCANNER`.

---

## Stream BE (apps/api only)

### Task 1 — schema: add `source`
- `prisma/schema.prisma` Trade model: add `source String @default("MANUAL")` and `@@index([source])`.
- Run `npx prisma generate --schema prisma/schema.prisma` then `npx prisma db push --schema prisma/schema.prisma` (NEVER `migrate dev`). Additive column w/ default → backfills existing rows to `MANUAL` (acceptable; the stray Chartink rows are being deleted in cleanup).

### Task 2 — thread `source` through execution
- `OrderRequest` interface + `ExecuteTradeDto` (`dto/trade.dto.ts`): add optional `source?: 'MANUAL'|'WATCH'|'AUTO'|'SCANNER'`.
- `trade-execution.service.ts executeTrade`: accept `request.source ?? 'MANUAL'`; pass to `tradeRepository.createTrade({... source})`.
- `trade.repository.ts createTrade`: persist `source`.
- Tag call sites:
  - Manual controller path → default `'MANUAL'` (no change needed; default covers it).
  - `watch.service.ts:498` executeTrade call → add `source: 'WATCH'`.
  - `auto-trade.service.ts` executeTrade calls → `source: 'AUTO'`.
  - `universe-scanner.worker.ts:378` → `source: 'SCANNER'`.

### Task 3 — reject ₹0 paper fills
- `trade-execution.service.ts` ~147: replace the "log error but continue" with: if `isPaperTrade && initialStatus==='OPEN' && (!entryPrice || entryPrice<=0)` → throw `BadRequestException('No live price available for ${symbol} — cannot place a MARKET paper order at ₹0. Try a LIMIT order or wait for a live quote.')` BEFORE creating the trade row. (Live path already 503s without adapter.)
- Tests: paper MARKET with fillPrice 0 and no request.price ⇒ throws, no trade created; paper with valid fillPrice ⇒ trade created with that entryPrice; LIMIT with request.price and 0 LTP ⇒ fills at request.price (no throw).

### Task 4 — `source` filter on open trades
- `trade.repository.ts getOpenTrades(source?)` → `where: { status:'OPEN', ...(source?{source}:{}) }`.
- `trade-engine.controller.ts` `GET /trades/open` → `@Query('source') source?` passed through. (Optional; default unchanged.)
- Test: `getOpenTrades('MANUAL')` filters; no arg returns all.

Run `pnpm --filter @td/api test -- trade-engine` — green (allow the known pre-existing watch hard-loss-cut reds elsewhere).

---

## Stream FE (apps/web only)

### Task 5 — manual-trade page = MANUAL only, single source
- `stores/trade-store.ts`:
  - `fetchOpenTrades` → `api.get('/trades/open', { params:{ source:'MANUAL' } })`.
  - Derive positions for the top panel + capital-deployed from `openTrades` (sum `entryPrice*quantity`) instead of `/trades/positions`. Add a selector/derived value `manualCapitalDeployed` and `manualPositions` from `openTrades`.
- `pages/manual-trade/ManualTradePage.tsx` + `RiskStrip`/`PositionsPanel`:
  - Capital Deployed + position count come from the derived MANUAL `openTrades` (fixes ₹ and the "1 vs 5"). Keep `capitalLimit`/`dailyLossLimit` from `/trades/risk-status`.
  - Top PositionsPanel lists the MANUAL `openTrades` (with live LTP from the existing tick WS for P&L), so top and bottom match.
- `npx tsc --noEmit` clean.

---

## Data cleanup (after BE merged + running, manual step)
Delete the non-manual + ₹0 garbage open trades so the ledger reads clean. Done via a one-off script/SQL against the running DB once `source` exists: close/mark or delete OPEN trades where `source != 'MANUAL'` OR `entryPrice = 0` that aren't genuine user orders. Confirm the exact set with the user before deleting.

## Out of scope
Disabling watch execution; the live-order 503 / live-confirm gate (tracked separately); position-manager refactor (frontend now derives manual positions itself).
