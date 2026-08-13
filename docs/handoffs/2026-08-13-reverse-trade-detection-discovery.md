# Session Handoff — "How do we find out a trade is going in reverse direction?" (discovery only)

**Date:** 2026-08-13
**Branch:** `main` (clean at start; HEAD `322a21f` — SR-accuracy harness)
**Theme:** Opened a brainstorm on **reversal / adverse-move detection for open trades**.
Codebase reconnaissance is done; the design is **not** started.

**Status: nothing built, nothing decided.** No code changed. The only artifact is this
handoff. The blocking clarifying question is still unanswered — see "Resume here".

---

## The question on the table

> "How can we find out the trade is going in reverse direction?"

Deliberately open. Before designing anything I need to know which of two (or more)
different detectors is wanted, because they share almost no implementation.

---

## What the reconnaissance found

### 1. The price-based signal is already computable — no new data plumbing

`TradeTracker` rows already carry, per open trade, everything a giveback detector needs:

| Field | Meaning | Source |
|---|---|---|
| `holdingHigh` / `holdingLow` | running extremes since entry (i.e. MFE / MAE in price terms) | `apps/api/src/modules/trade-tracker/services/trade-tracker.service.ts:110` (`computeTickPatch`) |
| `dayHigh` / `dayLow` | intraday extremes, **reset on IST date rollover** (`istDateString`, same file:49) | same |
| `lastLtp`, `pnl`, `pnlPercent` | latest tick + P&L off entry (`computePnl`, same file:59) | same |

So "was +8%, now +2% — it has turned" is derivable from stored state today. The tick
math is pure and unit-tested (`trade-tracker.service.spec.ts`), which makes it a cheap,
safe place to add a derived `reversal` field.

Wire contract to be aware of: `TradeTrackerDto`
(`apps/api/src/modules/trade-tracker/dto/trade-tracker.dto.ts:10`) is documented as a
**hard frontend contract — field names/types must not drift**. Any new reversal field is
an additive optional field there, plus the Portfolio page consumer.

### 2. There are THREE independent live-monitoring engines

A reversal detector added to only one covers only a slice of trades. Whichever we pick,
say so explicitly in the spec:

- `modules/trade-tracker` — broker **positions + holdings** (poller: `trade-tracker-poller.service.ts`).
- `modules/watch-monitor` — **options watches**; already owns trailing stop, partial exit,
  `risk-guard.service.ts`, `loss-reentry.ts` (`watch.service.ts` is ~1330 lines).
- `modules/adaptive-stop-track` + the `*-track` strategy modules (`ungated-track`,
  `anand-dual-track`, `breakout-swing-track`, `sell-futures-track`) — **algo-owned trades**,
  each with its own tick poller and decision gate (`adaptive-stop-decision-gate.ts`).

### 3. The *structural* ("thesis broken") variant has its own existing vocabulary

If reversal should mean "the reason for the entry is gone" rather than "P&L is slipping",
the pieces live in `modules/signal-generator`: `services/level-book.service.ts`,
`services/strong-zone-detector.service.ts`, `services/trade-plan.ts`,
`strategies/zone-reversal.strategy.ts`, plus the recent projection work
(`services/zone-projection*`, spec `docs/superpowers/specs/2026-08-10-projection-zones-design.md`).
Related recent specs worth reading before designing: `2026-08-07-trade-plan-design.md`,
`2026-08-06-chart-sr-trend-design.md`, `2026-07-11-trade-tracker-design.md`.

---

## Resume here — the unanswered question

Ask the user which meaning of "reverse direction" they want (they may want more than one;
they wanted to clarify the framing before answering):

1. **Giveback from peak** — was in profit, now retracing off `holdingHigh` (MFE giveback).
   Pure price math on data already stored.
2. **Thesis invalidated** — the S/R level that justified entry has broken, trend fit
   flipped, projection band violated. Uses level-book / zone detectors.
3. **Never went right** — adverse from the start, making new adverse extremes, bleeding
   toward stop with no favourable excursion.
4. **Options-specific** — premium falling while underlying stalls, OI walls shifting
   against the position, IV crush. Needs options-chain inputs.

Then two follow-ups that shape the design as much as the definition does:

- **Which engine / which trades?** (positions+holdings, options watches, algo tracks, or all three)
- **What is the output?** A badge/column on the Portfolio page, a Telegram alert
  (`modules/telegram` exists), an entry in `modules/insights`, or an actual **auto-exit**
  decision. Auto-exit crosses into the non-negotiable safety rules (CLAUDE.md §9) and
  would need paper-mode-first treatment.

Process note: this was opened under `superpowers:brainstorming`, so the next session
should resume that flow — clarifying questions → 2-3 approaches → design sections →
spec in `docs/superpowers/specs/` → `writing-plans`. **Do not start coding before the
spec is approved.**
