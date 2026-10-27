# Telegram calls in paper mode, and self-review lesson noise

**Sessions:** 2026-10-26 → 2026-10-27
**Branch:** `main` — `e2d928c` … `b37ada8` (all pushed and deployed to the VPS)
**Status:** paper mode is live in prod. Self-review fixes are deployed. One open design gap: calls that arrive already "out of band" are skipped and not judged.

---

## 1. The short version

- The Telegram reader now catches the calls prod missed on 10-26 (`e2d928c`).
- A live feed page shows every incoming post and what the reader made of it (`720bec3`).
- `SIGNAL_TRADING=paper` is on in prod (`5cf8731`), so every TAKE opens a paper trade and the broker is never called.
- Self-review had been writing one-day hindsight lessons that blamed a factor the scorecard doesn't have. Two fixes now gate and ground the lessons (`f1cb9d9`, `b37ada8`).
- Remaining gap: the "don't chase" check (`entry_tolerance`) still hard-skips in paper mode before any plan exists. The AI judge never sees those calls, so we don't learn whether they would have worked.

---

## 2. Production state (VPS 157.10.98.70)

| Flag | Value |
|---|---|
| `SIGNAL_TRADING` | `paper` (added to `/opt/grw/env/api.env` on 10-26, backup `api.env.bak-20261026-paper`) |
| `PAPER_TRADING` | `true` |
| `LIVE_TRADING_ENABLED` | `false` |
| `SENTINEL_TRIGGERS_ENABLED` | `false` |

The boot log should show `[signal-trader] mode=paper maxLots=2 maxLoss=₹2000 trades/day=3 dailyStop=₹10000`.

Migration `20261026200000_agent_lesson_sessions` was applied at 16:25 UTC on 10-26.

**Never** flip `LIVE_TRADING_ENABLED`, `SENTINEL_TRIGGERS_ENABLED` or `SIGNAL_TRADING=live` without the owner's explicit yes.

Access and checks:
- `ssh -i ~/.ssh/grw_oracle root@157.10.98.70`
- Database: `docker exec grw-postgres psql -U grw -d grw`
- Deploy result: grep the deploy logs for `rolled back|FAILED`, not `fail`, because the hostname contains "copyfail".

---

## 3. What shipped

### 3.1 Signal intake: `e2d928c`
- Text is NFKC-normalised before parsing, so posts in "fancy" Unicode fonts read as plain text.
- Disclaimer boilerplate is dropped.
- A strike with CE/PE and a premium is read as a call even without an SL or targets.
- The "Stock Gainers" format is understood: SUPPORT = SL, VIEW/FOR = target.
- New aliases: HEL → HAL, ATHER ENERGY → ATHERENERG.
- An entry range more than 30% wide is treated as a brag, not an entry.
- Replaying 192 stored posts recovered 11 missed calls with 0 new false positives.

### 3.2 Telegram feed: `720bec3`
- `GET /api/telegram/feed` joins `telegram_messages`, `signal_message_classes`, `trade_signals` and the latest `signal_decisions`.
- The page is renamed "Telegram Feed". It lists every post with its class, reason, reader delay and decision.
- It has class and channel filters and refreshes every 15 seconds.

### 3.3 Paper mode and engine SL: `5cf8731`
- In paper mode the risk caps become recorded warnings (1-lot plan, trade count, daily stop), so every call gets tested.
- The AI judge runs on every *planned* call, and its read is stored even when a hard check skips the call.
- Telegram paper trades have their own concurrent-positions pool.
- Engine SL now quotes the underlying itself (NSE cash, or the nearest MCX future) and reads delta from `optionGreek`. Before this, every SL fell back to "25% of premium". A fallback stop now records what was missing.

### 3.4 Self-review noise: `f1cb9d9`, `b37ada8`

**The problem.** On 10-26 the 3 SENTINEL_OVERNIGHT lessons were each fitted to a single session. Two of them blamed an "index trend" factor the overnight scorecard doesn't have; the real drivers were expiry, VIX and FII points. The diagnosis had never been shown the factor points.

**The fixes:**
- `agent_lessons.sessions`: a lesson is injected only after it has cases from 2 or more sessions (`MIN_SESSIONS_TO_INJECT`).
- Cases are counted once per (session, symbol).
- `SCORECARD_TOTAL` details carry `factors` (the points per factor). Diagnosis prompt `d2` tells the model to blame only non-zero factors.
- The model must list `blamedFactors`. `groundingProblem()` discards the lesson or proposal when a blamed factor is absent or scored 0, or when a weight proposal targets an unblamed factor. A non-allow-listed `proposalTarget` is dropped. The service logs `[self-review] run X: discarded …`.

**Retired on prod** (by the owner): `bearish-score-must-respect-index-trend` and `index-trend-not-sole-veto-for-bullish-options`. `bullish-news-needs-tape-confirmation` was already retired.

**Expected right now:** 6 ACTIVE lessons, each with 1 session, so **0 lessons are injected** until one recurs on a second day. That is not a bug.

Tests: 1,814 passed across self-review, overnight-scorecard, trade-sentinel and news-impact. API `tsc` shows 174 errors, all pre-existing.

---

## 4. Open gap found last: out-of-band calls are never judged

Two calls on 10-26 were read correctly and skipped:

| Call | Entry | Band | LTP at arrival | Mode |
|---|---|---|---|---|
| GOLD30OCT26138000PE (19:14) | 410 | 397.7–422.3 | 478 (+17%) | shadow (before paper was on) |
| CRUDEOIL17NOV2610550CE (21:27) | 270 | 261.9–278.1 | 308.5 (+14%) | paper |

The crude post reached us only 20 seconds late; the option had already run before the channel posted. `entry_tolerance` fails before a plan is built, and the paper-mode judge only runs when a plan exists. So `judge` and `plan` are both null on these decisions. `live_trading_enabled` and `sl_enforceable` also show as failed, which is expected and not required in paper mode.

**Proposed fix, awaiting the owner's yes. Paper mode only; live stays strict:**
- Instead of skipping, rest a paper LIMIT at the channel's entry price for N minutes (30 suggested).
- Run the judge either way.
- If the order never fills, record "no fill", plus whether the SL or targets would have been hit.

That answers whether this channel's calls ever come back to the entry price, or are always too late to follow.

---

## 5. Other offers still waiting on the owner

- Score CHANNEL_SIGNAL calls that have no SL or targets by price move. Today they go unscored.
- Fix dragging the chart up and down.
- Count the kinds of Telegram updates that arrive.
- Decide the 3 PENDING tuning proposals: `fii_dii` weight → 0.5, `indicators` → 1.25, `news` → 0.25.
- News-impact verification is mostly null; still to investigate.

## 6. Working constraints

- Prod writes and `git push` are often blocked by the auto-mode classifier. Give the owner short one-line `!` commands instead; long ones wrap when pasted.
- Commit with explicit pathspecs. Push only when asked.
- Pushing any branch deploys the web app on Cloudflare. Push only `main`.
- The M365 connector belongs to someone else. Don't read that mailbox without explicit confirmation.
