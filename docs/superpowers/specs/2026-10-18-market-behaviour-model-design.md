# Market Behaviour Model (MBM) — Design

> Status: draft for owner review · 2026-10-18 · Roadmap home: SP3 (model serving) + SP5 (learning loop).
> Evidence: NIFTY feasibility spike, 2026-10-18 (Appendix A).

---

## 1. Intent

Each instrument (NIFTY, BANKNIFTY, crude, …) has its own behaviour. We want a **self-learning model per
instrument** that learns that behaviour from history and gives the trade engine **calibrated
probabilities** it can use as *one input* when deciding to enter, hold, or exit a trade — for intraday,
overnight and options trades alike.

"Self-learning" means: the model re-learns on new data every month, keeps what still works, retires
what stopped working, and adds new behaviour it discovers — **automatically verified on data it did not
learn from** before anything it says is used.

The owner's framing: *we don't need to know the next move, we need the probability.* "When the candles
look like this, X happens N% of the time" — measured, not believed.

### Why this direction (what the spike proved)

On 2 years of NIFTY 1-minute data (Appendix A):

| Question | Result | Meaning |
|---|---|---|
| Can candles predict **direction** (up/down, 15m–close)? | AUC 0.49–0.515 | ≈ coin flip; tiny edge far below costs |
| Can candles predict **how much** NIFTY will move (next 30/60m)? | AUC 0.78–0.80, every month ≥ 0.61 | strong, stable; "quiet" vs "big" buckets differ ~2× |
| Do "85–91%" candle patterns found on year 1 hold on year 2? | dropped to ~58–74% ≈ base rate, avg −1.8 bp after cost | most were year 1's trend, not habits |
| Do the best year-1 patterns carry *any* information? | 22% profitable in year 2 vs 8% for random rules | weak signal, not a standalone edge |

So the design **leads with move-size / market-mood**, which is real today, and builds the **pattern
discovery engine** with blind verification at its core, fed with richer data (futures OI, option chain,
related markets) where directional edge is more likely to exist. The architecture is built so accuracy
can grow as data grows — but nothing is used until it passes the gate.

---

## 2. Goals, non-goals, anti-goals

**Goals**
1. **Move & Mood model (Model A)** per instrument: calibrated expected range and P(big move) for several
   horizons, plus a regime label. Served live, logged, measured.
2. **Pattern Library (Model B)**: an automatic discovery engine that mines pattern → outcome rules, keeps
   only those verified blind and profitable after costs, and serves "which verified patterns are active
   right now, their hit probability, expected payoff and sample size."
3. **Self-learning loop**: monthly re-train + re-mine + verify + promote/retire, with live tracking of
   every prediction against its outcome and automatic demotion when live results degrade.
4. **Consumers**: an optional input in the sentinel judge's packet (exit side) and a gate evaluator in
   the trade-core entry pipeline (entry side), both **observe-only first**.
5. **Extensible**: new instrument, new data source, new horizon, or new model type = new rows/config, not
   a rewrite.

**Non-goals (v1)**
- Predicting exact prices or "the next candle."
- Serving a direction model. Direction research continues offline (§5.5) and is only served if it passes
  the gate with richer data.
- Wiring into the legacy options silos. Options *entries* consume MBM only once they move into trade-core
  (SP6). Until then options positions benefit via the sentinel (exit side).
- A dashboard UI. A JSON endpoint + the monthly markdown report are enough for v1.
- Any LLM in the pipeline.

**Anti-goals (failure even if it "works")**
- A model or pattern that looks great on history and fails live — i.e. anything that skips blind
  verification.
- MBM placing or blocking trades on its own. It is one vote; hard risk limits and the kill switch are
  unaffected; a missing/failed MBM answer is a non-vote, never a reason to exit.
- More over-trading. MBM's first job on entries is to *remove* weak trades, not add trades.
- Spending Claude tokens. MBM is ₹0 in LLM usage; the only effect on the sentinel is a slightly larger
  packet (§6.1 keeps it small).

---

## 3. Constraints

| Constraint | Consequence |
|---|---|
| Prod VPS is 1 vCPU / 2 GB RAM | Training runs **off-box** (owner's PC now; Oracle India host later). Only small model artefacts ship to prod. |
| Scorer container is `profiles: ["ai"]`, never run in prod; SP3 §6.5 says it stays off if < 600 MB free | M2 starts with a `free -m` check; MBM runs as its own slim service (§10.2). |
| Feed is per-user (no shared Angel account) | Backfills and refresh use one user's Angel session (owner's), off-hours, respecting the 350 ms historical gate. |
| `candles_1m` keeps 180 days; app clamps 1m reads/fills to 180 days | Training history lives in a **separate store** (§5.1), not `candles_1m`. |
| Tick-built volume/OI in `candles_1m` is unreliable | Train only on broker-sourced bars. |
| `oi_snapshots` pruned at 45 days | Option-chain/OI history must be **exported before pruning, starting now** — this data only accrues with time. |
| Safety rules (CLAUDE.md §9) | Observe → paper → live, flag-gated, rollback = flag off. |
| Expired F&O / MCX contract history availability from Angel is unverified | MCX instruments wait for a probe; indices go first. |

---

## 4. Architecture

```
            ┌──────────────── training machine (off-box) ────────────────┐
 Angel  ──► │ Training store (parquet, broker bars + OI/chain exports)  │
 history    │        │                                                   │
 + prod     │        ▼                                                   │
 exports    │ Feature pipeline (Python, ONE implementation)              │
            │        │                       │                           │
            │        ▼                       ▼                           │
            │ Model A: Move & Mood    Model B: Pattern discovery         │
            │        │                       │                           │
            │        └──── Blind verification gate ────┘                 │
            │                    │ report.md + artefacts                 │
            └────────────────────┼──────────────────────────────────────┘
                                 ▼  register (ai_models) + ship artefacts (/opt/grw/models)
            ┌──────────────────── prod VPS ─────────────────────────────┐
            │ ai-engine scorer: /behaviour/{instrument}  (reads candles │
            │   from DB, computes features with the same pipeline)      │
            │        ▲ fail-open client                                 │
            │ API: sentinel packet block · entry gate evaluator         │
            │        │                                                  │
            │ mbm_predictions (every answer logged) → outcomes filled   │
            └────────┼─────────────────────────────────────────────────┘
                     ▼
            live tracking → monthly loop → promote / retire
```

---

## 5. Components

### 5.1 Training store
- Parquet files per instrument and interval on the training machine, partitioned by month. Source of
  truth for training; prod DB is not used for multi-year history.
- Contents, in priority order:
  1. Index spot 1m: NIFTY — 3 years if Angel serves it (≥ 2 years verified).
  2. Index futures 1m with volume + OI (current-month contract series). Probe whether Angel serves
     expired contracts; if not, history starts from the contracts we can fetch and grows forward.
  3. Option-chain / OI snapshots exported from prod (`oi_snapshots`, OI walls) — daily export job so the
     45-day prune never loses data again.
  4. **NIFTY drivers** (owner request, 2026-10-18 — to catch sudden trend shifts early). Each is
     configured per instrument as a "driver list", so crude/BANKNIFTY get their own later:
     - *Heavyweights* (1m, NSE via Angel): RELIANCE, HDFCBANK, ICICIBANK, INFY, TCS, BHARTIARTL, LT, ITC
       — top index weights; list refreshed from NSE index weights each quarter.
     - *BANKNIFTY* (1m) — banks are ~a third of NIFTY.
     - *India VIX* (1m, NSE index via Angel) — the market's own fear gauge; key for move-size.
     - *USDINR* (NSE currency futures via Angel if history is served; otherwise the market-cues source).
     - *Global cues* already in the sentinel packet: US index futures, WTI/Brent; plus DXY / US 10-year
       if the market-cues source provides history. Intraday history depth of these sources must be
       checked in M0; where only daily history exists, they enter as daily features.
     - Features from drivers: their returns over the same windows, breadth (how many heavyweights are up
       vs down), divergence (heavyweights or BANKNIFTY moving while NIFTY hasn't yet — lead/lag), VIX
       level and change, overnight global move into the open.
  5. Later: FII/DII daily flows, event calendar flags (from `market_events`), GIFT Nifty pre-open if a
     source with history is found.
- Daily 1d bars derived from 1m. Backfill script reuses the spike's approach (30-day chunks for index 1m,
  0.5 s gap, retry on throttle), reading credentials from env, never printing them.

### 5.2 Feature pipeline
- **One Python implementation** used by both training and serving, so features can never drift between
  the two. The API does not compute MBM features.
- All features are strictly causal (use only data up to the bar close). Feature set is versioned
  (`featureSet`, e.g. `mbm-fs1`), stamped on every model and prediction.
- Starting set = the spike's features (returns, gap, position vs prior-day levels and opening range,
  realised vol, vol ratio, EMA distances, RSI, candle shape, time of day, weekday), plus the driver
  features of §5.1.4, futures OI change and chain features when available. Adding features = new
  `featureSet` version.
- Every driver is tested for value, not assumed: each monthly report shows the gate metric with and
  without each driver group, and a group that adds nothing for 3 months is dropped (saves fetch calls).
- Live serving needs the drivers live too: the §10.1 refresher pulls them alongside NIFTY (≈ 10–12
  symbols per 5 min, still well inside the historical gate). A missing driver makes its features null;
  the model must tolerate nulls rather than refuse to answer.

### 5.3 Model A — Move & Mood
- Per instrument, per horizon: next 30m, next 60m, rest of session, next session.
- Outputs (calibrated):
  - expected range quantiles (p25/p50/p75) in points and in ATR units;
  - P(big move) where "big" = above the instrument's trailing median range for that horizon;
  - regime label `QUIET | NORMAL | ACTIVE` from the P(big move) bands.
- Method: gradient boosting (LightGBM) with isotonic calibration; walk-forward training. Builder may
  swap the learner if it beats this on the gate.
- **Gate (per instrument × horizon):** blind-month AUC ≥ 0.65 in each of the last 3 test months, Brier
  below the "trailing median" baseline, ≥ 300 test observations. A horizon that fails is not served;
  others still can be.

### 5.4 Model B — Pattern Library (discovery engine)
- Candidate rules: conjunctions of 1–3 binned conditions over the feature set (bins fixed on the
  discovery window only).
- Outcomes are **trades**, not up/down: long/short with target-before-stop barriers at several
  risk:reward ratios, sized in ATR units (and, once Model A is live, in units of its expected range);
  also level outcomes (gap fill, prior-day high/low touch). Exit at session end if no barrier.
- **One setup per day** (first trigger) so a pattern firing 12 times in one morning counts once.
- **Verification (all must pass):**
  1. Discovery window: t-stat ≥ 3 on net expectancy after costs, ≥ 40 setups.
  2. Blind window (later, never seen): net expectancy > 0 after costs, ≥ 30 setups, hit rate within
     the discovery confidence band.
  3. Beats a shuffled-label null run of the same search (the library must find more surviving rules
     than chance does).
- Costs: per vehicle (futures ≈ 2–3 bp, options modelled higher); configurable.
- Served answer: the verified patterns active right now, each with P(hit), expected net payoff,
  setups in discovery/blind/live, last verified date. **An empty library is a valid, honest state.**

### 5.5 Direction research (offline only)
Retrained monthly alongside B with the richer inputs. Reported, never served, until it passes a gate
equivalent to Model A's plus positive net expectancy in blind months.

### 5.6 Registry
- Reuse SP3 `ai_models`. New kinds: `mbm-move`, `mbm-patterns` (and `mbm-direction` for research).
- Needs a migration: add an `instrument` key (and `horizon` where relevant) so "one active model per
  kind" becomes "one active per kind × instrument (× horizon)". Existing GO/NO_GO rules unchanged:
  only GO artefacts can be activated or served.
- Pattern library artefact = JSON list of verified rules with their stats.

### 5.7 Serving
- A slim MBM service (built from the ai-engine codebase, §10.2) exposes `GET /behaviour/{instrument}`
  returning Model A outputs and the active verified patterns for *now*. It reads broker-sourced bars from
  the DB (§10.1) and runs the shared feature pipeline. Results cached per 5-minute bar. Historical
  timestamps are not served (§10.6).
- **If prod RAM is too tight:** Model A needs live features, so a precomputed lookup is not an option.
  M2 instead slims the scorer container (LightGBM models are a few MB; drop unused deps) until it fits
  the headroom rule. Requirement: live predictions, ≤ 300 ms, fail-open.
- API side: `MarketBehaviourClient`, same fail-open pattern as `ScorerClient` (timeout → `absent`).

### 5.8 Consumers (all flag-gated, observe first)
- **Exit side — sentinel packet:** optional `Block` (e.g. `flow.marketBehaviour`) with regime, P(big
  move) and expected range for the position's underlying and horizon, plus up to 3 active verified
  patterns. Absent when the flag is off (packet byte-identical). Keep it compact (≤ ~200 chars of JSON)
  to protect judge tokens.
- **Exit side — exit discipline:** v1 only *logs* what an MBM-sized floor/giveback would have done,
  evaluated with the existing replay harness. A `MODEL_*` clause is added only after replay shows it
  helps. A null MBM value must never justify an exit.
- **Entry side — trade-core:** new `GATE_EVALUATORS` key `market-behaviour` with params in the strategy
  version (e.g. "skip if regime is QUIET for this vehicle"). Outcomes go to `evidence.gates`; MBM
  outputs written to `ai_decision_records.features/featureSet/mlScore`.
- Flags: `MBM_ENABLED=off|observe|on` (global), `MBM_INSTRUMENTS=NIFTY`, plus per-consumer
  flags. `observe` = compute and log, consumers ignore.

### 5.9 Self-learning loop
1. **Every served answer is logged** (`mbm_predictions`: instrument, at, model ids, featureSet,
   outputs). A job fills realised outcomes after each horizon ends (actual range, which patterns hit).
2. **Live tracking:** rolling live AUC/calibration per model × horizon; live hit rate and payoff per
   pattern.
3. **Monthly run** (training machine, scheduled): refresh data → retrain A → re-mine B → verify →
   write `report-YYYY-MM.md` (what's new, what's retired, live vs expected) → register candidates.
4. **Promotion:** for the first 3 monthly cycles a human approves activation (one command). After that,
   auto-promote when the gate passes *and* live tracking of the current model is healthy.
5. **Automatic demotion between runs:** a pattern whose live hit rate falls below its blind-window lower
   bound over ≥ 20 live setups is retired; a Model A horizon whose live AUC < 0.60 over a month is
   switched off. Demotions are logged and appear in the next report.

---

## 6. Rollout

| Milestone | Delivers | Exit criterion |
|---|---|---|
| **M0 Data** | Training store; NIFTY spot (max history Angel serves); futures probe; daily export of OI/chain snapshots from prod (start immediately) | parquet store reproducible from one command; export job running in prod |
| **M1 Model A offline** | Feature pipeline, Model A for NIFTY, gate, report | report shows which horizons pass |
| **M2 Serving + logging** | registry migration, scorer endpoint, client, `mbm_predictions` + outcome filler, `MBM_ENABLED=observe` | live predictions logged for 2 weeks, live AUC tracked |
| **M3 Consumers (observe)** | sentinel packet block (flag), entry gate evaluator (flag), exit-discipline replay | replay + observe data reviewed by owner |
| **M4 Pattern Library + loop** | discovery engine with richer inputs, monthly loop, human-approved promotion | first monthly report; library possibly empty |
| **M5 More instruments** | CRUDEOIL first (owner's most-traded: 49 of the last 90 days' trackers vs NIFTY 19, BANKNIFTY 11) — starts with the expired-contract data probe; then BANKNIFTY, FINNIFTY, stocks | per-instrument gate passes |

Go-live of any consumer beyond observe is a separate owner decision after M3 data.

## 7. Success criteria
- Model A passes its gate on NIFTY in each of 3 consecutive monthly runs, and live AUC tracks the blind
  AUC within 0.05.
- In replay/observe, using the QUIET/ACTIVE regime as an entry filter reduces fees + losing trades per
  unit of net P&L on the owner's trade history (measured on `ai_exit_outcomes` / core journal).
- Every pattern ever served has a blind-window record; retired patterns are visible in reports.
- Zero Claude tokens consumed by the pipeline; sentinel packet growth ≤ ~200 chars.

## 8. Left to the builder
Learner choice (if it beats LightGBM on the gate), exact feature list beyond §5.2, parquet layout,
scheduling mechanism on the training machine, artefact shipping method (scp/rsync), cache mechanism,
table column details, report formatting.

## 9. Calls made by the designer (owner to check)
- v1 instrument = NIFTY only (owner decision, 2026-10-18). Crude is next despite harder data.
- Training off-box on the owner's PC until the Oracle India host exists; the monthly loop needs that PC
  on when it runs.
- Human approval of promotions for the first 3 cycles.
- Serving lives in the existing ai-engine scorer container rather than in Node.

## 10. Decisions from the builder review (designer's calls unless marked)
1. **Live bars.** Tick-built `candles_1m` is not used for MBM (training/serving skew, exists only while a
   session is subscribed). M2 adds an MBM bar refresher: every 5 min during market hours it pulls broker
   1m bars for `MBM_INSTRUMENTS` via the owner's Angel session (2–3 calls / 5 min, far under the 350 ms
   gate) into a broker-only store (`candles_1m` with `source=broker`, or a dedicated table — builder's
   call), plus daily bars for multi-day features. The service's DB role gets read grants on it. If the
   refresher has no session, MBM answers `absent` (never stale numbers) and logs it once per gap.
2. **RAM.** MBM is its own compose service, not `--profile ai`, so the NO-GO SP3 entry scorer is not
   started with it. Target ≤ 250 MB (LightGBM + pandas-free inference path is acceptable). If it still
   can't fit the headroom rule, M2 stops and the hosting choice (bigger VPS / Oracle India host) goes
   to the owner — no Node/ONNX port in v1.
3. **PC ↔ prod data movement.** Uses the existing root SSH key: nightly export jobs in prod write
   compressed files to `/opt/grw/exports/` (VPS disk, 30-day local retention — not R2); the training PC
   pulls them with scp and pushes artefacts to `/opt/grw/models/` + registers `ai_models` rows over an
   SSH-tunnelled DB connection. No new public ports.
4. **Which answer applies.** v1 answers only when the position's/entry's underlying is in
   `MBM_INSTRUMENTS` (index options and futures on that index included). Using index regime as a proxy
   for stocks is research, not v1. Horizon: intraday → 30m/60m/rest-of-session by time left in the
   session; overnight/carry → next session.
5. **Demotion runs in prod**, in the MBM service: it already fills outcomes for `mbm_predictions`, so
   the pattern hit/barrier evaluation lives once, in Python, in prod. The monthly PC run reads the same
   tables.
6. **Replay and the §7 regime-filter test run offline on the PC** using walk-forward models only (each
   timestamp scored by a model trained strictly before it). The endpoint serves live only.
7. **History depth** = whatever Angel serves (≥ 2 years verified for NIFTY); the walk-forward split adapts
   (train ≥ 12 months, then blind months). 3 years is a target, not a requirement.

---

## Appendix A — Spike evidence (2026-10-18, throwaway, scratchpad only)
Data: NIFTY spot 1m from Angel, 2024-10-16 → 2026-10-16, 183,677 bars, 496 days. 5m features, causal.
- Direction, walk-forward 12 months (LightGBM): AUC 15m 0.515 (10/12 months > 0.5), 30m 0.511, 60m 0.494,
  to-close 0.502; best confidence bucket ≈ +1 bp gross vs 2–5 bp cost.
- Next-30m range big-vs-small: AUC 0.796 (monthly 0.613–0.794); median range by predicted quintile
  13/16/19/23/30 bp. Next-60m: AUC 0.776 (0.645–0.769); 18/22/26/32/40 bp.
- Discovery: 9,590 one/two-condition rules × 6 barrier trades (ATR-scaled 1:1, 2:1, 1:2; long/short),
  first trigger per day, 3 bp cost, learn Oct-24→Oct-25, judge Oct-25→Oct-26. Best year-1 patterns 85–91%
  hit → 58–74% in year 2 (year-2 base 59–66% for 1:2 trades); top-40 year-2 avg −1.8 bp; 22% of top-40
  profitable vs 8% of all rules; 1 of 11 "t > 3" year-1 rules profitable in year 2.
