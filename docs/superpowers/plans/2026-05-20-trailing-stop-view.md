# Trailing-Stop View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the live trailing-stop and effective stop-loss state for each watch entry — a new `SL` table column (hard-stop pre-trail, ratcheting trail post-partial-exit), a `TrailingStopSection` in the detail panel (grid + status line), and live updates via the existing poll.

**Architecture:** Web-only, no API change. One pure util `trailView(entry)` is the single source of truth — feeds both the table SL column and the detail-panel section. `WatchTable` passes the live polled `entry` into `WatchDetailPanel` so the panel section refreshes on every poll.

**Tech Stack:** React + TypeScript + Vite. Vitest for tests. Spec: `docs/superpowers/specs/2026-05-20-trailing-stop-view-design.md`.

**Run tests from `apps/web/`:** `npx vitest run <path>`.

---

## File Structure

- **Create** `apps/web/src/utils/trailView.ts` — pure: `trailView`, `TrailView`, `TrailState`, `SlKind`, `SL_AMBER_THRESHOLD_PCT`.
- **Create** `apps/web/src/utils/trailView.spec.ts` — vitest unit tests.
- **Create** `apps/web/src/pages/watch/TrailingStopSection.tsx` — the detail-panel section component.
- **Modify** `apps/web/src/pages/watch/WatchDetailPanel.tsx` — accept the `entry` prop, render `<TrailingStopSection>`.
- **Modify** `apps/web/src/pages/watch/WatchTable.tsx` — add SL column, rename Target → TP, drop the `½ exit` badge, pass `entry` to `<WatchDetailPanel>`.

**Implementation order:** util → component → panel wiring → table wiring → verify. Each task is independently committable.

---

### Task 1: `trailView` pure util + tests

**Files:**
- Create: `apps/web/src/utils/trailView.ts`
- Test: `apps/web/src/utils/trailView.spec.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/utils/trailView.spec.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { trailView } from './trailView';
import type { WatchEntry } from '../types/watch.types';

function entry(o: Partial<WatchEntry>): WatchEntry {
  return {
    id: 'w', alertId: null, setupId: null, symbol: 'X', token: '1', exchange: 'NSE',
    side: 'BUY', initialPrice: 100, initialScore: 60, initialBreakdown: null,
    currentBreakdown: null, initialAt: '', profitTarget: 110,
    profitTargetSource: 'fallback-2pct',
    stopLossScore: 50, status: 'WATCHING', currentPrice: null, currentScore: null,
    maxFavorable: null, maxAdverse: null, lastTickAt: null, lastRescoreAt: null,
    optionsToken: null, optionsType: null, optionsExpiry: null, optionsStrike: null,
    optionsLotSize: null, optionsSelectionScore: null, paperTradeId: null,
    liveTradeId: null, executedAt: null, executedPrice: null, quantity: null, closedAt: null,
    closedReason: null, notes: null, partialExitedAt: null, partialExitPrice: null,
    partialQty: null, remainingQty: null, trailingHighWater: null,
    trailingStopPrice: null, scannerName: null, realizedPnl: null,
    createdAt: '', updatedAt: '', ...o,
  };
}

function armedBuy(over: Partial<WatchEntry> = {}): WatchEntry {
  return entry({
    status: 'TRADED', side: 'BUY', executedPrice: 100,
    partialExitedAt: '2026-05-20T05:00:00Z' as never,
    partialQty: 750, partialExitPrice: 104, remainingQty: 750,
    trailingHighWater: 106.8, trailingStopPrice: 106.27, currentPrice: 106.5,
    ...over,
  });
}

describe('trailView — state determination', () => {
  it('returns n/a for an entry that never executed', () => {
    const v = trailView(entry({ status: 'WATCHING', executedPrice: null }));
    expect(v.state).toBe('n/a');
    expect(v.slPrice).toBeNull();
  });

  it('returns n/a for an executed entry closed without partial exit', () => {
    const v = trailView(entry({
      status: 'STOPPED', executedPrice: 100, partialExitedAt: null,
    }));
    expect(v.state).toBe('n/a');
  });

  it('returns pending for a TRADED entry whose trail is not yet armed', () => {
    expect(trailView(entry({
      status: 'TRADED', executedPrice: 100, partialExitedAt: null,
    })).state).toBe('pending');
  });

  it('returns armed once the partial exit has fired', () => {
    expect(trailView(armedBuy()).state).toBe('armed');
  });

  it('returns armed for a closed entry that had a trail (final state)', () => {
    const v = trailView(armedBuy({ status: 'EXITED' }));
    expect(v.state).toBe('armed');
    // closed → SL column hides but the trail metrics are still present
    expect(v.slPrice).toBeNull();
    expect(v.trailStop).toBe(106.27);
  });
});

describe('trailView — SL column (pending: hard stop)', () => {
  it('BUY: hard stop = executedPrice × 0.996', () => {
    const v = trailView(entry({ status: 'TRADED', executedPrice: 100 }));
    expect(v.slKind).toBe('hard');
    expect(v.slPrice).toBeCloseTo(99.6, 4);
  });

  it('SELL: hard stop = executedPrice × 1.004', () => {
    const v = trailView(entry({ status: 'TRADED', side: 'SELL', executedPrice: 100 }));
    expect(v.slPrice).toBeCloseTo(100.4, 4);
  });

  it('pending also exposes the +1% arm price', () => {
    expect(trailView(entry({ status: 'TRADED', executedPrice: 100 })).armPrice)
      .toBeCloseTo(101, 4);
  });
});

describe('trailView — SL column (armed: trail stop)', () => {
  it('uses trailingStopPrice when armed and currently TRADED', () => {
    const v = trailView(armedBuy());
    expect(v.slKind).toBe('trail');
    expect(v.slPrice).toBe(106.27);
  });
});

describe('trailView — armed metrics (BUY)', () => {
  it('realised: (partialExitPrice − executedPrice) × side × partialQty', () => {
    // (104-100) * 1 * 750 = 3000
    expect(trailView(armedBuy()).realised).toBeCloseTo(3000, 4);
  });

  it('protected: (trailStop − executedPrice) × side × remainingQty', () => {
    // (106.27-100) * 1 * 750 = 4702.5
    expect(trailView(armedBuy()).protected).toBeCloseTo(4702.5, 4);
  });

  it('lockedTotal = realised + protected', () => {
    // 3000 + 4702.5 = 7702.5
    expect(trailView(armedBuy()).lockedTotal).toBeCloseTo(7702.5, 4);
  });

  it('distancePct: ((current − trailStop)/trailStop) × side × 100 — positive when price above stop', () => {
    // ((106.5-106.27)/106.27) * 100 ≈ 0.2164%
    expect(trailView(armedBuy()).distancePct).toBeCloseTo(0.2164, 3);
  });

  it('distancePct is null when currentPrice is null', () => {
    expect(trailView(armedBuy({ currentPrice: null })).distancePct).toBeNull();
  });
});

describe('trailView — armed metrics (SELL)', () => {
  it('realised, protected, distancePct are favorable-positive on a SELL that fell', () => {
    const v = trailView(entry({
      status: 'TRADED', side: 'SELL', executedPrice: 100,
      partialExitedAt: '2026-05-20T05:00:00Z' as never,
      partialQty: 500, partialExitPrice: 96, remainingQty: 500,
      trailingHighWater: 93.2, trailingStopPrice: 93.66, currentPrice: 93.5,
    }));
    // (96-100) * -1 * 500 = +2000
    expect(v.realised).toBeCloseTo(2000, 4);
    // (93.66-100) * -1 * 500 = +3170
    expect(v.protected).toBeCloseTo(3170, 4);
    // ((93.5-93.66)/93.66) * -1 * 100 ≈ +0.1708%
    expect(v.distancePct).toBeCloseTo(0.1708, 3);
  });
});
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `cd apps/web && npx vitest run src/utils/trailView.spec.ts`
Expected: FAIL — `Cannot find module './trailView'`.

- [ ] **Step 3: Write `trailView.ts`**

Create `apps/web/src/utils/trailView.ts`:

```typescript
import type { WatchEntry } from '../types/watch.types';

/** Hard loss-cut price-fraction (R5 mirror): 0.4% of deployed capital. */
const HARD_STOP_PCT = 0.004;
/** Partial-exit arm threshold (mirror): +1% favorable from entry. */
const PARTIAL_EXIT_THRESHOLD_PCT = 0.01;
/** When the trail stop sits within this % of the current price, the SL cell is amber. */
export const SL_AMBER_THRESHOLD_PCT = 0.1;

export type TrailState = 'n/a' | 'pending' | 'armed';
export type SlKind = 'hard' | 'trail';

export interface TrailView {
  state: TrailState;
  /** SL column value; non-null only when the entry is currently TRADED (open). */
  slPrice: number | null;
  slKind: SlKind | null;
  /** pending only: the +1% favorable price at which the trail arms. */
  armPrice: number | null;
  // armed metrics — null when state !== 'armed':
  partialQty: number | null;
  partialExitPrice: number | null;
  remainingQty: number | null;
  highWater: number | null;
  trailStop: number | null;
  realised: number | null;
  protected: number | null;
  lockedTotal: number | null;
  /** % the current price sits beyond the trail stop (favorable); null without a current price. */
  distancePct: number | null;
}

const EMPTY: TrailView = {
  state: 'n/a',
  slPrice: null, slKind: null, armPrice: null,
  partialQty: null, partialExitPrice: null, remainingQty: null,
  highWater: null, trailStop: null,
  realised: null, protected: null, lockedTotal: null,
  distancePct: null,
};

/**
 * Map a watch entry to its live trail + SL state. Pure — single source of
 * truth for the watch table's SL column and the detail-panel
 * TrailingStopSection. Mirrors the backend's two-phase exit lifecycle
 * (R5 hard loss-cut while pre-trail, 0.5% trailing stop once partial-exited).
 */
export function trailView(entry: WatchEntry): TrailView {
  const exec = entry.executedPrice;
  if (exec == null || exec <= 0) return EMPTY;

  const sideMul = entry.side === 'BUY' ? 1 : -1;
  const isTradedOpen = entry.status === 'TRADED';
  const hasTrail = entry.partialExitedAt != null;

  // armed: trail metrics for any entry that had a partial exit (open OR closed).
  // slPrice is gated on isTradedOpen so closed entries show "—" in the SL column
  // while the panel section can still render the final/historical trail state.
  if (hasTrail) {
    const partialQty = entry.partialQty ?? 0;
    const partialExitPrice = entry.partialExitPrice ?? exec;
    const remainingQty = entry.remainingQty ?? 0;
    const highWater = entry.trailingHighWater ?? null;
    const trailStop = entry.trailingStopPrice ?? null;

    const realised = (partialExitPrice - exec) * sideMul * partialQty;
    const protectedPnl =
      trailStop != null ? (trailStop - exec) * sideMul * remainingQty : 0;
    const lockedTotal = realised + protectedPnl;

    const curr = entry.currentPrice;
    const distancePct =
      curr != null && trailStop != null && trailStop > 0
        ? ((curr - trailStop) / trailStop) * sideMul * 100
        : null;

    return {
      state: 'armed',
      slPrice: isTradedOpen ? trailStop : null,
      slKind: isTradedOpen && trailStop != null ? 'trail' : null,
      armPrice: null,
      partialQty, partialExitPrice, remainingQty,
      highWater, trailStop,
      realised, protected: protectedPnl, lockedTotal,
      distancePct,
    };
  }

  // pending: open and not yet partial-exited — the R5 hard loss-cut is the active stop.
  if (isTradedOpen) {
    return {
      ...EMPTY,
      state: 'pending',
      slPrice: exec * (1 - HARD_STOP_PCT * sideMul),
      slKind: 'hard',
      armPrice: exec * (1 + PARTIAL_EXIT_THRESHOLD_PCT * sideMul),
    };
  }

  // executed but closed before the trail ever armed → n/a
  return EMPTY;
}
```

- [ ] **Step 4: Run the tests, verify they pass**

Run: `cd apps/web && npx vitest run src/utils/trailView.spec.ts`
Expected: PASS — all describe blocks green.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/utils/trailView.ts apps/web/src/utils/trailView.spec.ts
git commit -m "feat(web): trailView util - effective SL + trail metrics from a watch entry"
```

---

### Task 2: `<TrailingStopSection>` component

**Files:**
- Create: `apps/web/src/pages/watch/TrailingStopSection.tsx`

This is a presentational component — the logic is fully covered by `trailView`'s unit tests. Verification is the next task's manual reload check.

- [ ] **Step 1: Write the component**

Create `apps/web/src/pages/watch/TrailingStopSection.tsx`:

```typescript
import type { WatchEntry } from '../../types/watch.types';
import { trailView } from '../../utils/trailView';

interface Props { entry: WatchEntry }

function fmtRupeesInt(n: number): string {
  const sign = n > 0 ? '+' : '';
  return `${sign}₹${n.toFixed(0)}`;
}

function fmtPct(n: number): string {
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}%`;
}

/**
 * Live trailing-stop state for a watch entry, rendered in WatchDetailPanel.
 *   armed   → metrics grid + plain-English status line.
 *   pending → one-liner: "Trail not armed — arms at +1% (₹X)".
 *   n/a     → nothing (section omitted).
 *
 * Hidden entirely for options legs — the backend's partial-exit / trailing
 * logic is equity-only, so "arms at +1%" would be misleading there.
 */
export function TrailingStopSection({ entry }: Props) {
  if (entry.optionsToken != null) return null;

  const v = trailView(entry);
  if (v.state === 'n/a') return null;

  if (v.state === 'pending') {
    return (
      <div className="text-sm text-[var(--color-text-muted)] mb-4">
        Trailing stop — not armed. Arms at +1% (₹{v.armPrice!.toFixed(2)}).
      </div>
    );
  }

  // armed
  const isFinal = entry.status !== 'TRADED';
  const curr = entry.currentPrice;
  return (
    <div className="mb-4 p-3 bg-[var(--color-bg-tertiary)]/40 rounded border border-[var(--color-border-subtle)]">
      <div className="flex items-baseline justify-between mb-2">
        <div className="text-xs text-[var(--color-text-muted)]">Trailing stop</div>
        {isFinal && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)]">
            final
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm tabular-nums">
        <div>
          <span className="text-[var(--color-text-muted)] mr-2">Half-exit</span>
          <span className="text-[var(--color-text-primary)]">
            {v.partialQty} @ ₹{v.partialExitPrice!.toFixed(2)}
          </span>
        </div>
        <div>
          <span className="text-[var(--color-text-muted)] mr-2">Realised</span>
          <span className={v.realised! >= 0 ? 'text-emerald-400' : 'text-red-400'}>
            {fmtRupeesInt(v.realised!)}
          </span>
        </div>
        <div>
          <span className="text-[var(--color-text-muted)] mr-2">Remaining</span>
          <span className="text-[var(--color-text-primary)]">{v.remainingQty} shares</span>
        </div>
        <div>
          <span className="text-[var(--color-text-muted)] mr-2">High-water</span>
          <span className="text-[var(--color-text-primary)]">
            {v.highWater != null ? `₹${v.highWater.toFixed(2)}` : '—'}
          </span>
        </div>
        <div>
          <span className="text-[var(--color-text-muted)] mr-2">Trail stop</span>
          <span className="text-[var(--color-text-primary)]">
            {v.trailStop != null ? `₹${v.trailStop.toFixed(2)}` : '—'}
          </span>
        </div>
        <div>
          <span className="text-[var(--color-text-muted)] mr-2">Distance</span>
          <span className="text-[var(--color-text-primary)]">
            {v.distancePct != null ? fmtPct(v.distancePct) : '—'}
          </span>
        </div>
        <div>
          <span className="text-[var(--color-text-muted)] mr-2">Protected</span>
          <span className={v.protected! >= 0 ? 'text-emerald-400' : 'text-red-400'}>
            {fmtRupeesInt(v.protected!)}
          </span>
        </div>
        <div>
          <span className="text-[var(--color-text-muted)] mr-2">Locked total</span>
          <span className={`font-medium ${v.lockedTotal! >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
            {fmtRupeesInt(v.lockedTotal!)}
          </span>
        </div>
      </div>

      <div className="text-xs text-[var(--color-text-secondary)] mt-2">
        ▸ Trailing 0.5% under the ₹{v.highWater?.toFixed(2) ?? '—'} high-water — price
        {curr != null ? ` ₹${curr.toFixed(2)}` : ''} is{' '}
        {v.distancePct != null ? fmtPct(v.distancePct) : '—'} above the stop.
        {' '}{fmtRupeesInt(v.lockedTotal!)} secured.
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Type-check the new file**

Run: `cd apps/web && npx tsc -b`
Expected: no NEW errors in `TrailingStopSection.tsx`. (Pre-existing errors in `SignalCard.tsx`, `ChartsPage.tsx`, `useChartData.ts`, `signal-store.ts` are not ours — ignore them.)

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/pages/watch/TrailingStopSection.tsx
git commit -m "feat(web): TrailingStopSection component - panel-side trail view"
```

---

### Task 3: Wire `TrailingStopSection` into `WatchDetailPanel`

**Files:**
- Modify: `apps/web/src/pages/watch/WatchDetailPanel.tsx`

`WatchDetailPanel` currently takes `{ entryId, onClose }` and fetches the full `WatchEntryWithEvents` itself. To make the trail section live, it must also accept the live polled `entry` as a prop from `WatchTable` and use it for the display fields (stat grid, trail section). The fetched `detail` is retained for the event log only.

- [ ] **Step 1: Read the file**

Read `apps/web/src/pages/watch/WatchDetailPanel.tsx` to confirm the current structure (the existing `Props`, the `entry`/`setEntry` state, the stat grid block, the `<WatchEventLog>` render, the buttons).

- [ ] **Step 2: Modify the component**

Make these exact changes:

a) Update the imports at the top — add `WatchEntry` and `TrailingStopSection`:

```typescript
import { useEffect, useState } from 'react';
import { watchApi } from '../../services/watch.service';
import type { WatchEntry, WatchEntryWithEvents } from '../../types/watch.types';
import { WatchEventLog } from './WatchEventLog';
import { TrailingStopSection } from './TrailingStopSection';
```

b) Update `Props` to accept an optional live entry:

```typescript
interface Props { entryId: string; entry?: WatchEntry; onClose?: () => void }
```

c) Update the function signature and rename the local state to `detail` (so it doesn't shadow the prop):

```typescript
export function WatchDetailPanel({ entryId, entry: liveEntry, onClose }: Props) {
  const [detail, setDetail] = useState<WatchEntryWithEvents | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setError(null);
    try {
      const data = await watchApi.get(entryId);
      setDetail(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  // ...rest unchanged through useEffect / execute / dismiss...
```

d) Replace every reference to the old `entry` state with `view` — a live-first projection. Add this just before the "no data" early return:

```typescript
  // Live-first: prefer the polled entry from the table (so the stat grid +
  // trail section refresh live), fall back to the fetched detail. The event
  // log always reads from `detail` (only the fetch carries events).
  const view: WatchEntry | WatchEntryWithEvents | null = liveEntry ?? detail;

  if (!view) {
```

…and change the loading-block test from `if (!entry)` to `if (!view)`. Inside the loading block, replace `entry` references (there are none in that block; just leave the existing markup). Below that, every `entry.symbol`, `entry.side`, `entry.status`, `entry.initialAt`, `entry.initialPrice`, `entry.initialScore`, `entry.currentPrice`, `entry.currentScore`, `entry.profitTarget`, `entry.profitTargetSource`, `entry.maxFavorable`, `entry.maxAdverse`, `entry.stopLossScore`, `entry.optionsToken`, `entry.optionsStrike`, `entry.optionsType`, `entry.optionsExpiry`, `entry.optionsSelectionScore` becomes `view.X`. The Execute/Dismiss button gate `entry.status === 'WATCHING'` becomes `view.status === 'WATCHING'`.

e) Replace the event-log block. It currently reads `<WatchEventLog events={entry.events} />`. The events come from the FETCH, not the live prop. Use `detail`:

```typescript
      <div className="mb-4">
        <div className="text-xs text-[var(--color-text-muted)] mb-2">Event log</div>
        <WatchEventLog events={detail?.events ?? []} />
      </div>
```

f) Render the trail section between the options-leg block and the event-log block:

```typescript
      <TrailingStopSection entry={view as WatchEntry} />
```

(`view` is `WatchEntry | WatchEntryWithEvents`; `WatchEntryWithEvents` extends `WatchEntry` so the cast is sound. If `tsc` complains, drop the cast — TS narrowing may already accept it.)

- [ ] **Step 3: Type-check**

Run: `cd apps/web && npx tsc -b`
Expected: no NEW errors in `WatchDetailPanel.tsx`. If TS complains about the `view as WatchEntry` cast, change it to just `entry={view}` — `WatchEntryWithEvents extends WatchEntry`, so the cast is for clarity, not necessity.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/pages/watch/WatchDetailPanel.tsx
git commit -m "feat(web): WatchDetailPanel accepts live entry prop, renders TrailingStopSection"
```

---

### Task 4: `WatchTable` — SL column, rename Target → TP, drop badge, pass entry

**Files:**
- Modify: `apps/web/src/pages/watch/WatchTable.tsx`

- [ ] **Step 1: Update the imports**

In `apps/web/src/pages/watch/WatchTable.tsx`, change line 3 to add `trailView` and `SL_AMBER_THRESHOLD_PCT`:

```typescript
import { profitView, whatIfView, isClosed, breakdownChecks } from '../../utils/watchPnl';
import { trailView, SL_AMBER_THRESHOLD_PCT } from '../../utils/trailView';
```

- [ ] **Step 2: Remove the `½ exit · trail ₹X` badge in the Symbol cell**

In the Symbol `<td>` (around lines 142-149), DELETE the `{e.partialExitedAt && (...)}` block. The cell becomes just:

```typescript
              <td className="py-2 px-3 font-mono text-[var(--color-text-primary)]">
                {e.symbol}
              </td>
```

The SL column carries that information now.

- [ ] **Step 3: Add the SL `<th>`, rename Target → TP**

In `<thead>` (around lines 105-109), replace the current `<th>Target</th>` cell with an `SL` `<th>` immediately followed by a renamed `TP` `<th>`. Replace these lines:

```typescript
          <th className="py-2 px-3 text-right">Target</th>
```

with:

```typescript
          <th className="py-2 px-3 text-right" title="Live stop: hard −0.4% loss-cut before partial exit; trailing stop after.">SL</th>
          <th className="py-2 px-3 text-right" title="Profit target (re-anchored to the live fill on execute).">TP</th>
```

- [ ] **Step 4: Add the SL `<td>` and compute the trail per row**

In the `entries.map((e) => { ... })` block, near the top of the lambda where `const p = ...` is computed (around line 123), add a `const t = trailView(e)` line right after it:

```typescript
          const isWhatIf =
            !(isClosed(e.status) && e.realizedPnl != null) && e.status !== 'TRADED';
          const p = isWhatIf ? whatIfView(e) : profitView(e);
          const t = trailView(e);
          const slAmber =
            t.state === 'armed' && t.distancePct != null && t.distancePct < SL_AMBER_THRESHOLD_PCT;
```

Then locate the existing Target `<td>` (around line 217 — `<td>{e.profitTarget.toFixed(2)}</td>`). Insert ONLY the SL `<td>` immediately before it. The existing Target `<td>` is left intact (the column rename was just the `<th>` text in Step 3 — the cell content is unchanged and now serves as the TP cell).

Insert this single `<td>` BEFORE the existing Target/TP `<td>`:

```typescript
              <td
                className={`py-2 px-3 text-right tabular-nums ${
                  slAmber ? 'text-amber-400' : 'text-[var(--color-text-primary)]'
                }`}
                title={t.slKind ? `${t.slKind} stop` : undefined}
              >
                {t.slPrice != null ? (
                  <>
                    ₹{t.slPrice.toFixed(2)}
                    <span className="ml-1 text-[10px] text-[var(--color-text-muted)]">{t.slKind}</span>
                  </>
                ) : (
                  <span className="text-[var(--color-text-muted)]">—</span>
                )}
              </td>
```

- [ ] **Step 5: Pass the live entry to `<WatchDetailPanel>`**

The detail row (around line 268-275) currently reads `<WatchDetailPanel entryId={e.id} onClose={() => onSelect(null)} />`. Add the `entry` prop:

```typescript
                  <WatchDetailPanel
                    entryId={e.id}
                    entry={e}
                    onClose={() => onSelect(null)}
                  />
```

- [ ] **Step 6: Update the `colSpan` on the expanded-row cell**

The expanded detail row (around line 269) currently spans `colSpan={23}`. Adding the SL column makes it **24**. Change `colSpan={23}` to `colSpan={24}`.

- [ ] **Step 7: Type-check + run web tests**

Run: `cd apps/web && npx tsc -b` — no new errors in `WatchTable.tsx`.
Run: `cd apps/web && npx vitest run` — all green (the existing 115 tests + the new `trailView` tests).

- [ ] **Step 8: Visual smoke-check on the running app**

The Vite dev server (`localhost:4000`) hot-reloads automatically. Open the watch page and confirm:
- A new `SL` column appears between `P&L %` and `TP`.
- `Target` column header now reads `TP`.
- A TRADED entry that hasn't partial-exited shows `₹X hard` in SL.
- A partially-exited entry (any `½ exit ...` row you previously saw) now shows the trail stop in SL and the badge next to the symbol is gone.
- Clicking such a row opens the detail panel and shows the new "Trailing stop" section with the grid + status line.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/pages/watch/WatchTable.tsx
git commit -m "feat(web): live SL column, Target -> TP, drop ½ badge, pass entry to detail panel"
```

---

### Task 5: Full verification

- [ ] **Step 1: Run the full web test suite**

Run: `cd apps/web && npx vitest run`
Expected: ~14 test files / ~125 tests, all PASS (115 existing + ~10 new `trailView` tests).

- [ ] **Step 2: Full type-check**

Run: `cd apps/web && npx tsc -b`
Expected: no NEW errors in `trailView.ts`, `TrailingStopSection.tsx`, `WatchTable.tsx`, `WatchDetailPanel.tsx`. (Ignore the pre-existing errors in `SignalCard.tsx`, `ChartsPage.tsx`, `useChartData.ts`, `signal-store.ts`.)

- [ ] **Step 3: Manual smoke on `localhost:4000/watch`**

Hard-refresh the watch page (`Ctrl+Shift+R`) and check:
- `SL` and `TP` columns are present and rendered.
- For a known partial-exited entry: SL shows the trail stop, distance turns amber if < 0.1% from the stop, panel section shows the grid + status line, and both update as the table polls.
- For a TRADED-but-not-yet-armed entry: SL shows the hard stop with the `hard` tag, panel shows the "not armed" one-liner.
- For a WATCHING/closed entry: SL shows `—`, no panel section.

- [ ] **Step 4: Commit anything adjusted during verification**

```bash
git status
# commit any small test-expectation tweaks if needed
```

---

## Notes for the implementer

- `trailView` is the single source of truth — every UI surface (SL column, panel section) reads from it. Don't compute the SL / trail metrics anywhere else.
- The `partialExitedAt` field is a string|null at the type level. Tests cast a string with `as never` because the type may be `Date | string | null`.
- The TypeScript `protected` field on `TrailView` is a property name (legal), not a class modifier. The local variable in `trailView` is named `protectedPnl` (`protected` is reserved in strict-mode variable bindings).
- The `½ exit · trail ₹X` badge in the symbol cell is intentionally removed — the SL column carries the same data plus more (distance, hard-stop case, kind). Don't keep both.
- Live updates come for free from `useWatchEntries`' existing poll — no new polling is added. The `WatchDetailPanel`'s own fetch is kept ONLY for the event log; everything else flows from the prop.
