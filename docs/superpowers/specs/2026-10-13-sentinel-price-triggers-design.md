# Sentinel Price Triggers & Tick-Driven Sensors — Design

**Date:** 2026-10-13 · **Status:** draft for owner review · **Owner request:** "predict the decision before the
trade goes against us" (2026-10-13, after a live CRUDEOIL test where the owner's broker stop-loss filled while the
sentinel was still at EXIT_ARMED waiting for its 8930 invalidation).

## 1. Problem

Exit latency today, from an adverse move to an order:

| Step | Today |
|---|---|
| tick reaches GrW | < 1 s (WebSocket) |
| a sensor notices | ≤ 30 s (sentinel runner cron `*/30 * * * * *`) |
| LLM decides | 30 s – several minutes (Claude CLI judge) |
| order sent | ~10 s (auto-exit poller 5 s + broker) |

The slow part is the LLM thinking **after** the move. The LLM already states, in every verdict, *where* the trade
is wrong (`invalidationPoint`, free text, e.g. "loses 8930"). We make that decision **ahead of time and
machine-readable**, and let a tick-level watcher execute it with no LLM in the loop.

## 2. Goals / non-goals

**Goals:** tick → exit order in ≤ 2 s once a pre-agreed level is crossed; the LLM keeps deciding *what* the level is
and re-plans it as the trade evolves; sensors wake the LLM within ~1 s instead of ≤ 30 s.
**Non-goals:** opening/adding positions; replacing the broker stop-loss (that is the separate
`AI_AUTO_EXIT_CANCEL_PROTECTIVE` feature); price prediction models (SP3 scorer, later).

## 3. Part A — Pre-agreed exit triggers

### 3.1 Verdict gains a structured trigger
`VERDICT_SCHEMA` adds a required, nullable field:

```
exitTrigger: null | {
  instrument: 'UNDERLYING' | 'PREMIUM',   // what to watch
  op: 'BELOW' | 'ABOVE',                  // cross direction that means "exit"
  price: number,                          // on that instrument's own scale
}
```

Prompt (v6) rule: on **HOLD** and **EXIT_ARMED**, give the numeric level at which the thesis is wrong — the
same level described in `invalidationPoint` — or `null` if there is no defensible level. On EXIT_NOW / ESCALATE it
is ignored. Scale hazard (already in the prompt): UNDERLYING levels compare to `position.underlyingLtp`, PREMIUM
levels to `position.ltp`.

### 3.2 Validation (server-side, before arming)
A trigger is rejected (verdict still stored, trigger not armed, reason logged + recorded) unless:
- `price` finite > 0; instrument's current price is known and fresh (≤ 15 s);
- it is on the **exit side**: for a long (`op` must make sense) — e.g. long + `BELOW` requires `price < current`;
  long + `ABOVE` on PREMIUM only as a profit-take is **not** allowed (exits are protective only in v1);
  short positions mirror this;
- distance sanity: UNDERLYING within 10 % of current, PREMIUM within 60 % of current (config);
- **tighten-only** (default, owner decision D4): a new trigger for the same tracker may only move the level
  *toward* the current price (a long's BELOW level may rise, never fall), unless the owner flips D4.

### 3.3 Arming
New table `sentinel_exit_triggers` (expand-only migration):
`id, userId, trackerId, verdictId (unique), instrument, op, price, watchToken, watchExchange, status
(ARMED | FIRED | SUPERSEDED | REJECTED | EXPIRED), reason, armedAt, firedAt, firedTick (price, at)`.
At most **one ARMED trigger per tracker**; a newer valid trigger supersedes it (recorded). Triggers expire when
the tracker closes, at the exchange close, or after `SENTINEL_TRIGGER_MAX_AGE_MIN` (default 240) without renewal.

### 3.4 Watching
`TriggerWatchService` holds ARMED triggers in memory keyed by `exchange:token` (rebuilt from the table on boot).
It subscribes to the market hub's tick stream for the owner's session. The underlying token (e.g. the MCX
front-month future, the NSE index/stock) is resolved the way the context packet already resolves
`underlyingLtp`, and is subscribed at top priority — **one extra feed slot per position with an UNDERLYING
trigger** (30-slot ceiling; if no slot is free the trigger falls back to PREMIUM-only or is not armed, logged).

On each tick for a watched token (O(1) lookup):
- ignore ticks older than 5 s, or while the instrument's exchange is closed;
- **confirmation**: fire only after the condition holds on `SENTINEL_TRIGGER_CONFIRM_TICKS` consecutive ticks
  (default 2) **and** for ≥ `SENTINEL_TRIGGER_CONFIRM_MS` (default 1000) — one bad print never sells;
- fire = atomic `ARMED → FIRED` update (claim; a second process/tick cannot fire it again), then hand to the
  executor.

### 3.5 Executing
The executor gains `trigger = PRICE_TRIGGER` (alongside AI verdict and MANUAL). It runs the **same guarded
pipeline**: claim row → fresh positions + order book → all guards (never exceed/reverse, OPEN_ORDER_EXISTS unless
cancel-protective is enabled, in-flight, prior-exit-today, session open) → MARKET (+ one LIMIT fallback) →
settle by ordertag → confirm. Mode follows `AI_AUTO_EXIT_MODE` (dry-run records "would sell"), counts toward the
AI daily cap, and the row links `triggerId` + `verdictId` (the decision is the LLM's, made in advance). Ordertag
prefix `at…`; prior/in-flight checks treat `ax`/`am`/`at` alike.

## 4. Part B — Tick-driven sensors

The six tripwires (level break, giveback, volume, OI wall, news, context flip) run from the 30-s cron. The
price-only ones (**level break, giveback**) additionally run on ticks for held positions, throttled to once per
second per tracker; a FIRE wakes the LLM immediately (existing judge path, existing concurrency caps). The cron
stays as the fallback and for the non-price sensors. Effect: LLM woken ≤ ~1 s after a level break instead of
≤ 30 s. CLI judge latency is unchanged (owner chose CLI); Part A is what removes the LLM from the critical path.

## 5. Configuration (`api.env`)

| var | default | meaning |
|---|---|---|
| `SENTINEL_TRIGGERS_ENABLED` | `false` | arm + watch + fire triggers |
| `SENTINEL_TRIGGER_CONFIRM_TICKS` | `2` | consecutive ticks beyond the level |
| `SENTINEL_TRIGGER_CONFIRM_MS` | `1000` | and for at least this long |
| `SENTINEL_TRIGGER_MAX_AGE_MIN` | `240` | expire unrenewed triggers |
| `SENTINEL_TRIGGER_MAX_DISTANCE_PCT` | `UNDERLYING:10,PREMIUM:60` | sanity bounds |
| `SENTINEL_TRIGGER_TIGHTEN_ONLY` | `true` | D4 |
| `SENTINEL_TICK_TRIPWIRES` | `true` | Part B |

Execution still requires `AI_AUTO_EXIT_ENABLED=true`; dry-run/live from `AI_AUTO_EXIT_MODE`.

## 6. Visibility
- Sentinel panel on Charts: the armed level ("auto-exit if CRUDEOIL FUT < 8930, armed 22:33") and its history.
- "AI exits" list: trigger fires show `PRICE_TRIGGER`, the level and the tick that fired it.
- Log line per arm / supersede / reject / fire.

## 7. Owner decisions (defaults)
- **D1** instruments: UNDERLYING and PREMIUM both allowed. *(default yes)*
- **D2** confirmation: 2 ticks and ≥ 1 s. *(default)*
- **D3** HOLD verdicts may carry a trigger (acts as an AI-set protective stop). *(default yes)*
- **D4** tighten-only. *(default yes — a later verdict can never move the stop further away)*
- **D5** profit-take triggers (`ABOVE` for a long): **not** in v1.

## 8. Testing
Pure: trigger validation table (side, distance, tighten-only, stale/unknown price); confirmation (1 tick no-fire,
2 ticks + 1 s fire, flapping resets). Service: arm/supersede/expire; boot rebuild; one fire per trigger under
concurrent ticks; fire → executor once with PRICE_TRIGGER; dry-run records only; slot exhaustion fallback;
exchange closed → no fire. Prompt v6 golden snapshot; schema accepts `exitTrigger: null`. Structural: sentinel
still cannot reach order placement (the watcher lives in sentinel-executor, reading triggers from the DB/table and
ticks from the hub).

## 9. Risks
- **LLM sets a level too tight** → frequent exits. Mitigated by distance bounds, confirmation, cap 5/day, dry-run
  first, and the owner seeing armed levels on Charts.
- **Bad tick** → confirmation (2 ticks + 1 s) and freshness.
- **Feed gap** (reconnect) → no ticks, no fire; the cron sensors + LLM still run when it returns.
- **Slot pressure** (+1 per position) → fallback to PREMIUM trigger; logged.
