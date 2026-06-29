# S/R Evidence — Support-Side Fairness (Per-Side Volume Nodes)

> Date: 2026-06-08
> Status: Design — approved for spec
> Area: `apps/api` · signal-generator · S/R evidence engine

## Problem

On the chart's evidence-weighted S/R, the **support side is systematically
under-represented** relative to resistance. Observed live on CRUDEOIL (MCX
futures token `499095`, LTP ≈ 8,672, having fallen from a ~9,101 high):

- Resistance evidence: `8,846 (score 100, [ROUND, VOLUME, OI_CALL])` and
  `8,896 (score 100, [VOLUME, ROUND, OI_CALL, OI_PUT])`.
- Support evidence: a single `8,500 (score 57, [ROUND, OI_PUT])` — **no
  `VOLUME` kind at all**.

### Root cause

`computeVolumeNodes` (`apps/api/src/modules/signal-generator/services/volume-profile.ts`)
returns the **global top-5 highest-volume price buckets**, with no split
across the live price:

```ts
nodes.sort((a, b) => b.volume - a.volume);
return nodes.slice(0, 5);
```

Volume is the single largest evidence contributor (0–40 points; round numbers
are only 12–15, OI walls variable). When price sits in the lower part of its
recent range, the heaviest-volume buckets all lie **above** the current price,
so all five volume nodes become *resistance* evidence and the support side is
starved of the strongest evidence type. The live output proves it: every
`VOLUME`-tagged level is a resistance; zero `VOLUME` reaches support.

`scoreAndCluster` then applies `FLOOR = 35`
(`apps/api/src/modules/signal-generator/services/sr-evidence-scoring.ts`),
which culls the weak round-only support clusters (e.g. an 8,600 round at 12
points), leaving the thin support side seen on the chart.

This is structural bias, not market reality: a high-volume shelf *below* price
is real support even when the overhead resistance volume is larger.

## Goal & Philosophy

**Fair evidence, still honest.** Score the support side on the same footing as
resistance, but do not manufacture levels. If support is genuinely thin (no
volume traded below price), keep showing it thin — surface what the data
supports, no more.

This means fixing the *selection* of volume nodes (give support a seat at the
table) without changing how *scores* are computed (a genuinely small support
node still scores low and may honestly fail the floor).

## Approach

**Per-side volume-node selection** in `computeVolumeNodes`. Keep the global
average for scoring (honest, cross-side comparable); change selection from
global top-5 to **top-N above LTP + top-N below LTP**.

Rejected alternative — *inject only the single strongest below-price node*:
narrower but asymmetric, special-cases support instead of applying one uniform
rule to both sides.

## Design

### Single change: `volume-profile.ts` → `computeVolumeNodes`

The function already receives `ltp`. Today it uses `ltp` only for the bucket-size
guard; this design also uses it to split sides.

1. Build the bucket → volume map — **unchanged**.
2. Compute `avgVol` across **all** buckets (global) — **unchanged**. This is
   what keeps scoring honest: a small support node is scored relative to the
   same average as a large resistance node, so it scores low and may fail the
   downstream floor.
3. Map buckets → scored nodes (`price`, `volume`, `score`) — **unchanged**.
4. **New:** split nodes by side — `price > ltp` (above) vs `price < ltp`
   (below). Buckets are discrete (`idx * bucket`); a bucket whose price equals
   `ltp` is dropped downstream by `scoreAndCluster` (`c.price !== ltp`) so it
   needs no special handling here.
5. **New:** sort each side by volume desc and take the top `NODES_PER_SIDE = 5`
   from each.
6. Return the concatenation (≤ 10 nodes), ordered above-side then below-side.

```ts
const NODES_PER_SIDE = 5;
// ...after building `nodes`:
const above = nodes.filter((n) => n.price > ltp).sort((a, b) => b.volume - a.volume).slice(0, NODES_PER_SIDE);
const below = nodes.filter((n) => n.price < ltp).sort((a, b) => b.volume - a.volume).slice(0, NODES_PER_SIDE);
return [...above, ...below];
```

### Why this is non-regressive for resistance

When the global top-5 were all on one side (the CRUDEOIL case), that side's
top-5 are unchanged — they were the global top-5 and remain that side's top-5.
Resistance keeps the exact nodes it has today; support gains its own strongest
nodes purely additively.

### Downstream — no change

`scoreAndCluster` already sides candidates, clusters confluent prices, sums to a
0–100 score capped at 100, applies `FLOOR = 35`, and adds a `soft` round-number
fallback only when a side is empty. Support nodes flow through the identical
path:

- A weak support node honestly fails the floor → not shown (honest).
- A real volume shelf below price, clustering with the 8,600/8,500 rounds and
  the 8,500 OI_PUT, clears the floor → surfaces as a genuine support nearer
  than the lone 8,500 seen today.

`SrEvidenceService.levelsFor` (15-min cache) and `buildSRView` (web) are
untouched; they consume the richer support evidence automatically. The cache
means the change is visible after the existing 15-min TTL or an app restart.

## Components & boundaries

| Unit | Responsibility | Changes |
|------|----------------|---------|
| `computeVolumeNodes` | Volume-by-price profile → scored nodes | **Per-side top-N selection** |
| `scoreAndCluster` | Cluster + side + floor + soft fallback | none |
| `SrEvidenceService` | Orchestrate sources → `EvidenceLevel[]`, cache | none |
| `buildSRView` (web) | Fold levels into chip + overlay tiers | none |

The change is contained entirely within one pure function with a stable
signature (`candles, atr14, ltp`), so consumers and tests of `scoreAndCluster`
and `SrEvidenceService` are unaffected.

## Testing (TDD)

`volume-profile.spec.ts`:

1. **New (failing-first):** a profile whose global top-5 volume buckets are all
   above LTP, plus a meaningful (lower-volume) bucket below LTP → assert the
   result contains ≥ 1 node with `price < ltp`. Fails today (global top-5 are
   all above), passes after the change.
2. **Update** `'caps at 5 nodes'` → cap is now **per side**: assert
   `length ≤ 10` and `≤ 5` on each side.
3. **New regression guard:** an all-one-side profile (every bucket above LTP)
   still returns that side's top-5 unchanged — no support is invented when
   there is no below-price volume.
4. Existing tests (`< 10 candles → []`, highest-volume node + score, boundary
   9/10, all-zero volume → score 0) must continue to pass unchanged.

## Out of scope

- `FLOOR` / soft-floor changes (the chosen philosophy is honest, not
  always-show-N).
- The chip-vs-drawn-PDL-line transient mismatch (8,572 vs 8,587.78) — separate,
  not reproducible from current live data.
- Visual emphasis distinguishing immediate vs strong support on the chart.

## Success criteria

- For a symbol sitting low in its range with real below-price volume (CRUDEOIL),
  the support side gains at least one `VOLUME`-backed evidence level, and the
  chip's nearest support reflects a genuinely evidenced level.
- Resistance output is byte-for-byte unchanged when all volume is overhead.
- No support level is invented where no below-price volume exists.
