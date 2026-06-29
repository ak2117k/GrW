# S/R Evidence — Support-Side Fairness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the S/R evidence engine select volume nodes per-side of the live price so the support side is no longer starved of volume evidence when price sits low in its range.

**Architecture:** A single pure function, `computeVolumeNodes`, currently returns the global top-5 highest-volume price buckets. Change *selection* to top-5 above LTP + top-5 below LTP, while keeping the global average for scoring (honest, cross-side-comparable scores). No downstream changes — `scoreAndCluster`, `SrEvidenceService`, and the web `buildSRView` consume the richer evidence unchanged.

**Tech Stack:** TypeScript, NestJS, Jest. All work is in `apps/api`.

**Spec:** `docs/superpowers/specs/2026-06-08-sr-evidence-support-fairness-design.md`

---

### Task 1: Per-side volume-node selection

**Files:**
- Modify: `apps/api/src/modules/signal-generator/services/volume-profile.ts:45-52`
- Test: `apps/api/src/modules/signal-generator/services/volume-profile.spec.ts`

All test/lint commands run from the `apps/api` directory.

- [ ] **Step 1: Write the failing test for the per-side guarantee**

Add this test inside the existing `describe('computeVolumeNodes', ...)` block in
`apps/api/src/modules/signal-generator/services/volume-profile.spec.ts`. The
helper `c(close, volume)` already exists at the top of the file.

```ts
  it('surfaces a below-LTP node even when the top-5 volume buckets are all above LTP', () => {
    const candles: ProfileCandle[] = [];
    // Five heavy shelves ABOVE ltp (200): 210..250, volumes 500..900 — these are
    // the global top-5 by volume.
    for (const p of [210, 220, 230, 240, 250]) {
      for (let i = 0; i < 6; i++) candles.push(c(p, 500 + (p - 210) * 10));
    }
    // One lighter-but-real shelf BELOW ltp at 180 (volume 100 each) — never in
    // the global top-5, but the strongest node on the support side.
    for (let i = 0; i < 6; i++) candles.push(c(180, 100));

    const nodes = computeVolumeNodes(candles, 5, 200);

    // Global top-5 would be all-above; per-side selection must keep the 180 shelf.
    expect(nodes.some((n) => n.price < 200)).toBe(true);
    expect(nodes.some((n) => Math.round(n.price) === 180)).toBe(true);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/modules/signal-generator/services/volume-profile.spec.ts -t "surfaces a below-LTP node"`
Expected: FAIL — no node with `price < 200` is returned (the global top-5 are all above LTP).

- [ ] **Step 3: Implement per-side selection**

In `apps/api/src/modules/signal-generator/services/volume-profile.ts`, add the
constant near the top of the file (just below the imports/interfaces, before
`computeVolumeNodes`):

```ts
const NODES_PER_SIDE = 5;
```

Then replace the final two lines of `computeVolumeNodes` — currently:

```ts
  nodes.sort((a, b) => b.volume - a.volume);
  return nodes.slice(0, 5);
}
```

with per-side selection (the `nodes` array of all scored buckets is built
unchanged above this point):

```ts
  // Select the strongest nodes on EACH side of the live price, not the global
  // top-N. Volume is the biggest single evidence contributor; when price sits
  // low in its range every heavy-volume bucket is overhead, which would starve
  // the support side. `avgVol` above stays global so scores remain honest and
  // cross-side comparable — a small support node still scores low.
  const byVolumeDesc = (a: VolumeNode, b: VolumeNode) => b.volume - a.volume;
  const above = nodes.filter((n) => n.price > ltp).sort(byVolumeDesc).slice(0, NODES_PER_SIDE);
  const below = nodes.filter((n) => n.price < ltp).sort(byVolumeDesc).slice(0, NODES_PER_SIDE);
  return [...above, ...below];
}
```

- [ ] **Step 4: Run the new test to verify it passes**

Run: `npx jest src/modules/signal-generator/services/volume-profile.spec.ts -t "surfaces a below-LTP node"`
Expected: PASS

- [ ] **Step 5: Update the `'caps at 5 nodes'` test to a per-side cap**

The old test asserted a global cap of 5. The cap is now per-side (≤10 total,
≤5 each side). Replace the existing `it('caps at 5 nodes', ...)` block with:

```ts
  it('caps at 5 nodes per side (<= 10 total)', () => {
    const candles: ProfileCandle[] = [];
    for (let i = 0; i < 40; i++) candles.push(c(100 + i, 10 + i));
    const ltp = 120;
    const nodes = computeVolumeNodes(candles, 1, ltp);
    expect(nodes.length).toBeLessThanOrEqual(10);
    expect(nodes.filter((n) => n.price > ltp).length).toBeLessThanOrEqual(5);
    expect(nodes.filter((n) => n.price < ltp).length).toBeLessThanOrEqual(5);
  });
```

- [ ] **Step 6: Add the all-one-side regression guard**

Add this test inside the same `describe` block. It proves resistance is
non-regressive: when all volume is overhead, the function still returns that
side's top nodes and invents nothing below.

```ts
  it('all volume above LTP → returns above-side nodes, none invented below', () => {
    const candles: ProfileCandle[] = [];
    for (const p of [210, 220, 230, 240, 250]) {
      for (let i = 0; i < 4; i++) candles.push(c(p, 300));
    }
    const ltp = 200;
    const nodes = computeVolumeNodes(candles, 5, ltp);
    expect(nodes.length).toBeGreaterThan(0);
    expect(nodes.every((n) => n.price > ltp)).toBe(true);
  });
```

- [ ] **Step 7: Run the full volume-profile suite**

Run: `npx jest src/modules/signal-generator/services/volume-profile.spec.ts`
Expected: PASS — all tests green (the two new tests, the updated cap test, and
the four pre-existing tests: `< 10 candles → []`, highest-volume node + score,
boundary 9/10, all-zero volume → score 0).

- [ ] **Step 8: Run the dependent suites to confirm no downstream regression**

Run: `npx jest src/modules/signal-generator/services/sr-evidence-scoring.spec.ts src/modules/signal-generator/services/sr-evidence.service.spec.ts`
Expected: PASS — `scoreAndCluster` and `SrEvidenceService` are unchanged and
should be unaffected.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/modules/signal-generator/services/volume-profile.ts apps/api/src/modules/signal-generator/services/volume-profile.spec.ts
git commit -m "feat(sr): per-side volume-node selection so support isn't starved

computeVolumeNodes returned the global top-5 volume buckets, so when
price sits low in its range every heavy node is overhead and the support
side gets no VOLUME evidence. Select top-5 per side instead; keep the
global average for honest, cross-side-comparable scoring. Resistance is
unchanged when all volume is overhead.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Verify against live CRUDEOIL data

**Files:** none (manual verification).

The `SrEvidenceService` caches results for 15 minutes, so a restart (or 15-min
wait) is needed for the change to show. The API runs under `nest --watch`;
saving the `.ts` file triggers a rebuild (see project note: killing dist/main
does not auto-respawn, but touching source does).

- [ ] **Step 1: Confirm the API rebuilt**

After the commit, the watcher should have rebuilt. Confirm the API is serving:
Run: `curl -s "http://127.0.0.1:4001/api/market-data/indices" -o NUL -w "%{http_code}\n"`
Expected: `200`

- [ ] **Step 2: Re-query sr-evidence for CRUDEOIL futures**

Run: `curl -s "http://127.0.0.1:4001/api/signals/sr-evidence?token=499095&exchange=MCX&symbol=CRUDEOIL"`
Expected: at least one `support`-side level now carries `VOLUME` in its `kinds`
(previously the only support was `8500` with `[ROUND, OI_PUT]` and no VOLUME),
**provided** CRUDEOIL traded with real volume below the current LTP in the last
10 days. If price is genuinely at an all-time-low shelf with no below-volume,
support may still be thin — that is the intended honest behavior, not a failure.

- [ ] **Step 3: Confirm in the chart UI**

Open `http://localhost:4000`, select CRUDEOIL (MCX), 15m timeframe. Confirm a
support evidence line (teal VOLUME styling per `EvidenceLevelOverlay`) now
appears below price, and the top-right S/R chip's support reflects an evidenced
level. Note the 15-min evidence cache TTL.

---

## Self-Review

**Spec coverage:**
- Per-side selection with global average → Task 1, Step 3. ✓
- Honest scoring unchanged → global `avgVol` preserved (Step 3 comment + code). ✓
- Non-regressive for resistance → Task 1, Step 6 regression test. ✓
- TDD failing-first per-side test → Task 1, Steps 1–2. ✓
- Updated cap test → Task 1, Step 5. ✓
- Existing tests still pass → Task 1, Step 7. ✓
- Downstream untouched → Task 1, Step 8. ✓
- Success criteria (live CRUDEOIL gains VOLUME-backed support) → Task 2. ✓

**Placeholder scan:** No TBD/TODO; every code/test step has complete code and exact commands. ✓

**Type consistency:** `VolumeNode`, `ProfileCandle`, `computeVolumeNodes(candles, atr14, ltp)`, `NODES_PER_SIDE` used consistently with the existing module and the spec. ✓
