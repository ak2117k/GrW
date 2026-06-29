# Indian Broker Pain Points — Research Findings

**Date:** 2026-05-11
**Author:** Research session with Claude (Opus 4.7)
**Purpose:** Identify real-world problems that Indian retail traders face on existing broker platforms (Groww, Zerodha, Angel One, Upstox, Dhan) — and map them to opportunities for TD Automation to differentiate.

---

## Methodology

Web search across user forums (Reddit/ISB), Indian broker comparison sites, options-trading blogs, tax-filing guides, and trading-psychology platforms. Searches were run on 2026-05-11; data reflects platform state as of mid-FY26.

Sources are listed at the bottom of this document.

---

## Top pain points (ranked by frequency of complaint across sources)

### 1. No native auto trailing stop-loss for F&O / options

**The problem.** Zerodha (Kite) does not offer auto-TSL for options. Groww doesn't either — only fixed stop-loss / target on intraday equity. Angel One has rudimentary bracket orders but no real auto-trailing on F&O. Every major Indian broker fails on this.

**Who's affected.** Every active options/F&O trader. Especially Nifty/BankNifty intraday and short-duration directional plays.

**Current workaround.** Manually modify the SL every few minutes as the position moves. Or buy third-party tools (OptionX, AlgoBox, AlgoTest) that layer on top of broker APIs.

**Why it's a real pain.** During a high-volatility move, manually dragging SL is impossible — the price has already retraced by the time the trader's finger reaches the keyboard. Result: emotional exits and missed profit-taking on winning trades.

**Quote (OptionX Journal):** *"Zerodha does not offer a native auto trailing stop-loss for options trading — the feature simply isn't there in Kite, Kite API without custom code, or as a built-in order type for F&O."*

### 2. Apps glitch during high-volatility periods

**The problem.** Zerodha (the largest broker) has a reputation for slowing down or freezing during market peaks. Reddit threads describe "glitchy AF" experiences forcing day traders to rage-quit mid-trade.

**Who's affected.** All Zerodha users during fast moves. Particularly painful for intraday traders who need millisecond reliability.

**Current workaround.** Multiple broker accounts (Dhan, Shoonya as backup). Adds operational overhead and tax-reconciliation pain (see #4).

**Why it's hard for us to solve.** Reliability ultimately depends on the underlying broker's infrastructure. TD Automation's role would be graceful degradation (queue orders during broker outages, replay when they recover) — but we can't fix Zerodha's servers.

### 3. Fragmented apps / split product surface

**The problem.** Zerodha splits mutual funds (Coin) from equity/F&O trading (Kite) into separate apps. Most brokers split charts, options chains, P&L reports, and tax statements across different interfaces. Sensibull (India's leading options-analytics platform) is a separate product layered on top of Zerodha — meaning serious options traders pay another subscription on top of brokerage.

**Who's affected.** Multi-asset traders, F&O traders who need real-time Greeks, anyone managing across products.

**TD Automation's natural advantage.** We already have charts + signals + auto-trade + journal + options-chain in one app. The integration is the moat — but it's currently underused as a sales point.

### 4. Tax P&L is a nightmare

**The problem.** F&O, intraday, and capital-gains transactions ALL must be reported in ITR-3 — even if loss. Each broker produces a tax P&L statement in a different format. Numbers between brokerage P&L and exchange reports often don't match (different accounting standards, inclusion of fees varies). Multi-account traders have to manually reconcile to avoid double-counting positions.

**Who's affected.** Every retail F&O trader in March-April. Universal pain.

**Quote (eztax.in / TaxGuru):** *"Each report shows slightly different numbers because of accounting standards and inclusion/exclusion of taxes... Always reconcile exchange data with broker charges before filing taxes."*

**Why it matters.** Skipping report = SFT data mismatch = IT Department notice. Tens of thousands of retail traders get notices each year for missed F&O loss reporting.

### 5. No phone support at major brokers

**The problem.** Zerodha's support is ticket-only. Response times can stretch to days. Account-level issues (margin calls, mis-bookings) need same-day fixes.

**Who's affected.** Everyone, but especially novices who can't self-diagnose.

**Why we can't directly solve this.** We're not the broker. But indirect mitigations (clear error messages on order failures, an "explain why this rejected" UI that interprets broker error codes) are doable.

### 6. No discipline enforcement on the broker side

**The problem.** Best practices (max 2% capital per trade, max 5% daily loss, max 5 concurrent positions) are universally known but no broker enforces them. The trader has to remember.

**Who's affected.** Most retail traders who eventually blow up — and ~90% of options traders lose money per SEBI's own studies.

**Quote (tradetantra.in):** *"The 2% rule should be used without exception, never risking more than 2% of total trading capital on a single options trade."*

**Why this is the most preventable category of loss.** A single oversized losing trade (often during revenge-trading after a small loss) wipes accounts. A pre-trade cap that *blocks* the order would have saved most of them.

### 7. Trade journal is missing or basic

**The problem.** Most brokers don't offer a journal at all. Foreign tools (TradesViz, Edgewonk) are good but don't understand Indian market structure — NSE/BSE/MCX timings, weekly F&O expiry mechanics, lot sizes, STT/CTT, intraday vs F&O classification. Journals that exist usually just log trades; very few surface *patterns* across them.

**Who's affected.** Anyone serious about improving — but mostly the small minority who already journal manually.

**Quote (TradesViz):** *"What works is measurement: tracking your psychological states alongside your trade outcomes, so the patterns become undeniable. This feedback loop is how traders transform over years."*

**Common patterns serious journals would surface but typical broker apps don't:**
- "You lose 68% of trades placed in the first 5 minutes of weekly expiry"
- "You oversize 2x after a 3-trade win streak"
- "Your Mondays are -₹1,200 average; Wednesdays are +₹900"
- "76% of trades held over 30 min are losers"

### 8. Charting is OK but not professional

**The problem.** Basic indicators work fine on Kite/Groww. But serious technical traders want: drawing tools, multi-chart layouts, custom alerts on user-drawn levels, replay mode, alerts that trigger broker orders. So they pay for TradingView ($14.95/month minimum) on top of brokerage.

**Who's affected.** Active intraday and swing traders, options scalpers.

**Where TD Automation already wins (partially).** We just added Groww-style drawing tools on the chart. Custom alerts on drawn levels would be a natural next step.

### 9. Multi-broker portfolio fragmentation

**The problem.** Many active traders hold accounts at 2-3 brokers (one for reliability, one for cheaper F&O brokerage, one for backup). No single view of total exposure, total risk, or consolidated P&L.

**Who's affected.** Active traders with > ₹5 lakh capital who diversify brokers for resilience.

---

## Mapping pain points to TD Automation's existing modules

| Pain point | Existing module that could be extended | Effort to address |
|---|---|---|
| 1. Auto TSL for F&O | `auto-trade`, `trade-engine` | Medium — ~3-4 days |
| 2. App glitches during volatility | (broker-side issue; we can add graceful degradation only) | Low value for effort |
| 3. Fragmented apps | (we're already integrated — UX polish only) | Already addressed |
| 4. Tax P&L nightmare | `portfolio`, trade history in DB | Medium — ~2-3 days; high seasonal value |
| 5. No phone support | (out of scope) | n/a |
| 6. Discipline enforcement | `risk-manager`, `auto-trade`, existing `MAX_DAILY_LOSS`/`MAX_CAPITAL_PER_TRADE` constants | Small — ~1-2 days |
| 7. Pattern-detecting journal | `journal` (context-capture already in main) | Medium — ~3-5 days; high strategic value |
| 8. Pro charting + alerts | `charts` (drawing tools just landed) | Small to medium |
| 9. Multi-broker P&L view | (would need each broker's API/CSV-export) | Large; depends on broker access |

---

## Top 4 feature ideas, ranked

### #1: Pre-trade risk-cap enforcer (Recommended starting point)

**What it does.** Before any order is placed (whether by user, auto-trade, or Chartink-sourced setup), the order goes through a hard gate that checks:
- Would this trade exceed `MAX_DAILY_LOSS` if it hits the stop-loss?
- Would this exceed `MAX_CAPITAL_PER_TRADE`?
- Would this open more than `MAX_CONCURRENT_POSITIONS`?

Block + show reason if any cap would be breached. No override without explicitly raising the cap in settings.

**Why first.** Tiny scope (~1-2 days), uses constants you already have, prevents the #1 cause of trader failure, is also a prerequisite for safely automating auto-TSL on positions (#2). Builds on the existing `risk-manager` module + kill switch.

**Concrete behavior.** "Reject: would exceed daily loss cap by ₹1,500" instead of order silently going through and blowing up the account.

### #2: Auto trailing stop-loss for open positions

**What it does.** Once a position is open, a background daemon monitors price ticks and modifies the stop-loss order with the broker every time price moves favorably by N ATR multiples (or fixed % — configurable). Works for F&O including options. Stops moving when price reverses.

**Why second.** Universal complaint, no major broker has it natively, fits the existing auto-trade module. Daily value: every open trade ratchets toward profit-locking automatically.

**Concrete behavior.** Position opens at NIFTY 24,000 CE @ ₹100 with SL @ ₹80. Price moves to ₹130. TSL daemon modifies SL to ₹110 (preserving ₹10 risk). Price moves to ₹150. SL bumps to ₹130. Price reverses; SL stays @ ₹130 and triggers automatically.

### #3: Trade journal pattern detector (Highest strategic value)

**What it does.** Reads your closed trades (the journal context-capture infra is already in main per memory `project_m5_landed_2026_04_26`) and surfaces statistically-significant patterns:
- Time-of-day performance (lose-rate by hour of trading)
- Day-of-week performance
- Pattern-context performance ("you lose 68% on 0-DTE scalps")
- Behavioral patterns (oversize after win streaks, undersize after losses, revenge-trade after loss)
- Held-duration performance ("76% of trades held > 30 min are losers")

Surfaces as "Insights for You" tab in journal.

**Why this could be the moat.** Foreign tools (TradesViz, Edgewonk) don't understand Indian market structure. Your competition is mostly spreadsheets the trader maintains manually. The infra is already there; this is making it *useful*.

**Concrete behavior.** Trader opens journal weekly; sees "Last week: -₹2,800 from Tuesday afternoon BANKNIFTY scalps (5 trades, 0 winners). You've now lost on 11 of last 12 Tuesday afternoon BANKNIFTY scalps. Consider blocking this setup."

### #4: Tax P&L report generator (Seasonal value)

**What it does.** Generates an ITR-3-ready P&L report from your trade history. Categorizes correctly:
- F&O turnover (sum of |buy| + |sell| premium for ITR-3 line 17)
- F&O profit/loss (already in DB)
- Intraday equity (speculative income)
- STCG (delivery sold within 12 months)
- LTCG (delivery sold after 12 months, ₹1L exemption)
- Per-broker breakdown if multi-broker imports are wired

Export as CSV / PDF formatted for upload to your CA or directly into ITR-3.

**Why fourth.** Universally hated annual pain, but only useful for ~3 months/year (Jan-April for ITR filing). Could monetize as a one-time annual upgrade. Medium scope (~2-3 days).

---

## Recommendation

**Build #1 (pre-trade risk-cap enforcer) first.** Reasons in order:
1. Smallest scope — 1-2 days.
2. Uses constants already defined in `apps/api/src/common/constants` (per `CLAUDE.md` Section 9 Safety Rules).
3. Solves the most preventable category of trader failure.
4. Is a prerequisite for safely operating auto-TSL (#2) — you don't want to auto-trail positions that should never have been opened that big.

**Then build #2 (auto-TSL).** Together, #1 and #2 solve the two most-cited pain points across every Indian broker.

**Build #3 (pattern-detecting journal) when ready for a strategic moat.** This is the feature that compounds over time for users and creates the kind of insight foreign tools can't match.

**Defer #4 (tax P&L) unless near tax season** — the value is real but seasonal; better to launch in Jan-Feb to capture March-April attention.

---

## Out of scope for now

- Solving broker reliability glitches (pain point #2) — we depend on broker APIs, can't fix that.
- Phone support replacement (pain point #5) — not a software problem.
- Multi-broker portfolio consolidation (pain point #9) — depends on each broker's data access, likely a v2 ambition.

---

## Sources

- [Top 10 Trading Apps India 2026 — saras.market](https://www.saras.market/blogs/top-10-trading-apps-india)
- [Zerodha lacks auto-TSL for options — OptionX Journal](https://optionx.trade/blogs/auto-trailing-stop-loss-zerodha-options-trading)
- [Best Trading Platforms for Indian Options Traders — OptionX Journal](https://optionx.trade/blogs/best-trading-platforms-indian-options-traders)
- [Stoploss/Target orders on Groww (intraday only) — groww.in](https://groww.in/updates/introducing-stoploss-target-orders-on-groww-for-intraday)
- [Broker Comparison Zerodha vs Groww vs Angel One — thebeststockbroker.com](https://www.thebeststockbroker.com/comparison/zerodha/groww/angel-one/)
- [How to download tax P&L from different brokers — eztax.in](https://eztax.in/how-to-download-tax-profit-loss-statement-from-brokers)
- [Reporting Intraday & F&O Transactions in ITR-3 — taxguru.in](https://taxguru.in/income-tax/reporting-intraday-f-o-transactions-itr-3.html)
- [Brokerage P&L vs Exchange Report discrepancies — timeofhindustan.in](https://timeofhindustan.in/share-market/brokerage-pl/)
- [Risk Management — Stop Losses and Position Sizing — mastertrust.co.in](https://www.mastertrust.co.in/blog/risk-management-in-trading-stop-losses-and-position-sizing-explained)
- [Risk Management Strategies for Indian Traders — tradetantra.in](https://www.tradetantra.in/2026/03/risk-management-strategies-every-indian.html)
- [Trading Psychology and Journal — TradesViz](https://www.tradesviz.com/trading-psychology/)
- [Trading Journal Psychology Insights — daytradingtoolkit.com](https://daytradingtoolkit.com/psychology-and-risk/trading-journal-psychological-insights/)
- [Active client decline FY26 — BusinessToday](https://www.businesstoday.in/markets/stocks/story/zerodha-groww-angel-one-upstox-how-active-clients-changed-in-past-8-years-full-table-526520-2026-04-20)
- [SEBI Crackdown on Brokers — Inc42](https://inc42.com/features/zerodha-angel-one-groww-revenue-squeeze-sebi-crackdown/)
- [Budget 2026 STT Hike on Derivatives — Inc42](https://inc42.com/features/stt-shock-at-budget-2026-pain-for-zerodha-groww-and-angel-one/)
