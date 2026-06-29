# Trailing-Stop View — Design Spec

**Date:** 2026-05-20
**Status:** Approved (design)
**Branch:** `feature/trailing-stop-view`

## Problem

A TRADED watch entry has a real two-phase exit lifecycle — a partial exit at +1% (half-position, profit banked) followed by a 0.5% trailing stop on the remainder — implemented in `apps/api/src/modules/watch-monitor/services/watch.service.ts`. The data is all on the entry (`partialExitedAt`, `partialExitPrice`, `partialQty`, `remainingQty`, `trailingHighWater`, `trailingStopPrice`), but the web surfaces only a 1-line `½ exit · trail ₹X` badge in `WatchTable.tsx` and a couple of event-log lines in `WatchDetailPanel.tsx`. The stat grid in `WatchDetailPanel` shows none of the trail state. There's no view of *where the stop currently is*, how far the price is from it, how much profit is locked, or whether the trail is ratcheting — neither at-a-glance across positions nor in depth for one position.

Separately, the watch table has a "Target" (TP) column but no SL column: a position's actual live stop — the −0.4% hard loss-cut while pre-trail, the trailing stop once armed — isn't shown anywhere.

## Requirements

**R1 — Single source of truth for the trail/SL state.** One pure web util (`trailView`) maps a `WatchEntry` to its live trail + stop state. The table column and the detail-panel section both read from it.

**R2 — Live SL column in the table.** Shows the price the position would *actually* be cut at right now — the R5 −0.4% hard loss-cut while the trail isn't yet armed, the trailing stop once it is. Updates on the table's existing poll cadence.

**R3 — TP column.** Rename the existing "Target" column to "TP" (value unchanged: `entry.profitTarget`). No new TP logic.

**R4 — Drop the redundant `½ exit · trail ₹X` symbol badge.** Replaced by the SL column.

**R5 — Detail-panel section.** A new `<TrailingStopSection>` rendered in `WatchDetailPanel` after the stat grid:
- `armed` → metrics grid + one-line plain-English status, per the approved layout (half-exit qty/price, realised, remaining qty, high-water, trail stop, distance %, protected, locked total, status line).
- `pending` (TRADED, trail not yet armed) → a one-liner: "Trail not armed — arms at +1% (₹X)".
- `n/a` → section omitted.

**R6 — Live updates.** `WatchTable` passes the live polled `entry` to `WatchDetailPanel` as a prop; the panel uses it for the trail section and stat grid. So both the SL column and the open panel section refresh on every poll, and the user sees the trail ratchet in near-real-time. The panel keeps its existing `watchApi.get(entryId)` only for the event log.

## Design

### `trailView(entry)` — pure web util

`apps/web/src/utils/trailView.ts`. Given a `WatchEntry`, returns:

```
state         : 'n/a' | 'pending' | 'armed'
slPrice       : number | null    // SL column value; non-null only when entry is currently TRADED
slKind        : 'hard' | 'trail' | null
armPrice      : number | null    // pending only: the +1% price at which the trail arms
// armed only:
partialQty, partialExitPrice, remainingQty, highWater, trailStop
realised      : number          // gross, price-based: (partialExitPrice − executedPrice) × side × partialQty
protected     : number          // (trailStop − executedPrice) × side × remainingQty — guaranteed floor
lockedTotal   : number          // realised + protected
distancePct   : number | null   // ((currentPrice − trailStop)/trailStop) × side × 100; null when no currentPrice
```

**State determination:**
- `executedPrice == null` → `n/a`.
- `partialExitedAt != null` → `armed` (regardless of whether status is TRADED or already closed — the panel can still show the final trail state for a closed position).
- `status === 'TRADED'` (and no partial exit yet) → `pending`.
- otherwise (executed but closed without ever arming a trail) → `n/a`.

**SL column gating:** `slPrice` is non-null **only when `status === 'TRADED'`**. Closed entries → `slPrice = null` → SL cell renders `—`.
- `pending`: `slPrice = executedPrice × (1 − 0.004 × sideMul)`, `slKind = 'hard'`.
- `armed` AND `status === 'TRADED'`: `slPrice = trailingStopPrice`, `slKind = 'trail'`.

**Side handling:** `sideMul = entry.side === 'BUY' ? +1 : −1`.

**Constants (mirror backend):** `HARD_STOP_PCT = 0.004` (R5), `PARTIAL_EXIT_THRESHOLD_PCT = 0.01` (arm trigger). The 0.5% trailing distance is baked into `trailingStopPrice` server-side and is not recomputed client-side.

### Table column changes — `WatchTable.tsx`

- **Add** an `SL` `<th>` immediately before the existing Target column.
  - Cell: `slPrice ? fmt(slPrice) + small-tag(slKind)` else `—`.
  - Subtle colour: muted normally; amber when `armed` and the trail stop is within 0.1% of the current price (about to trigger).
- **Rename** the existing "Target" `<th>` → `TP` (value unchanged).
- **Drop** the `½ exit · trail ₹X` badge that currently appears in the Symbol cell when `partialExitedAt` is set — the SL column replaces it.
- **Pass** the live `entry` object to `WatchDetailPanel` as a prop (in addition to `entryId`).

The column order around the change becomes:
`… Price · Δ% · P&L · P&L% · SL · TP · Status · …`

### Detail-panel section — `<TrailingStopSection>` (new component)

`apps/web/src/pages/watch/TrailingStopSection.tsx`. Props: `{ entry: WatchEntry }`. Internally calls `trailView(entry)` and renders per the state:

- `n/a` → renders nothing.
- `pending` → one line: `Trailing stop — not armed. Arms at +1% (₹{armPrice})`.
- `armed` → the grid + status line from the approved mockup:

```
── Trailing stop ──────────────────────────
 Half-exit    {partialQty} @ ₹{partialExitPrice}    Realised  {±₹realised}
 Remaining    {remainingQty} shares                 High-water ₹{highWater}
 Trail stop   ₹{trailStop}                          Distance  {±distancePct%}
 Protected    {±₹protected}                         Locked total {±₹lockedTotal}
 ▸ Trailing 0.5% under the ₹{highWater} high-water — price ₹{currentPrice}
   is {distancePct%} above the stop. {±₹lockedTotal} secured.
```

For an `armed` entry whose status is closed (e.g. EXITED), the section renders the final trail state with a "final" label so the user can review how the trail performed.

`WatchDetailPanel` is updated to:
1. Accept a new optional `entry` prop (the live entry from `WatchTable`).
2. Render `<TrailingStopSection entry={livePropEntry ?? fetchedEntry}>` between the stat grid and the event log.

### Live updates

- The watch table is already polled by `useWatchEntries`. Adding the SL column → live for free (each poll re-renders the row).
- The detail panel's trail section reads from the live `entry` prop → re-renders on each poll. The watch table's `entries.map((e) => …)` always passes the current `e`. The panel's own `watchApi.get` is retained for the event-log only.

### Files

- **Create**
  - `apps/web/src/utils/trailView.ts`
  - `apps/web/src/utils/trailView.spec.ts`
  - `apps/web/src/pages/watch/TrailingStopSection.tsx`
- **Modify**
  - `apps/web/src/pages/watch/WatchTable.tsx` — add SL column, rename Target → TP, drop the `½ exit` badge, pass live `entry` to `<WatchDetailPanel>`.
  - `apps/web/src/pages/watch/WatchDetailPanel.tsx` — accept the optional `entry` prop, render `<TrailingStopSection>`.

## Edge cases

- **`currentPrice == null`** — `distancePct` is null; the panel renders `—` for distance. SL column unaffected (`slPrice` doesn't need `currentPrice`).
- **SELL side** — every formula uses `sideMul`. Hard stop = `executedPrice × 1.004`; arm price = `executedPrice × 0.99`. The trail stop comes from the backend and is already side-aware.
- **Options leg** — partial-exit / trailing is equity-only server-side, so an options TRADED entry stays `pending` (hard-stop only). The SL column shows the hard stop correctly.
- **Closed-with-trail entry** — `state = 'armed'`, `slPrice = null` (closed; column shows `—`), panel renders the final/historical trail state with a "final" label.
- **Closed-without-trail entry** — `state = 'n/a'`, no SL, no panel section.
- **Just-armed / amber threshold** — when armed and `distancePct < 0.1%`, the SL cell is rendered amber (about to trigger).

## Risk

- The detail panel now takes data from two sources (the live entry prop for the trail section / stat grid, its own fetch for the event log). The split is intentional and contained, but worth being explicit about: the entry prop is the source of truth for tick-frequency state; the fetch is only for the slower-changing event list.
- Removing the symbol-cell `½ exit` badge is a visible change; the SL column carries the same information (plus distance and the hard-stop case).

## Testing

- `trailView` — full unit coverage in `trailView.spec.ts` (vitest): the three states (n/a / pending / armed), BUY and SELL, hard-stop vs trailing SL, the four derived metrics (`realised`, `protected`, `lockedTotal`, `distancePct`), null `currentPrice`, closed-with-trail (slPrice null, metrics present).
- `TrailingStopSection` — a light vitest render test asserting that `armed`/`pending`/`n/a` produce the right surface (full grid / one-liner / nothing).
- `WatchTable` SL column — exercised manually + via `trailView` unit tests (the cell content is a direct projection of `trailView`).

## Out of scope

- **No API change.** Every field used is already on the `WatchEntry` and already sent.
- **The score-decay stop** (`stopLossScore`) is *not* the SL column. The SL column is the price stop. The score-decay stop remains as the "SL (score)" stat in the existing panel grid.
- **Charges.** The `realised`, `protected`, and `lockedTotal` numbers are gross / price-based, consistent with the panel's other price-derived stats. They are not net of R6 SEBI charges. (If a netted view is wanted later it's a separate follow-up.)
- **Server-side what-if re-quoting** and other open follow-ups are out of scope.
