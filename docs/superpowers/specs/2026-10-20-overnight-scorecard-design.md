# Overnight Scorecard + News Ideas — Design

**Owner request (2026-10-20):** the overnight review "is not doing analysis, it is simply checking the
overnight positions". Positions are judged blindly. Make the agent analyse each position on a fixed set
of evidence — OI of the symbol, FII/DII, VIX, expiry, news on the stock, basic indicators (MACD, RSI,
EMA 20, EMA 9) — **assign points to each, ingest them in the pipeline, then forecast**. Example of the
miss: RELIANCE was marked "exit at open" on time decay alone while its OI picture pointed up. Second ask:
when strong positive/negative news lands, analyse the stock, check whether it has F&O, score it the same
way and **mark** a CE/PE idea with the news and the analysis side by side.

## 1. Scope (v1)

- **Positions:** only the owner's **real Angel One overnight positions** (broker-synced F&O + cash
  positions held past the close) — not app-level/paper trackers. Owner decision: keeps judge tokens low.
- **News ideas:** F&O-eligible stocks (and indices) with strong overnight news. **Ideas only — no orders,
  no paper trades.** The owner analyses and trades manually.
- **Where it shows:** the Night Report page (new "Scorecard" per position, new "News ideas" section).

Non-goals: auto-execution of any idea; scoring app trackers; changing live (intraday) sentinel cadence.
Anti-goal: a scorecard that looks precise but whose points are never checked against outcomes.

## 2. The scorecard (deterministic code — zero LLM tokens)

One row per (symbol, side, window) with each factor's **points in −2…+2** (positive = supports the
position's direction; for a long CE that means bullish, for a long PE bearish), the **raw values** and a
one-line reason. Total = sum; band: ≤ −4 strongly against · −3…−1 against · 0 neutral · 1…3 supports ·
≥ 4 strongly supports.

| Factor | Source (exists?) | Scoring v1 (initial rules, to be learned — §5) |
|---|---|---|
| **OI / option chain** of the symbol | NEW per-symbol chain capture (§3) | PCR (OI) vs its own 5-session median; put-writing vs call-writing build-up near spot (Δ OI at ±3 strikes); position of spot vs call/put walls and max pain. Bullish positioning +, bearish − |
| **FII / DII** | `market-cues` fii-dii + fii-oi fetchers (exist) | FII cash net and index-futures long/short ratio direction vs prior days; DII as cushion |
| **India VIX** | store / feed (exists) | level vs 20-day avg ("elevated" = ≥ 10 % above) and today's change (±5 % = rising/falling). For a held **long option** (either side): elevated −1 ("rich VIX: crush risk if it mean-reverts"); rising +1 ("rising VIX: vega tailwind for a long option" — a rising VIX lifts the premium); falling while elevated a further −1 ("VIX deflating" — the crush under way). Index positions additionally get the directional read (rising VIX bearish, falling bullish, oriented to the side). Clamped to −2…+2 |
| **Expiry** | expiry calendar (exists in MBM fs5) | days to expiry + holiday gap → theta pressure on long options (always ≤ 0 for long options, scaled by delta/premium) |
| **News on the stock** | `news_articles` tagged + sentiment (exists) | strongest overnight headline's sentiment and source weight; NSE announcements weigh more |
| **Indicators** | computed from daily + 15m candles (code exists in MBM) | daily: EMA9 vs EMA20, MACD histogram sign/slope, RSI14 zone; 15m: same, smaller weight. Plus any **validated daily setup** that fired (MBM daily setups). Needs 35 daily bars: when `candles` holds fewer (most NSE cash names outside the daily-backfill universe), ~95 calendar days of 1d (and ~7 of 15m when also short) are fetched on demand over the owner's own Angel session (paced historical lane) and persisted into `candles`; a failed fetch leaves the factor unavailable |
| **Market mood** | MBM `/behaviour` (exists, NIFTY) | ACTIVE/QUIET for index-linked positions (move-size, not direction). After hours the live model is not running: the last session's stored NIFTY predictions (`mbm_predictions`, newest per horizon, ≤ 5 days old) are used and labelled "as of <IST time>" |

The scorecard is computed after the close (15:40 IST, before the overnight review) and again at
pre-open (08:50), so the 08:30/09:10 reviews see fresh OI and GIFT/US cues.

## 3. Data that must be captured (the RELIANCE gap)

Per-stock option chains are captured today only on demand. Add a **dynamic chain-capture list** to the
existing NIFTY chain capture (`MBM_CHAIN_CAPTURE`): the underlyings of the owner's open Angel F&O
positions + F&O stocks shortlisted by the news scan. Cadence for stocks: every 15 min in session +
one EOD snapshot at 15:30, near expiry ±10 strikes (fewer calls than NIFTY's 5-min ±15). Same table
(`mbm_chain_snapshots`, `instrument` = underlying). Call budget stays far under Angel's limits; owner's
own session, no extra login (existing gate).

## 4. How the agent uses it (token-thrifty)

- **Overnight review (existing 15:45 window) and pre-open (existing):** the packet gains a compact
  `scorecard` block (≤ ~400 chars per position: factor → points + one value). The prompt instructs: base
  the verdict on the scorecard; when the verdict goes against the total, say which factor overrides and
  why. **No new LLM calls** — same windows, same count, a richer packet.
- **News ideas (new, one batch per night):** after the 23:30 news cut and again at 08:40, code shortlists
  candidates: F&O-eligible, |sentiment| strong (or NSE announcement of a material type), not already a
  position. Cap **5 per batch**. Code builds each candidate's scorecard; **one Sonnet call per batch** (not
  per stock) writes per idea: the news in one line, the scorecard read, the idea (`CE_IDEA` / `PE_IDEA` /
  `NO_TRADE`), the condition that would invalidate it, and "what to do with this news". Ideas are marked,
  never traded.

Token estimate: overnight/pre-open unchanged in call count (+~10 % packet size); news ideas ≤ 2 Sonnet
calls a night.

## 5. Learning which factors matter (self-learning, not guessed weights)

Every scorecard row and idea is stored with the **outcome filled later** (next session open→close move of
the underlying and of the position/idea's option where available). A monthly report (the MBM monthly
loop) shows, per factor, how often its sign agreed with the outcome and the average move when it was
±2. Weights stay equal in v1; changes go through the owner after the report shows evidence (same
discipline as every model so far).

## 6. Storage

- `analysis_scorecards`: id, user_id, symbol, underlying, side, window (`OVERNIGHT|PRE_OPEN|NEWS_IDEA`),
  computed_at, factors (jsonb: `{name, points, value, reason}[]`), total, band, verdict_id (nullable),
  outcome fields (next_open, next_close, move_bp, filled_at).
- `news_ideas`: id, created_at, news_ids, symbol, idea (`CE_IDEA|PE_IDEA|NO_TRADE`), rationale, invalidation,
  scorecard_id, model call id, outcome fields.

## 7. Night Report changes

- Each position row expands to its **scorecard** (factor · points · value · reason) next to the agent's
  verdict, with a warning chip when the verdict disagrees with the total.
- New **"News ideas"** section: news headline(s) → symbol chip (chart link) → scorecard → idea + reason +
  invalidation, newest first, with the outcome once known.

## 8. Rollout

1. Data: dynamic per-stock chain capture (§3). 2. Scorecard engine + table + Night Report view (no LLM).
3. Scorecard into overnight/pre-open packets + prompt line. 4. News-ideas batch (Sonnet) + table + view.
5. Outcome filler + monthly factor report. Each step ships behind a flag, observe first.

## 9. Calls made by the designer (owner to check)

- Points scale −2…+2 per factor, equal weights in v1; bands as in §2.
- Expiry factor only ever penalises long options (it never "supports" a long).
- MBM mood is used only as a volatility context, never as a direction vote.
- News-ideas cap 5 per batch, two batches a night, Sonnet; F&O eligibility from the instrument master.
- "OI over 21" in the RELIANCE example is read as bullish OI positioning (e.g. PCR ~2.1 / heavy put
  writing); the OI factor covers PCR, build-up and walls together.
