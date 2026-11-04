# Noise-vs-real exit classifier spike (2026-11-04): NO-GO

Question: while holding an intraday index option, when the underlying moves k N against us
(N = mean 1-minute true range over the last 14 bars, the app's `atr14-1m`), is it NOISE (it recovers to
the best point) or REAL (it runs a further 1.5 N)? The mirror question: after a fast favourable spike
(>= 2.5 N in <= 3 min), will it snap back (bank it) or extend (hold)?

## Data
- NIFTY + BANKNIFTY 1m index bars from 2016-10 to 2026-10-19 (`grw-mbm` store), plus prod `candles_1m` to
  2026-11-04 13:40 IST. 2,468 trading days.
- SENSEX (13 days) and MCX crude (5 days) from prod only. Prod `candles_1m` keeps about 4 weeks of data,
  not 180 days, so these are out-of-sample sanity checks only.
- Index 1m bars have no volume, so volume and real VWAP are not testable; TWAP is used as a stand-in.
- Futures OI and option-chain OI come from the NIFTY 5m grid
  (`grw-mbm/research/oi-pattern/data/grid.parquet`, 2025-11 to 2026-10).

## Design (`build.py`)
- At every 15-minute mark from 09:30 to 14:30, open a hypothetical LONG and a hypothetical SHORT.
- The adverse event fires on the first 1m close where (best - close) >= k N, for k in {1.5, 2, 3}.
  There is one event per position per k.
- Features use only bars up to the event.
- Labels within H in {15, 30} min:
  - NOISE: price trades back to `best` first.
  - REAL: price trades 1.5 N beyond the event close first. If both happen in the same bar, it counts as REAL.
  - TIMEOUT: neither happens; the trade is marked to the close.
- Hold P&L is measured against exiting now, in N:
  - NOISE pays the distance back to `best`.
  - REAL costs -(1.5 + 0.2 slip).
  - TIMEOUT pays the mark-to-market move.
  - All outcomes are charged theta at 0.01 N/min.
- Train on dates before 2025-01-01; the holdout is 2025-01 to 2026-11. CIs come from a day-cluster bootstrap.
- Events: 620k adverse events (NIFTY + BANKNIFTY) and 76k spikes.

## Results (H30; H15 is the same: holdout AUC GBM 0.645 vs null 0.639, every hold policy below exit-always, resolved NOISE slightly BELOW null e.g. NIFTY k=2 0.368 vs 0.388)
- **Base rates match a random walk.** Among resolved events, the NOISE rate equals the gambler's-ruin
  null m/(move+m) at every k, for every underlying, in both train and test. For example, NIFTY k=2 test:
  0.385 observed vs 0.388 null.
- **The model has no skill beyond geometry.** Holdout AUC: GBM 0.601 [0.596, 0.606], logistic 0.599, and
  the null formula alone 0.600. Within a single k: GBM 0.547 vs null 0.549. Walk-forward AUC by year
  (2020-2026) never beats the null by more than 0.005. Spearman correlation between predicted P(NOISE)
  and realised hold P&L: -0.007.
- **Exit policy (N/event against exiting at k N).**
  - Holding always costs -0.18 to -0.20 net, with CIs well below zero for every underlying and k.
  - The classifier and regressor hold-policies cost -0.009 to -0.032, with CIs below zero.
  - Exiting at the k N rule is the best policy everywhere.
- **Futures and option-chain OI add nothing.** NIFTY OI subset: AUC 0.573 with base features vs 0.574
  with OI added.
- **Failed break of PDH/PDL or the day's extreme has no edge.** The NOISE rate stays at the null. Holding
  is less bad (-0.10 to -0.15 vs -0.19) but still negative.
- **Time of day and vol regime don't flip the answer.** Every bucket is negative.
- **Spikes snap back about half the time.** SNAP rate is 0.52. Holding 10 min costs -0.13 (NIFTY) and
  -0.20 (BANKNIFTY) net against banking. SNAP AUC is 0.554, and the classifier policy does not beat banking.

Today's NIFTY example: the short opened at 11:15 hit 1.5 N at 11:17, and holding that event lost
(REAL). The same position's 2 N and 3 N events then recovered (NOISE). The model gave P(NOISE) 0.30 to
0.41 at those points, which is the geometric prior.

## What holds up
Intraday index paths at 1-minute resolution are a martingale in N units. The only "probability of noise"
is the geometry m/(move+m), and holding through an adverse move costs theta plus slippage. Decide
stop width by accepting risk up front: N-scaled stops, position size from N. Don't decide it by reading
the market at the moment of the dip. Move SIZE (MBM) remains the one predictable quantity.

Files: `build.py` (events), `analyze.py` (stats), `results/` (logs + CSVs). `data/` is gitignored.
