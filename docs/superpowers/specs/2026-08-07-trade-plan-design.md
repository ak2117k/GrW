# One Trade Plan — Decluttered Chart, Actionable Setup Card

**Date:** 2026-08-07
**Status:** Approved, ready for implementation

---

## 1. Problem

Two problems, one root.

### 1.1 The chart shows everything and says nothing

Eight labelled price lines render at once (MA R, PDH, ORH, AVWAP R, ORL, PDL,
ROUND S, plus the LTP). None is marked as the one that matters. The user has to
do the synthesis the backend is already capable of doing.

### 1.2 The setup card shows state, not a trade

The card reports the engine's internals — Confluence chips (EMA/RSI/MACD/BB/MOM),
Regime, 1H Trend, `vol 0.00×`, Grade, and a prose reason — but when no setup is
forming it says only *"No setup right now"* plus a raw debug string
(`reject:confirmation {"type":"ROUND","volumeRatio":0}`). A trader waiting at a
level learns nothing about what to wait *for*.

### 1.3 Root cause of the emptiness: index volume is always 0

`levels-context.strategy.ts`:

```ts
const volumeRatio = vma20 > 0 ? lastVolume / vma20 : 0;   // :290
...
if (volumeRatio < VOLUME_RATIO_MIN) return false;         // :523, MIN = 1.2
```

Angel reports `volume: 0` for index tokens (NIFTY 99926000 et al). So
`volumeRatio` is always `0`, `detectBreakout` always returns false, and **no
index can ever produce a breakout setup** — only reversals, whose pinbar
geometry (`:546-550`) ignores volume.

Worse, when a reversal *does* fire it is graded with `volumeRatio: 0` treated as
a real measurement. `Grade A · vol 0.00×` means "volume disconfirmed this" when
the truth is "this instrument has no volume to read".

The data does exist: `options-chain.service.ts` already carries per-strike
`ceData.volume` / `peData.volume` and already has a `metric: 'oi' | 'volume'`
switch (`:781`). An index's real participation is in its option chain.

---

## 2. Goals

1. The chart draws support, resistance and trend. Nothing else.
2. The card shows the trade to take now, or — when none is forming — the trades
   that *would* trigger, in both directions, with their conditions.
3. The drawn lines and the card's trigger levels are the same object, so they
   cannot disagree.
4. Index setups are confirmed by a volume measure that exists.

### Non-goals

- Removing any computation. MA/AVWAP/ORH/ORL/ROUND/evidence keep feeding
  scoring; they simply stop being *drawn*.
- Retuning setup thresholds or grades beyond the index-volume correction.
- A new endpoint. `TradePlan` rides the existing `ChartContextDto`.

---

## 3. Design

### 3.1 TradePlan — one object, rendered twice

```ts
export interface TradeTrigger {
  side: 'BUY' | 'SELL';
  /** The price that arms this trade. Also the line drawn on the chart. */
  triggerPrice: number;
  /** Which level it is: 'PDH' | 'PDL' | 'ORH' | 'ORL' | 'ROUND' | 'MA' | 'AVWAP' | 'PIVOT'. */
  levelSource: string;
  entry: number;
  stoploss: number;
  target: number;
  /** Reward:risk, e.g. 2.0. Computed, never hand-set. */
  rr: number;
  /** 'active' = conditions met now. 'pending' = would trigger if reached. */
  state: 'active' | 'pending';
  /** One plain sentence. No JSON, no debug payloads. */
  reason: string;
}

export interface TradePlan {
  /** A setup formed right now, if any. */
  active: TradeTrigger | null;
  /** Nearest untriggered LONG above spot. */
  above: TradeTrigger | null;
  /** Nearest untriggered SHORT below spot. */
  below: TradeTrigger | null;
}
```

Added to `ChartContextDto` as `tradePlan: TradePlan`, alongside a
`sources.tradePlan: SourceState` following the existing per-source convention
(`'empty'` = ran, nothing qualified; `'failed'` = we don't know).

`buildTradePlan` is a **pure function** of `(analysis, levels, evidence, ltp,
atr14)`. All of its inputs already exist on the composite response.

Rules:
- `active` is populated from `AnalyzeResult` when `kind === 'setup'`.
- `above` / `below` are the nearest level on each side that would produce a
  setup, with entry/SL/target pre-computed by the SAME arithmetic the live
  setup path uses — extracted and shared, not reimplemented, so a pending trade
  and the trade it becomes cannot disagree.
- Targets use the existing R:R convention; `rr` is derived from
  `|target − entry| / |entry − stoploss|`.
- A side with no qualifying level is `null`. Null is a legitimate answer and
  renders as "nothing set up on this side" — never a fabricated level.

### 3.2 Chart

Draws exactly three things:

| Element | Source |
|---|---|
| Resistance line | `tradePlan.above.triggerPrice`, labelled `R {price} {levelSource}` |
| Support line | `tradePlan.below.triggerPrice`, labelled `S {price} {levelSource}` |
| Trend line | existing `trend` (unchanged) |

`LevelOverlay`, `EvidenceLevelOverlay` and `ChartZoneOverlay` stop rendering on
the charts page. They are not deleted — they are still used by signal-mode
(`?signal=<id>`), which is a different, deliberate "show me everything about
this one setup" view.

When `active` is present its entry/SL/target continue to render via the existing
`EntryTargetOverlay`.

### 3.3 Card

**Active setup:** side, entry, SL, target, R:R, Grade, and the one-line reason.

**No active setup:** both forward triggers, one line each:

```
Above 24,630 (PDH)  → BUY   SL 24,590  T 24,720  1:2.0
Below 24,522 (PDL)  → SELL  SL 24,562  T 24,432  1:2.2
```

Removed from display (still computed, still gating): Confluence chips
(EMA/RSI/MACD/BB/MOM), Regime, 1H Trend, `vol ×`, and the raw reject-reason
debug string. **Grade is kept** — one letter, the engine's own confidence.

The raw `reject:confirmation {...}` string must never reach the UI. If nothing
qualifies on either side, the card says so in words.

### 3.4 Index volume proxy

For index tokens, `volumeRatio` is computed from **total option-chain traded
volume** (sum of `ceData.volume + peData.volume` across the chain) against its
own 20-period average, via the existing `metric: 'volume'` path.

Critically, volume becomes tri-state rather than a number that defaults to 0:

| Situation | volumeRatio | Effect |
|---|---|---|
| Real reading | number | gates and grades as today |
| Index, chain available | number (proxy) | gates and grades as today |
| Chain unavailable / no reading | `null` | volume factor SKIPPED |

`null` means *no reading*, not *bad reading*. The breakout gate treats `null` as
"cannot confirm by volume" and falls back to the non-volume confirmation path
rather than hard-failing; the grade renormalises over the factors it does have
instead of scoring a zero. This is the same `empty`-vs-`failed` distinction the
rest of the chart pipeline runs on, and it is what stops `Grade A · vol 0.00×`.

---

## 4. Error handling

- `buildTradePlan` never throws; a missing input yields `null` triggers.
- Option-chain fetch failure ⇒ `volumeRatio: null`, logged once per
  token+interval at `warn`, never silently 0.
- `sources.tradePlan = 'failed'` only on a thrown error; a plan with all-null
  triggers is `'empty'`.

---

## 5. Testing

| Unit | Tests |
|---|---|
| `buildTradePlan` | active from a setup; both pending triggers; one-sided; none; rr arithmetic; never fabricates a level |
| shared entry/SL/target math | a pending trigger and the live setup it becomes produce identical numbers |
| index volume proxy | proxy used for index tokens; `null` when chain unavailable; real volume untouched for stocks |
| volume tri-state | `null` skips the gate and renormalises the grade; `0` from a real reading still fails it |
| chart derivation | drawn lines come from the same `TradePlan` fields the card reads |

---

## 6. Delivery slices

**Slice A — TradePlan.** Pure builder, DTO field, controller wiring.
**Slice B — index volume.** Option-chain proxy, tri-state volumeRatio, gate and
grade handling.
**Slice C — UI.** Chart down to two lines plus trend; card rebuilt.

A and B are independent. C depends on A's shape, which is fixed above.
