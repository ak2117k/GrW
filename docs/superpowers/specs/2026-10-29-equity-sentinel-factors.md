# Equity sentinel factors: research and build spec (2026-10-29)

Status: research output, builder-ready. No code changed.
Scope: extend the trade sentinel (`apps/api/src/modules/trade-sentinel/`) from F&O to **cash-equity intraday** positions (NSE/BSE, `EQ_INTRADAY`). `EQ_DELIVERY` stays out of the roster (`services/roster.service.ts:208-211`), so overnight/T+1 factors are listed but deferred.

Owner rule: "same logic as futures; equity just has lower volatility; add other factors." The way to honour that is to keep the exact futures pipeline and **express every threshold and every new factor in noise units N** (the stock's own 1-minute ATR), so lower volatility is absorbed by N rather than by a second rulebook.

Prior research applies (memory: stock daily model spike, NIFTY pattern spike). Direction is a coin flip. Volatility and expected-move context work. So every factor below is there to answer one of three exit questions, never "which way next":
1. Is this move **noise or a regime change**? (size vs N, range used vs ATR, volume)
2. Is there a **hard deadline or mechanical limit**? (square-off, circuit band, event)
3. Is this **the stock or the market**? (relative strength): a market-wide drop and a stock-specific breakdown are different exits.

File references are to the working tree on 2026-10-29. `judge-gate.ts` and `sentinel-cycle.service.ts` have an uncommitted peer diff (adds `adverseMovePctEq`), so their line numbers are the working-tree ones.

---

## 1. What the packet already gives the judge

Packet type: `services/context-packet.service.ts:453-581`. Builder: `build()` at `:1122-1417`. Prompt field list: `prompts/sentinel-system-prompt.ts:308-316`.

| Block | Source | Cash behaviour today | F&O-only / derivative-scaled? |
|---|---|---|---|
| `position.*` (ltp, underlyingLtp, expiry) | tick source | `underlyingLtp = ltp`, source `SPOT_SOURCE_CASH` (`adapters/tick-source.adapter.ts:386-388`); `expiry` null for cash (`:810-811`) | SCALE HAZARD text (`prompt:321`) is moot for cash, but harmless |
| `money.*` (netPnl, charges, green floor, mfe/mae) | `computeGreenFloor` (`context-packet.service.ts:1134-1140`) | Cash POSITION is charged as intraday (`charges.ts:53-58, 83`) | Fixed-basis floor = breakeven + ₹150 (`charges.ts:100`): rupee-fixed, not volatility-scaled |
| `structure.levelBook / nearestSupport / nearestResistance` | 15m level book via `SentinelChartContextAdapter` (`adapters/chart-context.adapter.ts:34-37`), cached 60 s (`:44`) | Works for cash: `structureSymbol = row.symbol` (`tick-source.adapter.ts:410`). Book carries `pdh, pdl, prevClose, orh, orl, vwap, todayHigh, todayLow, atr14 (DAILY)` (`signal-generator/types/level-book.types.ts:6-46`) | No |
| `flow.volumeRatio` | last closed 15m bar vs 20-bar median (`tripwires/types.ts:43`, `context-packet.service.ts:1307-1315`) | Works | No, but time-of-day biased (see §5) |
| `flow.oiWalls` | `OiWallSnapshotService` via `wallsFor` (`services/sentinel-cycle.service.ts:1486-1516`) | Never captured: `wallsFor` returns null when `tick.expiry` is null (`:1491`) | F&O-only. **Bug in the reason:** the packet then says `'no options chain for this symbol, so no OI walls'` (`context-packet.service.ts:1316-1318`), which is false for every F&O stock (RELIANCE-EQ has a chain). The honest reason is "OI walls are not captured for cash positions" |
| `flow.noiseUnit` | `noiseFor` (`tick-source.adapter.ts:507-532`), `noiseUnitBlock` (`context-packet.service.ts:673-695`) | Cash: `contract = underlying1m =` the stock's own 1m ATR14 from hub `candles_1m` (`tick-source.adapter.ts:523-524`). Without hub bars, only `underlying` falls back to daily ATR14/sqrt(375) (`context-packet.service.ts:679-685`, `exit-discipline/noise.ts:39-48`); `contract` stays null | See §5: the null `contract` N for cash disables the noise floor and noise giveback |
| `macro.fiiDii`, `macro.globalCues`, `macro.realFactors` | market-cues cache (`:763-883`), level-engine factors (`:1338-1350`) | Works (market-wide) | `realFactors` = greeks/mtfTrend/volatility (`tripwires/context-factor-flip.tripwire.ts:15`); `greeks` is option-only |
| `macro.sector` | stub, always absent (`context-packet.service.ts:1333`; prompt `:329`) | Absent | Candidate to fill for cash (§3, F5) |
| `news.*`, `events.*` | legacy aggregator, or news-events v2 when `NEWS_EVENTS_V2_ENABLED=true` (`:1173`, `:1352-1365`) | Works; events include results, board meetings and ex-dates for the company (`news-events/events/nse-events.ts:26-57`) | No |
| `stockMove` | nightly big-move book, behind `MBM_PACKET` / tunable `mbm.packet` (`:1033-1058`) | Cash stocks get P(big 5-session move), bucket, next results date (`services/market-behaviour-block.ts:87-113`) | No. Hidden from the judge unless MBM_PACKET=on |
| `marketBehaviour` | MBM, NIFTY-mapped only (`:1003-1026`) | Not for a stock | NIFTY-only |
| `session.minutesToClose` | `minutesToSessionClose` (`:180-220`) | Counts to **15:30** NSE close | **Wrong deadline for MIS**: Angel squares off intraday equity at **15:15** (§2) |
| `trigger`, `memory`, `sinceLastVerdict`, `ownerHold` | cycle | Works | No |

Sensors (tripwires, `tripwires/*.ts`): `giveback-off-peak` (40 % fallback, `giveback-off-peak.tripwire.ts:9`; noise rule when `input.noise` set, `:35-45`), `level-break` (`level-break.tripwire.ts:13-35`), `volume-anomaly` (ratio ≥ 2, `volume-anomaly.tripwire.ts:7`), `news-hit`, `event-near`, `oi-wall-shift` (0.2 %, F&O-only, silent for cash), `context-factor-flip`, `exit-confirm`.

Execution: equity is **observe-only by construction**. The auto-exit executor acts only on NFO/BFO/MCX (`roster.service.ts:81-84, 196-201`). Verdicts on cash are recorded and scored, never executed. The factors below therefore improve judgement quality and the night review, not order flow, until the owner widens `AUTO_EXIT_EXCHANGES`.

---

## 2. Research: what matters for exiting an Indian cash-equity intraday position

| Candidate | Why it matters for an EXIT (not direction) | Verdict |
|---|---|---|
| **MIS square-off deadline** | Angel One auto-squares intraday equity at **15:15 IST** (F&O 15:20, currency 16:45) ([Angel One support](https://www.angelone.in/support/your-orders/square-off)). After 15:15 the position is closed at market whatever the judge says, and Angel charges an auto square-off fee. This is a hard deadline the packet currently mis-states as 15:30. | **Build (F1)** |
| **Circuit / price band** | Non-F&O stocks have fixed daily bands of 2/5/10/20 %; F&O stocks have no fixed band but a 10 % dynamic operating range that NSE flexes when price nears it ([NSE price bands](https://www.nseindia.com/static/products-services/equity-market-price-bands), [Upstox](https://upstox.com/help-center/t-41535/)). At a lower circuit a long **may not be exitable at all** (no buyers). Near an upper circuit a short is in a trap. This is a mechanical liquidity limit, not a prediction. | **Build (F2)**, with the order-book totals folded in |
| Order-book imbalance (totBuyQuan / totSellQuan) | Pending totals are easy to spoof and lose meaning away from limits. At a circuit they become decisive: a frozen lower circuit shows sell qty in lakhs and buy qty ~0. | Only as part of F2, rendered when near a band |
| **VWAP distance in N** | The exit gate already uses "wrong side of VWAP" as floor-breach confirmation (`exit-discipline/gate.ts:80-84`). In N, it tells the judge whether price is stretched (mean-reversion risk on a winner) or merely wobbling around fair value. | **Build (F3)** |
| **Day range used vs daily ATR (expected-move context)** | Directly the lead that passed walk-forward: big moves (> 1.5 × ATR) are predictable in SIZE, not direction. A stock that has used 1.8 × its daily ATR is in a regime-change day: a pullback is less likely to be "noise". A stock that has used 0.3 × ATR is quiet: a 2N dip is noise. | **Build (F4)** |
| **Relative strength vs NIFTY (and sector)** | It separates "the market fell and took me with it" (exit decision follows the index, beta) from "my stock broke on its own" (idiosyncratic: news, block deal, results leak). It is not a direction forecast: it attributes the move. | **Build (F5)**: NIFTY now, sector when a hub slot is available |
| **Relative volume (time-of-day)** | Breaks on high relative volume are regime changes more often than breaks on thin volume. Today's `volumeRatio` compares a 15m bar with the previous 20 bars, which makes every 09:15 bar look like a spike. | **Build (F6)** |
| **Earnings / board meeting / ex-date** | Already in `events.upcoming` (v2) and `stockMove.results`. Matters most for the square-off decision (results after close) and for gap risk on a carry. | **Reuse** (F7: one derived line, no new data) |
| 52-week high/low proximity | Mostly a direction-flavoured "breakout" story, which prior research says not to trust. It is free once F2's quote fields are mapped. | Optional add-on to F2; not a priority |
| ASM / GSM / T2T surveillance | A T2T (-BE/-BZ) scrip cannot be MIS at all; ASM stage raises margins and signals a speculative stock. It is cheap: `seriesCautionary` is pure (`trade-engine/utils/cautionary.ts:41-60`). The ASM/GSM list table `cautionary_symbols` exists (`prisma/schema.prisma:1629-1650`) but **nothing writes it** (no `cautionarySymbol` usage in `apps/api/src`), which is a silent absence. | Defer; render the T2T series flag inside F2 for free |
| F&O ban list | Ban (OI > 95 % of MWPL) blocks fresh F&O positions, not cash trading ([NSE sec-ban](https://www.nseindia.com/static/products-services/equity-derivatives-risk-management-sec-ban)). It is a crowding/volatility hint at best. | Defer |
| Market breadth (A/D) | `BreadthSectorService.getBreadth` counts 5 major stocks + ~15 sector indices (`market-data/services/breadth-sector.service.ts:95-114`). That is not breadth. Its REST quotes also fail for NSE index tokens on most keys (`market-data/utils/quote-from-candles.ts:8-18`). A real A/D needs an NSE call. Direction-adjacent. | Defer |
| T+1 settlement / BTST, overnight gap risk | Only for a carried (delivery) position. `EQ_DELIVERY` is not watched (`roster.service.ts:182-191`). | Defer until delivery is in scope |

---

## 3. Data availability in this repo (per factor)

Budget reminder: broker REST is a shared ~10 req/s per user and the historical gate is ~3/s (memory: scarce-resource ceilings). Hub live slots are capped at 50 (`market-hub/market-hub.service.ts:116`).

### 3.1 Already fetched, but thrown away: Angel quote extras (zero new broker calls)

- Open trackers are priced every sweep by a **FULL-mode batched quote**, one call per user (`trade-tracker/services/trade-tracker-poller.service.ts:316-337`). Only `tick.ltp` is used (`:333`).
- `mapFullQuote` (`market-data/services/user-historical.util.ts:197-214`) and `mapFullQuotes` (`market-data/services/user-quotes.util.ts:36-49`) keep ltp, open, high, low, close (= previous close), volume, oi and depth. They **drop** `upperCircuit`, `lowerCircuit`, `52WeekHigh`, `52WeekLow`, `totBuyQuan`, `totSellQuan`, `avgPrice`. Community samples of the FULL response show all of these ([SmartAPI forum](https://smartapi.angelone.in/smartapi/forum/post/13499), [post 15863](https://smartapi.angelone.in/smartapi/forum/post/15863)). There is no official field-by-field schema, so **the builder must log one raw `fetched[0]` for an NSE equity and an F&O stock and pin the field names in a fixture first.**
- The per-user WebSocket runs SNAP_QUOTE (`market-data/services/user-feed-session.ts:651-672`). `mapSingleTick` (`:750-788`) likewise keeps only OHLC, volume, oi and depth. SNAP_QUOTE packets also carry upper/lower circuit, 52-week high/low, total buy/sell quantity and average traded price (all prices in paise, `PAISE_DIVISOR`). Verify the exact keys on a raw tick before mapping.
- The hub's `Price` (`market-hub/hub.types.ts:43-55`) carries `day` (open, high, low, prev close) and `depth` via `tickExtras` (`market-hub/tick-extras.ts:15-24`), and nothing else.
- `TickData` (`common/interfaces/broker-adapter.interface.ts:26-41`) has no slot for any of these.

**Plumbing (one change, feeds F2 and F3):** add optional `upperCircuit, lowerCircuit, high52w, low52w, totBuyQty, totSellQty, avgPrice` to `TickData`; map them in `mapFullQuote` and `mapSingleTick` (absent, never 0, when not reported); carry them through `tickExtras` into `Price`. Then add a small in-memory `QuoteExtrasBook` keyed `EXCHANGE:token` with a receipt time, written by the poller's REST tier and by `hub.onPrice`. The tick source reads it **synchronously** (same pattern as `HighImpactNewsBook`, `tick-source.adapter.ts:291, 437`). No broker call is added.

### 3.2 Per-factor availability

| Factor | Data | Where | Extra cost |
|---|---|---|---|
| F1 square-off clock | IST clock, session clock | `minutesToSessionClose` (`context-packet.service.ts:180-220`), `SessionClock` (`market-hub/session-clock.ts:89-174`) | None. Note: **the product type (MIS vs CNC) is not on `trade_trackers`** (`prisma/schema.prisma:1759-1782`). `segmentFor` assumes a cash POSITION is intraday (`charges.ts:53-58`). Angel's positions API returns `producttype`, read today only by `credential-vault/services/broker-overview.service.ts:243` and at exit time by `sentinel-executor/domain/exit-order.ts:88` |
| F2 circuit band + book totals | upper/lower circuit, prev close, totBuy/totSell | §3.1 QuoteExtrasBook; prev close also in `levelBook.prevClose` | None after §3.1 |
| F3 VWAP distance | `levelBook.vwap` (15m-candle VWAP, `level-book.types.ts:35`); better: exchange `avgPrice` from §3.1 | `structure.levelBook` already in packet | None |
| F4 range used / gap / move since entry | `todayHigh, todayLow, prevClose, atr14` (daily) on the level book; tracker `entryPrice`, `holdingHigh/Low` | `level-book.types.ts:13-39`; `tick-source.adapter.ts:440-484` | None |
| F5 RS vs NIFTY | NIFTY live price + `day.close` (prev close) from the hub: NIFTY, BANKNIFTY, FINNIFTY and SENSEX are default context watches at priority 2 (`market-hub/market-hub.service.ts:107-112`, `hub-engine.ts:232`). Fallback: live level book for token `99926000` (`levelBooks.getLevels`, as in `tick-source.adapter.ts:643-659`). NIFTY at entry: hub `candles_1m` (DB) at the entry minute | `market-hub/hub-prices.ts:22-37`; `adapters/minute-bars.reader.ts:28-45` (DB-only) | None for NIFTY. **Do not use a REST quote for an index**: Angel FULL rejects NSE index tokens for most keys (`market-data/utils/quote-from-candles.ts:8-18`) |
| F5 RS vs sector | Symbol → sector index name: `SectorMapService.sectorOf` (in-memory, sync; loaded only when news-events is `computing`) (`news-events/sector-map.service.ts:24-64`); name → token: reverse `SECTOR_TOKEN_NAME` (`news-events/keys.ts:39`); tokens also in `packages/shared/src/constants/index.ts:32-48` | Sector index price needs a hub watch: **one WS slot per distinct sector** in the book, no REST | 1 slot per sector (priority 2). Absent with reason when the hub is off, the user is not the hub owner, or the slot was not granted |
| F6 relative volume | Today's cumulative volume: quote `volume` (kept by `mapFullQuote`, `user-historical.util.ts:209`; hub `Price.volume`). 20-day ADV: hub `candles_1d` (DB). Same-time-of-day baseline: hub `candles_1m` has per-bar `volume` (`market-hub/candles/candle.types.ts:12-20`), but `MinuteBarsReader` drops it (`minute-bars.reader.ts:35-37`) | DB reads, once per token per day | None (DB). Absent when the hub never stored that stock's history |
| F7 event line | `events.upcoming` (v2) and `stockMove.results` | `context-packet.service.ts:1101-1107, 1033-1058` | None. Both are gated (`NEWS_EVENTS_V2_ENABLED=true`, `MBM_PACKET=on`), so F7 must state the gate when they are off |
| 52-week | §3.1 quote fields; or `FundamentalsService` (Yahoo) `fiftyTwoWeekHigh/Low` (`fundamentals/fundamentals.service.ts:431-432`) | | None after §3.1 |
| ASM/GSM | `cautionary_symbols` table, **never populated** | `prisma/schema.prisma:1629-1650` | An NSE `reportASM`/`reportGSM` daily fetch through `NseClient` (`news-events/nse-client.ts`): no broker cost, but new code. Deferred |
| F&O ban | not in repo | NSE sec-ban CSV | NSE fetch, deferred |
| Breadth | weak proxy only | `breadth-sector.service.ts:134-175` | Real A/D needs NSE; deferred |

---

## 4. Factors to build now (7)

All seven go into **one new top-level packet block, `equity`, present only for `EQ_INTRADAY` / `EQ_DELIVERY` positions**. The key is absent for F&O, so every F&O packet stays byte-identical. That is the repo's convention for `stockMove`, `marketBehaviour` and `sinceLastVerdict`, and it keeps the hash-pinned prompt matrix honest. Each sub-field is a `Block<T>` (`context-packet.service.ts:55-65`): present with `source` and `at`, or absent with a reason that names the failure. Numbers go through `numberBlock`-style `Number.isFinite` checks, never `!== null`. A missing input is never rendered as 0.

**Units.** `N` = the stock's 1-minute noise unit in rupees: `noise.contract.n`, falling back to `levelBook.atr14 / sqrt(375)` (see §5, T1). `ATRd` = `levelBook.atr14` (DAILY, `level-book.types.ts:38-39`). Report distances in **N** for "is this noise" questions and in **ATRd** for "how big is today" questions. Round to 1 dp. Signs are **position-relative**: positive = in the position's favour (LONG: up; SHORT: down), so the judge never has to flip a sign.

Cadence: everything is computed on every look from in-memory or ≤ 60 s cached inputs. Only F5's entry anchor and F6's baselines need a DB read, cached once per tracker / token per IST day.

### F1. `equity.squareOff`: minutes to the broker's auto square-off

- **Definition.** For `EQ_INTRADAY`: `minutesToSquareOff = SQUARE_OFF_MIN_IST − nowMinIST`, with `SQUARE_OFF_MIN_IST = 15:15` for NSE/BSE equity on Angel (env `SENTINEL_EQ_SQUAREOFF_IST`, default `15:15`). Use `SessionClock` for holidays and the trading day, exactly as `minutesToSessionClose` does.
- **Product type.** Until a product type reaches the tracker, state the assumption in `source`: `"assumed MIS (intraday): trade_trackers carries no product type; a CNC position is not squared off"`. Later: carry Angel `producttype` onto the roster entry (it is in the positions payload, `broker-overview.service.ts:243`), and render CNC as absent with the reason `"delivery (CNC) product: no broker square-off; the position may be carried overnight"`.
- **Render.** `squareOff: 47 min (Angel auto-squares MIS equity at 15:15 IST; NSE closes 15:30)`.
- **Absent.** `"not a trading day"`, `"before the open: the full session is ahead"`, `"past 15:15: the broker has already squared off (or is squaring off) an MIS position"`.
- **Why.** `session.minutesToClose` (to 15:30) overstates the time left by 15 minutes. The hard-risk window (`closeGuardMin` 10 → 15:20) opens **after** Angel has already closed the trade (§5, T6).

### F2. `equity.priceBand`: distance to the circuit, band category, one-sided book

- **Inputs.** `upperCircuit`, `lowerCircuit`, `prevClose`, `totBuyQty`, `totSellQty` from the QuoteExtrasBook (§3.1). Reject unless `0 < lower < ltp < upper` (`ltp` equal to a limit is allowed and means "at the circuit").
- **Formulas.**
  - `bandPct = round((upper − prevClose) / prevClose × 100)` → label 2 / 5 / 10 / 20 %. For an F&O stock, label it `"dynamic ~10 % operating range (F&O stock, exchange flexes it)"`. "F&O stock" = an NFO stock future exists in the instrument master (`resolveUnderlying` already finds the name), or `stockMove` scored it.
  - `toAdverseLimit` = LONG: `ltp − lower`; SHORT: `upper − ltp`. Report in N and in % of ltp.
  - `toFavourLimit` likewise.
  - `bookRatio = totBuyQty / totSellQty`. Render it **only when** `toAdverseLimit ≤ 1 % of ltp` or `toFavourLimit ≤ 1 % of ltp`; away from limits it is noise.
  - `atLimit` = `ltp === lower` or `ltp === upper` (tick-size tolerance 0.05).
  - T2T flag: `seriesCautionary(symbol).deliveryOnly` (`trade-engine/utils/cautionary.ts:41`), shown only when true.
- **Render.** `priceBand: 5 % band; lower circuit 61.4 is 42 N (2.9 %) below; upper 67.9`. Near a limit: `AT LOWER CIRCUIT 61.40 — sell qty 8,42,000 vs buy 1,200: a market exit may not fill`.
- **Absent.** `"no circuit limits in the latest broker quote for this token (quote extras not captured yet, or the broker did not report them)"`. `"quote extras are 95 s old (> 60 s bound) — not used"` when stale. Never show a 0 limit.
- **Refresh.** Every poller sweep / hub tick. Staleness bound: 60 s, the same as `SPOT_STALENESS_MS` (`tick-source.adapter.ts:51`).

### F3. `equity.vwap`: distance from VWAP in noise units

- **Input.** Prefer the exchange `avgPrice` from the QuoteExtrasBook (true day VWAP). Fall back to `levelBook.vwap` (`level-book.types.ts:35`). `source` names which one.
- **Formula.** `vwapN = (ltp − vwap) × dir / N`, where `dir = +1` LONG, `−1` SHORT.
- **Render.** `vwap: 2,412.6 (exchange avg price); price is +3.4 N on the position's side`. Negative means the position is on the wrong side of VWAP; that is the same fact the exit gate's `FLOOR_BREACH_VWAP` clause uses (`exit-discipline/gate.ts:80-84`).
- **Absent.** `"no VWAP: no exchange average price in the quote and no level book"`, `"no noise unit, so the VWAP distance cannot be sized"` (show the raw rupee gap in the reason).

### F4. `equity.dayRange`: today's size vs the stock's normal (expected-move context)

- **Inputs.** `todayHigh, todayLow, prevClose, atr14` (daily) from `structure.levelBook`; `open` from the quote day bar (hub `Price.day.open`, or the level book `orh` series when no quote); `entryPrice`, peak = `money.mfe`.
- **Formulas.**
  - `rangeUsedAtr = (todayHigh − todayLow) / ATRd`
  - `gapAtr = (open − prevClose) / ATRd` (signed by market direction, not by side: this is a fact about the day)
  - `fromEntryAtr = (ltp − entryPrice) × dir / ATRd`
  - `pullbackFromPeakN = (peak − ltp) × dir / N`
  - Regime label: `QUIET` if `rangeUsedAtr < 0.5`, `NORMAL` if `< 1.2`, `EXPANDED` if `< 1.8`, else `BIG-MOVE DAY`. The thresholds reuse the 1.5 × ATR big-move definition from the stock-move spike.
- **Render.** `dayRange: used 1.6 × ATRd (EXPANDED); gap +0.4 ATRd; trade +0.7 ATRd from entry, 1.9 N off its peak`.
- **Absent.** `"no level book: today's range and the daily ATR are unseen"`; `"daily ATR missing or zero"`.
- **Why.** It answers "is a 2N dip noise?" in context: on a QUIET day a 2N dip is ordinary; on a BIG-MOVE day the same dip after a 1.6 ATRd run is more likely the move ending. It is a size statement, never a direction one.

### F5. `equity.relativeStrength`: the stock vs NIFTY (and its sector)

- **Inputs.**
  - Stock day change: `(ltp − prevClose) / prevClose`.
  - NIFTY day change: hub NIFTY `Price.ltp` and `day.close` (`hub.types.ts:24-29, 43-55`), fresh ≤ 10 s (`HUB_DECISION_MAX_AGE_MS`, `tick-source.adapter.ts:90`). Fallback: live level book for `99926000`, fresh ≤ 60 s.
  - Since-entry legs: stock `(ltp − entryPrice)/entryPrice`; NIFTY `(niftyNow − niftyAtEntry)/niftyAtEntry`, where `niftyAtEntry` = close of the hub `candles_1m` NIFTY bar containing `entryTime` (DB read, cached per tracker for its life).
  - Sector (optional): `SectorMapService.sectorOf(symbol)` → reverse `SECTOR_TOKEN_NAME` → hub price for that index with `watch(ref, 2, 'sentinel:sector')`.
- **Formulas (all in the stock's ATRd as a percentage, `atrPct = ATRd / prevClose`).**
  - `rsDayAtr = (stockDay% − niftyDay%) / atrPct`
  - `rsEntryAtr = (stockSinceEntry% − niftySinceEntry%) × dir / atrPct` (position-relative)
  - Same pair vs the sector when available.
  - Label from `rsEntryAtr` and the NIFTY leg: `MARKET-DRIVEN` when |NIFTY since entry| explains ≥ 70 % of the stock's move with the same sign; `STOCK-SPECIFIC` when |rsEntryAtr| ≥ 0.5; otherwise `MIXED`. No beta: state `beta-unadjusted` in `source`.
- **Render.** `relativeStrength: since entry stock −0.9 %, NIFTY −0.8 % → MARKET-DRIVEN (rs −0.05 ATRd); today vs NIFTY −0.3 ATRd; vs NIFTY IT +0.1 ATRd`.
- **Absent.** NIFTY: `"no fresh NIFTY price (hub off / not the hub owner / stale 40 s) — market vs stock cannot be separated"`. Since-entry: `"no NIFTY 1-minute bar at entry 10:02 IST in candles_1m"` (show the day-only leg). Sector: `"no sector index mapped for KEI"` / `"sector map not loaded (news-events not computing)"` / `"sector index NIFTY IT has no hub slot"`.
- **Fill `macro.sector` too?** No. Keep `macro.sector` as is for F&O byte-identity. For cash, the prompt reading line says the sector reading lives in `equity.relativeStrength`.

### F6. `equity.relativeVolume`: participation vs this stock's normal at this time of day

- **Inputs.** Today's cumulative volume `V` (quote `volume`, or hub `Price.volume`). `ADV20` = mean of the last 20 completed `candles_1d.volume` (DB). Time-of-day baseline `B(t)` = mean over the last 10 sessions of the cumulative `candles_1m.volume` from 09:15 to the same IST minute (DB). The reader must stop dropping `volume` (`minute-bars.reader.ts:35-37`) or a second reader added.
- **Formulas.**
  - `rvolTod = V / B(t)` when `B(t)` exists (≥ 5 sessions with bars).
  - Else `dayFraction = V / ADV20` with `sessionElapsed% = (now − 09:15)/375`, both shown, and **labelled naive** (the intraday U-shape makes pro-rata misleading).
- **Render.** `relativeVolume: 2.3 × its usual volume by 11:40 (10-session time-of-day baseline)`, or `relativeVolume: 0.62 of a 20-day average day traded, 64 % of the session elapsed (naive pro-rata, no intraday baseline)`.
- **Absent.** `"no stored daily or minute volume history for this stock in the hub's candle tables"`; `"today's cumulative volume is not in the latest quote"`.
- **Why.** It is the sizing companion to `flow.volumeRatio`, which compares a 15m bar with the last 20 bars and therefore reads every opening bar as a spike.

### F7. `equity.eventRisk`: one derived line from data already in the packet

- **Inputs.** `events.upcoming` (company `results`, `board_meeting`, `ex_dividend`, `split`, `bonus` rows: `news-events/events/nse-events.ts:26-57`) and `stockMove.results` / `stockMove.inWindow`.
- **Formula.** The nearest company event with `minutesAway ≤ 2 trading days`, classed as `TODAY-BEFORE-SQUAREOFF`, `TODAY-AFTER-CLOSE` (results announced post-market), `NEXT-SESSION` or `LATER`. For an all-day event the time is 09:15 of the date (`nse-events.ts:23-24`), so say "time not announced".
- **Render.** `eventRisk: KEI board meeting (financial results) today, time not announced; the MIS square-off is 15:15`.
- **Absent.** `"events calendar not rendered (NEWS_EVENTS_V2_ENABLED is not true) and the stock-move book is hidden (MBM_PACKET is not on) — corporate events are UNSEEN, not none"`. When both are on and nothing is found: present with value `none in the next 2 trading days`, which is a real finding.

### Packet and prompt shape

```
equity: {
  squareOff:        Block<number>                 // F1
  priceBand:        Block<PriceBandValue>         // F2
  vwap:             Block<{ vwap, basis, n }>     // F3
  dayRange:         Block<DayRangeValue>          // F4
  relativeStrength: Block<RsValue>                // F5
  relativeVolume:   Block<RvolValue>              // F6
  eventRisk:        Block<EventRiskValue>         // F7
}
```

- Declare every value as a `type`, not an `interface`, or the packet stops assigning to `Prisma.InputJsonValue` (`context-packet.service.ts:434-443`, `packetAsJson` at `:649-651`).
- Build it in a pure `equityBlocks(...)` (new `services/equity-blocks.ts`), in the style of `market-behaviour-block.ts`. Inputs are passed in; no I/O inside.
- Prompt: add a switch with a stamp suffix `+e1` (the same mechanism as `+l1` / `+d1`, `sentinel-system-prompt.ts:245-268`). Add `equity` to the top-level field line only when on, plus one reading line per sub-field. Also add these sentences: "On a cash-equity position, `session.minutesToClose` is the exchange close; the broker's deadline is `equity.squareOff`." and "`flow.oiWalls` is not captured for cash positions."
- Fix the false OI reason for cash at `context-packet.service.ts:1316-1318` (segment-aware wording). Do it inside the `+e1` switch, because it changes packet bytes.

---

## 5. Fixed thresholds that should become segment-aware

Principle: keep the futures rule, and replace a fixed % with **k × N** (or k × ATRd), so an equity's lower volatility is handled automatically. Keep a fixed-% fallback only for when N is unknown. A random walk over the 15-minute cap interval spans about sqrt(15) ≈ 3.9 N, which anchors the multipliers below.

| # | Threshold (file:line) | Today | Problem on cash | Proposal |
|---|---|---|---|---|
| T1 | Contract noise unit for cash (`tick-source.adapter.ts:523-532`; floor uses `tick.noise.contract.n`, `sentinel-cycle.service.ts:769`; giveback noise rule, `:720-724`) | Contract N null without hub 1m bars, so the noise floor is off (`cycle-floor.ts:27`) and giveback uses the 40 % rule | For cash, contract = underlying, and the daily-ATR fallback already exists but feeds only `underlying` (`context-packet.service.ts:681-685`) | For cash, set `contract = underlying1m ?? scaledUnderlyingNoise(levelBook.atr14, …, 375)` **in the tick source**, so the floor, giveback and gate all get N. This single change does most of "same logic as futures, smaller volatility" |
| T2 | `SENTINEL_ADVERSE_MOVE_PCT` 0.04 (`judge-gate.ts:61`, parsed at `:108`; used at `sentinel-cycle.service.ts:993-997`) | 4 % of the contract | Rare for a stock in a session. The peer diff adds `adverseMovePctEq` 0.008 (`judge-gate.ts:64-71, 110, 119-123`) | Keep 0.008 as the fallback. Primary rule for cash: adverse since the last judgement ≥ **6 N** (≈ 1.5 σ over 15 min; ≈ 0.6 % for a large cap with N ≈ 0.1 %) |
| T3 | `SENTINEL_REJUDGE_PRICE_MOVE_PCT` 0.02 / `_EQ` 0.004 (`services/rejudge-suppression.ts:58-67, 97-98`) | Equity value exists (committed) | Still %-based | Cash: material repeat move ≥ **3 N**, fallback 0.004 (keeps the 1:2 ratio with T2) |
| T4 | `MATERIAL_MOVE_PCT` 0.01 (`services/tripwire.service.ts:60`, used at `:100`) | 1 % of the contract gates the quiet heartbeat | 1 % of a stock is a large move, so quiet heartbeats are skipped almost always | Cash: ≥ **3 N**, fallback 0.004 |
| T5 | `NEAR_LEVEL_PCT` 0.01 (`tripwire.service.ts:136`, used at `:129`) | Within 1 % of a level = tight cadence | On the underlying scale for everyone, so it is not derivative-scaled. Still, a fixed 1 % is ≈ 1 ATRd on NIFTY but only 0.5 ATRd on a volatile stock | Both segments: within **0.25 × ATRd** (fallback 0.005 for cash). Low priority |
| T6 | `closeGuardMin` 10 (`judge-gate.ts:107`) and `gateCloseMin` 10 (`exit-discipline/config.ts:13`; `gate.ts:58-60`), measured to 15:30 | Hard-risk window opens 15:20 | **After** Angel's 15:15 MIS square-off | Cash `EQ_INTRADAY`: measure to `SQUARE_OFF_MIN_IST` (15:15, F1), so the window opens at **15:05**. `hardRisk` at `sentinel-cycle.service.ts:988-989` should use `minutesToSquareOff`. F&O unchanged (Angel F&O square-off is 15:20, so arguably F&O should move too; flagged, not proposed) |
| T7 | `GREEN_FLOOR_MARGIN_RUPEES` 150 (`charges.ts:100`), the fixed floor basis | Breakeven + ₹150 | Rupee-fixed: on 10 shares of a ₹300 stock that is +5 %, so the floor never arms. On 2,000 shares it is noise | Remove the need via T1 (cash always gets a noise basis). If N is still unknown: `margin = max(₹20, FLOOR_ARM_N × N × qty)` |
| T8 | `GIVEBACK_FRACTION` 0.4 (`tripwires/giveback-off-peak.tripwire.ts:9`, fallback at `:47-58`) | Fires on 40 % of any positive excursion | A ₹0.40 excursion and a ₹0.16 pullback fires it | Mostly removed by T1. The fallback should also require `peakGain ≥ FLOOR_ARM_N × N_fallback` |
| T9 | `VOLUME_SPIKE_RATIO` 2 on the 15m vs 20-bar median (`tripwires/volume-anomaly.tripwire.ts:7`) | Same for all | The 09:15–09:45 bars always clear 2× (20 bars ≈ 5 h reaches back over yesterday's quiet afternoon). It is a time-of-day artefact on stocks | Cash: fire on `rvolTod` (F6) ≥ 2 when available; otherwise suppress `volume-anomaly` for the first two 15m bars |
| T10 | `INVALIDATION_SCALE_TOLERANCE` 0.2 (`exit-discipline/config.ts:24`, `gate.ts:35`) | 20 % from the underlying = wrong scale | Fine for cash (≥ the widest band) | Keep |
| T11 | `openingGuardMin` 15 (`exit-discipline/config.ts:18`) | | Fine; the equity pre-open call auction ends 09:08 (`market-hub/session-clock.ts:22`) | Keep |
| T12 | `expiryCloseMin` 30, `OI_WALL_SHIFT_PCT` 0.002 | | Inert for cash (expiry null) | Keep; no change |

---

## 6. Build order (suggested)

1. T1 (cash contract N fallback) and T6 (square-off-relative hard risk). Small, highest value, no new data.
2. §3.1 quote-extras plumbing, with a recorded raw FULL quote and a raw SNAP_QUOTE tick as fixtures, then F2 and F3.
3. F1, F4 and F7 (pure functions over data already in the packet), the `equity` block, the prompt `+e1` switch, and the OI-reason fix.
4. F5 (NIFTY first; sector behind its own hub-slot watch) and F6 (needs the volume-keeping minute-bar read and the daily ADV read).
5. T2–T5, T7–T9 as N-based rules with the listed fallbacks, each env-tunable, each logged in the gate record so the night review can score it.

Deferred, with reasons stated above: ASM/GSM writer for `cautionary_symbols`, F&O ban, real A/D breadth, T+1/BTST/overnight gap (needs `EQ_DELIVERY` in scope), product-type plumbing (needed to make F1 exact).

Sources: [Angel One square-off timings](https://www.angelone.in/support/your-orders/square-off) · [NSE equity price bands](https://www.nseindia.com/static/products-services/equity-market-price-bands) · [Upstox: price bands and circuit breakers](https://upstox.com/help-center/t-41535/) · [NSE security in ban period](https://www.nseindia.com/static/products-services/equity-derivatives-risk-management-sec-ban) · [SmartAPI forum FULL-mode samples](https://smartapi.angelone.in/smartapi/forum/post/13499), [post 15863](https://smartapi.angelone.in/smartapi/forum/post/15863)
