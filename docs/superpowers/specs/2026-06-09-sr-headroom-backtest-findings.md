# S/R Headroom Factor — Backtest Findings (R&D)

> Date: 2026-06-09 · Status: R&D measurement only — **no production code changed**
> Script: `scripts/backtest-sr-headroom.mjs` (throwaway). Runs on compiled `dist/`.

## Question
Of the trades the levels-context strategy already takes, do the ones with more
**headroom to the nearest opposing S/R wall** (distance ÷ ATR14) perform better?
If yes, a headroom gate/score is worth building into the scoring.

## Method
Replay the strategy session-by-session; tag each trade with `headroomATR` using
our **real** SR code (`computeVolumeNodes` + `adaptiveRoundNumbers` +
`scoreAndCluster`); then filter trades by a headroom threshold sweep and compare.
**OI walls excluded** (no historical OI feed). Indices fall back to the nearest
round number as the "wall".

## Results

**NIFTY — 10y, 1,349 trades (index · round-only)**
| thr | trades | win% | avgR | net₹/trade | Sharpe |
|----|--:|--:|--:|--:|--:|
| base | 1349 (100%) | 30.7 | 0.92 | −1554 | −5.68 |
| ≥0.3 | 816 (60%) | 33.0 | 0.86 | −1303 | −5.53 |
| ≥0.5 | 324 (24%) | 31.8 | 0.85 | −1069 | −6.20 |
| ≥0.8 | 112 (8%) | 29.5 | 0.99 | −819 | −6.00 |

**BANKNIFTY — 10y, 1,828 trades (index · round-only)**
| thr | trades | win% | avgR | net₹/trade | Sharpe |
|----|--:|--:|--:|--:|--:|
| base | 1828 (100%) | 29.8 | 0.99 | −4370 | −5.64 |
| ≥0.3 | 378 (21%) | 27.8 | 0.99 | −3994 | −5.82 |
| ≥0.5 | 4 (0%) | — | — | — | — |

**STOCKS pooled (RELIANCE/HDFCBANK/ICICIBANK/INFY) — ~1mo, 17 trades (volume+round)**
| thr | trades | win% | avgR | net₹/trade | Sharpe |
|----|--:|--:|--:|--:|--:|
| base | 17 (100%) | 52.9 | 1.41 | +77 | +11.3 |
| ≥0.3 | 12 (71%) | 50.0 | **2.21** | **+110** | 9.2 |
| ≥0.5 | 8 (47%) | 37.5 | 0.84 | −65 | −9.4 |
| ≥0.8 | 5 (29%) | 60.0 | 0.76 | +13 | 1.6 |

## Findings

1. **Directionally, the sign is encouraging.** On NIFTY, net₹/trade improves
   monotonically with headroom (−1554 → −819 as thr rises to 0.8). On the stock
   pool, avgR jumps 1.41 → **2.21** and net/trade 77 → 110 at ≥0.3. Both have the
   *right sign* for the "don't trade into a wall" thesis.

2. **But it is NOT conclusive — no config beat baseline on all metrics.** Sharpe
   never improved; win% barely moved; the index net stayed deeply negative.

3. **Indices are the wrong instrument for this test.** The base strategy is
   unprofitable on index *spot* (Sharpe ≈ −5.6) — partly an artifact of applying
   an options cost model to spot points, but the ~30% win rate at ~0.9 avgR is
   structurally a losing combo. And round-number walls sit <0.5 ATR away on most
   bars (BANKNIFTY ≥0.5 = 4 trades), so the filter can't be evaluated cleanly.

4. **The volume-stock test (the right instrument) is far too thin** — 17 trades.
   The positive signal at ≥0.3 is encouraging but statistically meaningless.

5. **OI walls — the strongest part of the factor — remain untestable** (no
   historical OI feed).

## Verdict
**Inconclusive, faint-positive sign.** The backtest cannot validate the factor:
the only instruments with long history (indices) are the wrong test, and the
right instruments (volume stocks) have ~1 month of data. The historical data
simply isn't there to decide.

## Recommendation
**Do not commit to building it on backtest evidence alone.** The cheap, correct
next step is a **live forward paper-test**: wire a headroom score behind a flag,
log it on every alert/trade for a few weeks, and compare outcomes by headroom
bucket. This is the only path that (a) accumulates real volume-stock trades and
(b) tests the OI-wall dimension, which is the part most likely to add edge.

**Side observation worth a separate look:** the levels-context strategy's index
backtest is sharply negative (NIFTY net −₹2.1M, BANKNIFTY −₹8.0M over 10y at
1 lot). Much is cost-model/instrument mismatch, but the 30% win rate ÷ ~0.9 avgR
is worth investigating on its own — independent of the headroom factor.
