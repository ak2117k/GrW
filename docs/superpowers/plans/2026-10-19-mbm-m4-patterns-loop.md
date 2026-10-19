# MBM M4 — Pattern Library + self-learning loop · build contract

Design §5.4 (Model B), §5.9 (loop). M1–M3 merged and live (observe). Store `C:\Users\AryanKumar\grw-mbm`
(10y NIFTY 1m + drivers); cached feature dataset `models/m1/nifty/dataset.parquet` (mbm-fs2, decision rows
every 15 min 09:30–15:15 IST, features + labels). Code: `ai-engine/src/mbm/` (`features.py`, `labels.py`,
`model_a.py`, `predict.py`, `service/`), CLI `ai-engine/scripts/mbm_train.py`, ship `scripts/mbm_ship.py`.

## Stream A — discovery engine (offline, PC) `src/mbm/patterns.py` + `mbm_train.py mine-b`
- Windows: **discovery** 2016-10-03 … 2022-12-31, **blind** 2023-01-01 … newest. Bins (quintiles) fitted on
  discovery only. Candidates: single conditions over the fs2 feature columns (bin == k, or bin ≤ 1 / ≥ 3),
  pairs of conditions, triples only as extensions of the top-200 discovery pairs (bounded search; log counts).
- Outcomes = trades from the decision bar close, NIFTY 1m bars after it: long and short, barriers in ATR14
  units (stop/target pairs 0.25/0.25, 0.25/0.5, 0.5/0.5, 0.5/1.0), first touch wins, same-bar both-touch =
  stop (conservative), session end = exit at last close. Net bp = gross − cost (`--cost-bp`, default 3 for
  futures-like). **One setup per day**: first trigger per (rule, side, barrier) per session.
- Verification (all): discovery t ≥ 3 on mean net bp (per-setup), ≥ 40 setups; blind mean net > 0, ≥ 30
  setups, blind hit rate within the discovery 95 % CI; **shuffled null**: rerun the identical search with
  outcomes permuted across days (≥ 5 permutations, seeded) and report survivors per permutation — the real
  library must exceed the null's 95th percentile count, else the whole library is reported as NOT
  significant (still listed, flagged).
- Artefact `grw-mbm/models/m4/nifty/library-<date>.json`: verified rules `{id, conditions:[{feature, op,
  value}], side, stop_atr, target_atr, discovery:{n,hit,mean_net,t}, blind:{n,hit,mean_net}, verified_on}`
  + meta (featureSet, windows, cost, search counts, null results). Report
  `grw-mbm/reports/m4-nifty-<date>.md`. **An empty library is a valid result** — say so plainly.
- Performance: vectorise outcomes once per (side, barrier) over all decision rows (numpy), then rules are
  boolean masks → laptop-feasible. Report runtime. Tests (pytest) on synthetic bars: barrier math,
  one-per-day, bins fitted on discovery only (no leak), null permutation keeps day structure.

## Stream B — self-learning loop
1. **PC monthly run** `ai-engine/scripts/mbm_monthly.py run [--dry-run]`: `mbm_data.py build` → `train-a`
   (all horizons, report) → `mine-b` (if `src/mbm/patterns.py` exists; tolerate absence) → read the ACTIVE
   prod registry rows read-only over SSH → write `grw-mbm/reports/report-YYYY-MM.md` (per horizon: new
   gate result vs active model's stored metrics, live accuracy from prod `mbm_predictions` outcomes, what
   would change; patterns new/retired) → ship candidates **inactive** (extend `mbm_ship.py` with
   `--candidate`: files + `ai_models` row `active=false`). `promote --model-id <id>` activates it (and
   deactivates the old row of the same kind×instrument×horizon) — the human approval step for cycles 1–3;
   the command prints what it will do and needs `--yes`. A Windows scheduled task monthly (1st Saturday
   11:00) for `run` only — never `promote`.
2. **Prod demotion** (MBM service, `src/mbm/service/`): daily after close (15:45 IST) compute live AUC per
   active horizon over the last 30 calendar days from `mbm_predictions` rows with `outcome_quality='ok'`
   and non-null `outcome_big`; if ≥ 300 such rows and AUC < 0.60 → set that `ai_models` row `active=false`,
   append `DEMOTED <date> live AUC x over n` to `gateReasons`, unload the horizon, log `[mbm] DEMOTED …`.
   < 300 rows → no action (logged). `/health` gains `{"live": {"30m": {"auc":…, "n":…}}}`. Pattern demotion
   is OUT of scope until a non-empty library is served.
3. Tests: pytest for the report builder (fixtures), promote/candidate SQL (dry-run), demotion rule
   (threshold, min-n, never demote on missing data), /health live block.

## Rules (both)
Own worktree + branch `feature/mbm-m4-a|b`; fast-forward to local main first if this file is missing.
Explicit-pathspec commits, trailer `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`;
never push/merge; never write to prod (B may only READ prod over SSH, and only in `--dry-run`/read paths
you test; do not run promote/ship/candidate against the VPS). Python tests:
`cd ai-engine && PYTHONIOENCODING=utf-8 py -3 -m pytest -q tests/test_mbm_*.py`. Token budget < 120k:
grep/`sed -n`, no dumps, run long jobs in the background and wait. Final report ≤ 250 words.
