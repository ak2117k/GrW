# Supreme fixes (audit 2026-11-27) — Implementation Plan

> For agentic workers: five workstreams run IN PARALLEL on one tree (branch `feature/supreme-fixes`). Each owns disjoint files. TDD; commit with explicit pathspecs; never push.

**Goal:** Unblock the desk manager ("supreme") and feed it complete data: the guard counts only its own trades, it sees funds, its lead and instrument slots aren't crowded out, it gets channel views and option data, every image is described, parsing is sane, its per-trade agents stop wasting calls, and the new authority path can be proven.

**Source:** owner-approved audit list of 2026-11-27 (items 1–13) — evidence in the audit reports; this plan pins the decisions.

## Global constraints
- Off/unchanged behaviour for everything not named here. No change to exit authority semantics (TRADE_AGENT_AUTHORITY live).
- 15m is the smallest analysis unit; never decide on 1m bars.
- Run only your own specs (`npx jest <paths>` from apps/api, `--maxWorkers=2`); disk is ~4.5 GB — stop if < 1 GB. tsc (`npx tsc --noEmit -p apps/api/tsconfig.json 2>&1 | grep -c "error TS"`) ≤ 181; count only errors in your files when others are mid-edit.
- CRLF files: use the Edit tool. Never log secrets. Commit messages conventional, ending `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

## W1 — Desk guard counts only the desk's own trades (item 1)
**Owns:** `apps/api/src/modules/desk-manager/repositories/desk-day.repository.ts`, `desk-manager/domain/pnl-path.ts`, `desk-manager/services/desk-guard*.ts` (+ specs).
**Decisions:**
- The guard's day path (realised, open, peak, drawdown, day loss) and the loss streak count ONLY trades whose origin is the desk manager or a trade agent the desk manages (`origin: 'manager'`, i.e. opened by a desk OPEN decision). Owner manual trades, owner hold-list positions (`AI_AUTO_EXIT_HOLD`) and holdings/equity delivery are excluded.
- Keep reporting the excluded P&L separately in the pnl block as `ownerPnl` (`{ realised, open }`) so the supreme still sees the whole desk, but `guard` decisions use only the managed path.
- Fix the mismatch: open P&L for a position must be computed one way (the positions block value) — reuse one function.
**Tests:** a day with owner manual losers ×3 and a held MAZDOCK −₹4k → guard not blocked, streak 0; manager trades −₹5.1k drawdown → blocked; ownerPnl reported; held/owner trades never in streak.

## W2 — Packet: funds, lead quotas, instrument slots, channel views, health (items 2, 3, 4, 9, 13)
**Owns:** `desk-manager/services/desk-state.service.ts`, `desk-manager/repositories/desk-state.repository.ts`, `desk-manager/domain/packet-blocks.ts`, `desk-manager/domain/manager-prompt.ts`, `desk-manager/domain/desk.types.ts`, `desk-manager/services/manager-runner*.ts` (+ specs). Not the market adapter (W4) and not the guard files (W1).
**Decisions:**
- **Funds block** (`funds`): available margin from the owner's Angel RMS (existing broker funds read used by the order path for "funds: INSUFFICIENT" — reuse it), plus for each instrument in the packet the 1-lot cost of the ATM option (premium × lot size × value factor) and of the mini contract where one exists (CRUDEOILM, GOLDM, SILVERM, NATURALGAS mini). 3 s box like other blocks. Prompt rule: never OPEN when the 1-lot cost > available funds; prefer the mini.
- **Lead quotas** (`proposals`): replace the single cap 40 with per-source quotas — readings (CALL/UPDATE) 16, signal decisions 8, ai_setups 6, entry engine 10 — newest first within each; unused quota is NOT reassigned to the engine. Engine items merged to one per (underlying, side), latest wins, with a count. Bare-number UPDATE readings (no instrument, no level) are dropped.
- **Channel views** (`channelViews`): message_readings kind INFO (market views) from the last 3 h, max 10, newest first: channel, time, summary, subject, bias.
- **Instrument slots** (`pickUnderlyings`): order = F&O/MCX positions → underlyings with proposals or channel views → recent exits; equity/delivery holdings LAST and only if slots remain; cap stays 8. Normalise underlying keys (drop `MARKET`; map aliases like `BHARATFORGE`→`BHARATFORG`, `GOLDM`→`GOLD` for data lookup) via the existing instrument master/alias helper.
- **Health block:** report the live feed status (market hub connection + last tick age) and agent containers (ai-gateway agent health service) instead of "unknown"/{}.
- **Missed-run alert:** if no desk run completed for > 15 min while any venue is open, sendOpsAlert once per gap; also alert on any failed run (error) once per 30 min.
- Time budget for the `instruments` and `recentExits` blocks: raise 3 s → 6 s (W4 makes the reads cheaper).
**Tests:** each decision above, plus the prompt lists funds/channelViews/quotas.

## W3 — Images and parsing (items 5, 10)
**Owns:** `apps/api/src/modules/signal-intake/**` (+ specs).
**Decisions:**
- Every image post goes to vision (with the describe schema) — remove the skip when the caption already carries a direction (`signal-intake.service.ts:~205`) and when the caption is empty; the caption-based class still applies, the image description is added. Store the image sha256 and description on the class row (`llm_result.description`).
- Fix the vision model logging mismatch (config says haiku default but rows show sonnet-5-5 — the Vertex map: make the boot log print the served id).
- **Strike sanity:** a parsed option call whose strike is > 15% away from the named underlying's spot is re-matched against other indices (NIFTY, BANKNIFTY, SENSEX, FINNIFTY, MIDCPNIFTY, BANKEX) whose spot is within 15%; if exactly one fits, use it and record `reMatched`; else UNRESOLVED as today.
- **Result posts:** posts reporting a completed outcome ("gains done", "target hit", "booked", "x to y++ done", "🎯 done") are RECAP, never a new signal.
- `telegram_messages.parseStatus` is set to the final class; `telegram_channels.lastSeenMsgId` updated on each stored message (telegram listener in signal-intake or its listener module — if the listener lives outside signal-intake, touch only that one file).
**Tests:** each.

## W4 — Market data for the supreme (items 7, 8)
**Owns:** `desk-manager/adapters/desk-market.adapter.ts` (+ spec), the level-book module files it reads from (find `getLevels` provider), `market-hub` bar cache helpers if needed.
**Decisions:**
- **Shared bar cache (audit "option B"):** one in-process cache of closed 15m session bars per (exchange, token) built from candles_1m (live-feed gate as today) with Angel historical fallback, refreshed once per closed 15m bar + 20 s; all desk reads (day, trend15m, priceAt) and any other caller use it. Pre-warm at boot and on venue open for every underlying in the last packet + configured index/MCX list, so a run never waits on a cold fetch.
- **Level books for every packet underlying:** when `getLevels` returns null for an underlying, build it on demand from daily + 15m bars using the existing level-book builder, cache per session; SENSEX, SILVER, NATURALGAS, GOLD, BANKNIFTY included. VWAP: session VWAP from the futures' volume (indices: from the near-month future) when spot has no volume.
**Tests:** cache shared (one fetch per bar), pre-warm, level book built when missing, VWAP from future for an index.

## W5 — Agents and proof (items 11, 12, 13 misc)
**Owns:** `trade-sentinel/services/judge-gate.ts`, `trade-sentinel/services/sentinel-cycle.service.ts` (only the held-position suppression and cadence parts), `sentinel-executor/services/sentinel-exit-executor.service.ts` (latencyMs only), a new `apps/api/scripts/authority-drill.ts` (+ specs). Must not touch exit-authority semantics.
**Decisions:**
- **Held positions:** a tracker on `AI_AUTO_EXIT_HOLD` is judged at most once per 60 min (heartbeat) and never on rejudge fires; its EXIT_NOW is recorded as advisory only (no executor attempt). Saves the Opus calls wasted on MAZDOCK.
- **Cadence:** investigate the 19-min CRUDEOIL gap 11-27 (live MCX position): find why no look happened (suppression? slot? caps) and fix so a live non-held position is looked at least every 10 min while its venue is open. Report the cause.
- **latencyMs negative:** fix the timestamp order in the executor's latency computation.
- **Authority drill:** a script `npm run authority:drill -- --tracker <id> [--rule FLOOR]` (runs inside the grw-api container) that raises a real alarm for a chosen tracker through TRADE_ALARMS with `payload.drill=true`, and prints the path it took (alarm → agent look → verdict → confirm/escalation). Drill alarms never sell: the router/runner treat `payload.drill` as observe-only (log + Telegram "DRILL", no executor, no backstop) — implement that guard in the alarm consumers by checking the flag (small edits in exit-authority files are allowed for this flag only).
**Tests:** each.

## Finish
After all five land and pass review: one whole-branch review, then merge to main and deploy (owner OK given 2026-11-28 for all items; markets closed until Monday).
