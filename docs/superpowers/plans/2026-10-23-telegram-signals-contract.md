# Telegram signal trading — build contract (2026-10-23)

Owner decisions (2026-10-23): read the owner's chosen Telegram channels through the OWNER'S Telegram
account; trade LIVE from day one with hard caps (owner explicitly chose this over the paper-first rule);
quantity = the signal's own quantity, capped. Every message is kept (keep-all-data rule).

## Hard caps (code-enforced, env-configurable, never overridable by the AI judge or a channel)
| Env | Default | Rule |
|---|---|---|
| SIGNAL_TRADING | off \| shadow \| live (default **shadow** until the owner flips it) | off = ingest only; shadow = full pipeline, alert, no order; live = orders |
| SIGNAL_MAX_LOTS | 2 | quantity = min(signal qty, cap); equity: min(signal qty, cap expressed as value ≤ SIGNAL_MAX_NOTIONAL) |
| SIGNAL_MAX_LOSS_PER_TRADE | 2000 (₹) | (entry − SL) × qty must be ≤ this, else SKIP (never resize upward, may resize DOWN to fit) |
| SIGNAL_MAX_TRADES_PER_DAY | 3 | counted from the DB |
| SIGNAL_DAILY_LOSS_STOP | 10000 (₹) | realised + open signal-trade loss today ≥ this → no new signal trades today |
| — | — | no SL in the signal and no engine-derived SL → SKIP. Kill switch / risk manager / max-daily-loss of the account always apply. Hold list untouched. |

## Streams and ownership
- **R (reader)** — `apps/api/src/modules/telegram-reader/**`, web `apps/web/src/pages/settings/telegram*` (or the existing settings area), Prisma `TelegramSession`, `TelegramChannel`, `TelegramMessage`.
- **S (signals)** — `apps/api/src/modules/signal-intake/**`, Prisma `TradeSignal`, `SignalCluster`; self-review kind `CHANNEL_SIGNAL` (in apps/api/src/modules/self-review, additive only).
- **X (execution)** — `apps/api/src/modules/signal-trader/**`, Prisma `SignalDecision`, `SignalOrder`; web page `apps/web/src/pages/signals-telegram/**` (decisions list + per-channel stats).

## Data (Prisma, one migration per stream, ADD only, names 20261023xxxxxx_<stream>)
- TelegramSession (userId, encrypted session string via the credential-vault field cipher, apiId, phone masked, createdAt, status)
- TelegramChannel (id, userId, tgChannelId bigint/text, title, username, enabled, addedAt)
- TelegramMessage (id, channelId, tgMessageId, postedAt, text, hasMedia, editedAt, raw jsonb; unique(channelId,tgMessageId))
- TradeSignal (id, messageId, channelId, receivedAt, parser 'rule'|'llm', underlying, instrumentKind FUT|CE|PE|EQ, strike?, expiry?, side BUY|SELL, entryLow, entryHigh, entryType ABOVE|BELOW|AT|RANGE, sl?, targets jsonb, qty?, confidence, rawText)
- SignalCluster (id, underlying, direction, windowStart, channelIds[], signalIds[], agreeCount, conflict boolean, status)
- SignalDecision (id, signalId, clusterId, decidedAt, mode shadow|live, gate jsonb (each hard check pass/fail), judge jsonb (verdict TAKE|SKIP, reasons, packet ref), decision TAKE|SKIP, skipReason)
- SignalOrder (id, decisionId, token, tradingsymbol, qty, side, orderType, limitPrice, sl, targets, brokerOrderId, status, fillPrice, filledAt, trackerId)

## Events between streams (in-process, Nest EventEmitter2 or a small interface; no Redis needed)
- R → S: `telegram.message` { messageId, channelId, postedAt, text, hasMedia }  (R persists first)
- S → X: `signal.ready` { signalId, clusterId, agreeCount, conflict }  (emitted when a parsed signal joins/creates a cluster; X evaluates each signal once; a later corroborating signal re-emits for the cluster so X can upgrade a SKIP(low-confidence) only if price is still within the entry tolerance)

## Rules S must implement
1. Free pre-filter (deterministic): needs an instrument token (NIFTY, BANKNIFTY, FINNIFTY, a symbol in the NSE F&O / cash instrument list, or strike+CE/PE), an action word (buy/sell/above/below/long/short), and ≥ 2 numbers that look like prices. Everything else is stored as 'noise' and never sent to an LLM.
2. Rule parser for common formats first; LLM fallback (cheap model, low priority, through the existing ai-gateway / CLI transport non-reserved slot, recorded in ai_calls) only for pre-filter positives the rule parser cannot parse.
3. Clusters: same underlying, 30-min window (SIGNAL_CLUSTER_MIN). agreeCount = distinct channels with the same direction; conflict = any opposite direction in the window. Strong = agreeCount ≥ SIGNAL_STRONG_CHANNELS (default 3).
4. Dedup: edits and reposts in the same channel do not count twice.

## Rules X must implement
1. Deterministic gate (all must pass, each recorded): SIGNAL_TRADING mode; NSE/MCX market hours; instrument resolves to a live contract (instrument master); LTP within entry tolerance (ABOVE x: LTP ≥ x and ≤ x × 1.03; RANGE: inside; no chasing); SL present (or engine SL from the level book ≤ cap); risk ≤ SIGNAL_MAX_LOSS_PER_TRADE after the lot cap; trades today < cap; daily signal loss < stop; kill switch off; account risk manager allows; not already holding the same contract.
2. AI judge (strong model, priority BELOW live sentinel exits — never take the reserved live slot; time out → SKIP): packet = signal + cluster (agree/conflict, channel stats) + the sentinel-style market context (OI/PCR/walls from the chain snapshot, level book S/R, news, VIX, MBM expected move incl. the relative reading if present, trend). Output TAKE|SKIP + reasons. Conflict clusters: judge decides alone with no confidence boost. Single-channel: allowed, judged on its own.
3. Live: place the entry through the app's existing live order path (find it: trade-engine / auto-trade / broker adapter placeOrder with ordertag), LIMIT at the signal entry (or marketable limit within tolerance), never a naked market order; create the tracker so the trade sentinel watches it with the signal's SL/targets as the thesis; place the SL as the sentinel/exit path expects.
4. Alerts via the existing Telegram ops bot for every TAKE / SKIP (with reason) / fill / reject.
5. Shadow mode = identical pipeline, no order.

## Self-review (S adds kind CHANNEL_SIGNAL)
For every parsed signal (traded or not): next-session-or-same-day outcome on the instrument's bars: hit first target before SL → right; SL first → wrong; neither → null. Per-channel rolling hit rate in the summary (`byChannel`), shown on X's page.

## R note (2026-10-23) — TelegramChannel / TelegramMessage ALREADY EXIST
The legacy scorecard module (`apps/api/src/modules/telegram`) already owns Prisma models `TelegramChannel`
(`telegram_channels`) and `TelegramMessage` (`telegram_messages`). R does NOT create new ones; it ADDS columns:
- `TelegramChannel`: `userId String?`, `enabled Boolean @default(false)` (reader subscription; `isActive` is the legacy
  scorecard flag), `memberCount Int?`. `tgChannelId` = GramJS marked peer id as text (e.g. `-1001234567890`).
- `TelegramMessage`: `hasMedia Boolean @default(false)`, `editedAt DateTime?`. The text column is `rawText` (not `text`),
  raw jsonb is `rawPayload` (not `raw`). Reader rows carry `parseStatus = 'pending'` (S may update it). `tgMessageId` is Int.
- New: `TelegramSession` (`telegram_sessions`).
- Event `telegram.message` payload: `{ messageId: TelegramMessage.id, channelId: TelegramChannel.id, postedAt: Date,
  text, hasMedia, edited: boolean }` — `edited: true` on an edit re-emit (S dedups). Constant + type exported from
  `apps/api/src/modules/telegram-reader/telegram-reader.events.ts`. EventEmitterModule.forRoot() is registered in app.module by R.

## X addendum (2026-10-23) — PAPER when the account lacks funds
Owner request: "if there is a lack of funds in the account, create a paper trade of that so that we can analyze it later".
- LIVE only, after the judge + pre-send price check: funds check `funds` in `SignalDecision.gate` = `{available, required, ok, method}`.
  Available = Angel RMS `availablecash` via `BrokerOverviewService.getFunds` (own-account session, no second login).
  Required: option BUY = limit × qty + `SIGNAL_FUNDS_BUFFER_PCT` (1 %); cash = notional + buffer; futures / option SELL =
  ESTIMATE `SIGNAL_FUT_MARGIN_PCT` (25 %) of notional + buffer (no broker margin API wired). Unreadable → `ok: null`, order sent as before.
- Short (or broker rejects with a funds/margin text) and `user_settings.signalPaperOnNoFunds` (default ON, owner toggle on the page)
  → `decision = 'PAPER'`, `skipReason = 'insufficient_funds'`; a paper trade through `TradeExecutionService.executeTrade(isPaper)`,
  strategy `TELEGRAM_SIGNAL_NO_FUNDS`, source `telegram-signal / no-funds`, tags `decision:<id>`; SL + T1 exits by
  `SignalPaperWatchService` (30 s). Never a broker order, never a tracker, never counted by the caps (they count TAKE / live orders).
  Setting OFF → plain SKIP `insufficient_funds`. Self-review summary `signalTrades` = live vs paper (no funds), session + rolling 20.

## S addendum (2026-10-24) — INFO / RECAP (information vs noise)
Owner: "these contain information about NIFTY and crude, and OI — differentiate messages which contain info from actual noise".
- Classes: SIGNAL, UPDATE, **INFO** (views, levels, OI/PCR notes, macro links, conditional scenarios; replaces VIEW — legacy
  `VIEW` rows are migrated by the one-off re-classification), **RECAP** (the channel's own results of past calls: a recap header
  or P&L words + a named contract with a price move; kept, never a signal), NOISE (greetings, ads, membership, P&L brags without
  calls, links/emoji-only, empty). Ad vocabulary wins unless the post also has concrete market content (entity + level + bias/OI).
- Deterministic first (`domain/info.ts`): entity (vocabulary + Hinglish aliases: crude / US oil / WTI / Brent; an OI note on an
  index-range strike; an un-named 15k–35k level = NIFTY) AND content (level, OI words, bias words EN+Hinglish, "agar/if … toh/then").
  A pre-filter positive with an explicit buy/sell verb stays on the parse path.
- Items → `channel_infos` (one row per message; items `{underlying, bias, levels, targetLevel, oi, condition, horizon}`, extractor
  rule|llm). Cheap-LLM fallback (job `signal.info`, parse transport + shared slot, cached by text hash) ONLY when the detector says
  INFO and no item has a bias; `SIGNAL_INFO_LLM_DAILY_CAP` 60, never for posts > `SIGNAL_INFO_LLM_MAX_AGE_MIN` 360. Vision kind INFO
  carries the same items.
- Self-review kind `CHANNEL_INFO`: BULL/BEAR items judged on daily bars (index / NSE cash / nearest MCX future): next session
  (5 for WEEKS; MONTHS recorded, not judged), right beyond ±0.3×ATR, FLAT inside; `levelHit` separate. `byChannel` gains info*.
- Channel sentiment (24 h, weighted by channel INFO accuracy) in the signal judge packet (`channelViews`) and the Night Report
  ("Telegram channel views"). Read-only; never triggers a trade.
- One-off boot re-classification (`SIGNAL_INFO_RECLASSIFY`, default on, idempotent via `signal_message_classes.class_version`).
