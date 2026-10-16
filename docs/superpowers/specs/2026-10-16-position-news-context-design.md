# Position News Context v3 — open-position profiles + self-correcting tag loop

**Date:** 2026-10-16 · **Status:** draft for owner review (P1–P12 defaults below) · **Builds on:**
`2026-10-16-news-events-design.md` (v2, deployed `observe` since 2026-10-16 16:24 IST). **Trigger:** the first hour of
prod observe (235 articles, all tagged, ~60 % to an instrument) shows the broad v2 tagger is good enough for the
sector/index/market layers and for a future nightly market scan, but not precise enough to put in front of the judge
for an **open position**, where an irrelevant or misleading headline is worse than none. The owner also wants every
wrong tag noted so a night agent can fix the rules from the logs — **for every symbol, not one demo at a time**.

## 1. Evidence (prod observe 2026-10-16 + code)
| Case | What happened | Root cause in v2 code |
|---|---|---|
| "HDFC Life shares slip despite analyst upgrades…" | no tag | `stripSuffixes` only removes Limited/Ltd/(India)/& Co; "HDFC Life Insurance Company" never reduces to the brand "HDFC Life" (`alias-derivation.ts`) |
| "Nifty conquers 20-DMA… tech analysts" | tagged SHAH | ticker path: `extractSymbols` takes any Capitalised token ∩ listed symbols; an analyst surname "Shah" is a ticker. `AMBIGUOUS_SYMBOLS` is a hand list, by design "deliberately short" |
| "BoE's Bailey says…" | market IN | `marketTags` adds IN when the **feed** category is `indian`, whatever the text says (`market-sector-rules.ts`) |
| "Yemen's Houthis hit… Saudi infrastructure" | no tag | keyword sets name the commodity itself; there is no notion of a **price driver** (supply shock → CRUDEOIL) |
| ET Auto RSS | 403 from the VPS | `SourceHealthBook` marks it DOWN after 6 failures but nothing ever retires it |
| CARDAMOM, COTTON, COTTONOIL, ELECDMBL, MCXBULLDEX, MCXMETLDEX, SILVER100, STEELREBAR, SUNOIL | position news `unresolved` | `MCX_UNDERLYINGS` (`keys.ts`) is a hand-reconciled list; the completeness test checks the list against itself, not against the live master |

## 2. Goals / non-goals
**Goals.** (1) LIVE: for each open, watched position, a short, *precise* set of headlines about **that** company /
commodity / index and its known price drivers, each with a one-phrase *why*, read in ~1 ms from memory. (2) Every
wrong / misleading / missed tag is **logged** with its source. (3) A nightly curator turns the logs into **data**
rule changes that apply to every symbol, auto-applied only when a labelled evaluation shows precision does not drop.
(4) Flag off ⇒ packets, prompts, schema and stamps byte-identical to today.
**Non-goals.** News never forces an exit, never touches the exit-discipline gate, triggers, orders or persistence
(v2 §14 unchanged). The broad v2 tagger is **kept** (sector/index/market layers, the news page, the nightly job).
**Out of scope (spec #2):** nightly market analysis / FII-DII / next-day trade recommendations. This spec only builds
the pieces #2 will reuse: the night-job runner (§9.1), the feedback table (§7) and the rules-as-data store (§6).

## 3. Shape
```
LIVE   ingest ─► v2 tag-once (rules v.N) ─► news_articles ─► NewsIndex (24 h, memory)
                                    └─push─► PositionNewsMatcher (open-position profiles only, tens) ─► matches map
       packet build ── peek(index + matches) ──► news.headlines {ref, layer, why}  (no I/O, ~1 ms)
       judge verdict ── newsIgnored[] ──► news_tag_feedback (signal=judge)
NIGHT  00:30 audit (LLM, positions of the day) + stats ──► news_tag_feedback
       01:15 curator: cluster ─► proposals ─► evaluate on labelled set ─► apply (rule set N+1) | propose-only
       ─► re-tag 48 h ─► NewsIndex.rebuild() ─► morning summary (night_job_runs)
```

## 4. Open-position entity profiles (live precision)
**4.1 Content** (`news_entity_profiles`, one active version per underlying): `names[]` each `{text, strength:
strong|needs-context}` (official, brand short-names §5.1, curated); `parent[]`, `subsidiaries[]` (relation shown in
*why*; a subsidiary's news is `related`, not `own`); `people[]` `{fullName, role}` — matched **only** as the full name,
never a surname alone; `products[]` (only distinctive, rule-checked like names); `drivers[]` = keys into the shared
driver catalogue (§5.4) with a one-line sensitivity note ("input cost", "revenue in USD"); `sector`, `indices[]`;
`exclusions[]` (look-alike phrases that are *not* this entity). Index underlyings: name variants + top-10 weight
constituents as `related` + macro drivers (RBI, FII flows, US yields). Commodities: benchmark names + their drivers.
**4.2 Build.** Two stages, so correctness never waits on an LLM: (a) **deterministic baseline** at once — EQUITY_L
name + §5 rules + sector (`NseSectorIndexService`) + sector→driver defaults (e.g. NIFTY IT → `INR_USD`, `US_TECH_SPEND`;
OMCs/airlines → `CRUDE`); (b) **LLM enrichment** async (Bull job `news-profile`, never on the packet path): input =
official name, industry, master rows, baseline; output JSON (schema-validated) of the fields above. Every LLM-proposed
name/product/person passes the same gates as the broad tagger: §5.1 uniqueness across **all** listed companies,
§5.2 needs-context, and a **blast-radius check** — a phrase that would have matched > 0.3 % of the last 30 days of
`news_articles` is rejected as generic. Rejections are kept on the row (`rejected[]` with reason) for review.
**4.3 When.** On roster change (`RosterService.build` sees an underlying with no active profile) → enqueue; plus a
nightly prebuild of the F&O stock universe + every MCX/index underlying, ≤ 15 per night until covered (P5), so an
intraday build is rare. Refresh after 90 days, on an EQUITY_L name change, or when the curator flags the profile.
Versioned (`version`, `active`, `builtBy: baseline|llm`, `model`, `promptVersion` `p1`), reviewable by SQL.
**4.4 Live matching.** `PositionNewsMatcher` compiles the active profiles of the **currently watched underlyings
across all users** (≤ 5 per user, tens total) into one token-trie + phrase set. It runs (i) on every ingest push
(µs per article) and (ii) over the index's 24 h items on roster change (≤ 5,000 items, < 50 ms, off the hot path).
Output: `positionKey → [{articleId, layer: own|related|driver, why ≤ 40 chars, strength}]`, bounded like the index.
**4.5 Packet (v3 rendering on).** The ladder becomes **own → driver → sector → index → market**: the instrument rung
holds only profile-confirmed `own`/`related` hits (a v2 instrument tag the profile does not confirm is **dropped** —
precision first, P2); new `driver` rung, ceiling 2; total cap stays 8, window 6 h, other ceilings unchanged. Each
headline gains `ref` (`h1`…`h8`, stable within the packet) and `why` ("name: HDFC Life", "driver: Red Sea → crude").
For a COMMODITY position its own drivers fill the instrument rung (a Hormuz headline *is* crude news). **Wakes:**
only `own` hits and commodity primary-driver hits wake (`news-hit`, v2 §9 rules); `related`/`driver` ride along (P3).

## 5. Systematic rules (every symbol; used by the broad tagger **and** the profiles)
**5.1 Brand short-names.** Generic words are *computed*, not listed: a token in ≥ 0.5 % of EQUITY_L names
(Insurance, Company, Industries, Finance, Holdings, Technologies…) is generic. Short-name = suffix-stripped name with
trailing generic tokens removed ("HDFC Life Insurance Company" → "HDFC Life"); kept only if it is unique across every
official/derived/short name, not a strict prefix shared by ≥ 2 companies, and — when one word — distinctive (§5.2).
**5.2 Needs-context.** A single-word alias or Capitalised-ticker hit that is an English word (checked-in public word
list, top ~30k by frequency), a common Indian surname / first name (public name lists), or a place name (countries +
Indian cities > 100k) counts **only** with company context within ±6 tokens: `Ltd`, `Limited`, `shares`, `stock`,
`scrip`, `Q1`–`Q4`, `results`, `earnings`, `profit`, `order`, `IPO`, `dividend`, `target price`, `(NSE`/`(BSE`, the
ticker in parentheses. Person context (`analyst`, `CEO`, `says`, `said`, `Mr`/`Ms`, `according to`, a first name
before it) vetoes. Applies to the ticker path too (fixes SHAH; replaces growth of `AMBIGUOUS_SYMBOLS`).
**5.3 Market classification by entity dictionaries.** Foreign central banks + heads, governments + leaders, foreign
exchanges/indices, all countries ≠ India and their demonyms → `GLOBAL`; RBI, SEBI, MoF, CBDT, GST Council, Indian
ministers, NSE/BSE, Indian states → `IN`. The feed category becomes a **prior used only when the text names no
entity**; foreign-only text is GLOBAL even from an Indian feed (fixes BoE).
**5.4 Driver catalogue.** Keys such as `CRUDE_SUPPLY` (OPEC, Hormuz, Red Sea, Houthi, Saudi/Aramco attack, sanctions on
Iran/Russia oil), `CRUDE_DEMAND`, `GOLD_MACRO` (Fed, real yields, dollar index, central-bank buying), `BASE_METALS`
(LME, China PMI/property, smelter cuts), `AGRI_MONSOON` (IMD, monsoon, sowing, kharif/rabi), `INR_USD`, `GAS_WEATHER`,
`POWER_DEMAND`, `STEEL_CHINA`, `EDIBLE_OIL` (palm/soy/sunflower import duty). Phrases are data (§6), matched with the
same case/consumption rules. **Every** MCX underlying on the live master must map to a benchmark + driver keys: the 9
gaps get sets (ELECDMBL → `POWER_DEMAND`; MCXBULLDEX → GOLD+SILVER drivers; MCXMETLDEX → `BASE_METALS`; SILVER100 →
SILVER parent; STEELREBAR → `STEEL_CHINA`; CARDAMOM/COTTON/COTTONOIL/SUNOIL → agri + `EDIBLE_OIL` as applicable,
confirmed in M1). Completeness test reads a checked-in snapshot of `SELECT DISTINCT name FROM instruments WHERE
exchange='MCX' AND "isActive"` (refresh script), and boot logs `[news-tag] MCX underlying without keyword set: …`.
`TAG_VERSION` → 2; the existing 48-h `RetagService` re-tags.

## 6. Rules as data
`news_tag_rules` holds every rule the curator (or owner) can change; code holds only the matcher and seed lists.
Kinds: `alias_add`, `alias_block` (symbol-scoped), `needs_context_word`, `generic_word`, `market_entity`
(`IN|GLOBAL`), `driver_phrase` (driver key), `profile_flag`, `source_drop`. Patterns are **literal phrases** (escaped,
compiled into the trie) — never LLM-written regex (no ReDoS, no code). Rows belong to an immutable
`news_tag_rule_sets.version` (parent pointer, metrics, summary); one row in `news_tag_rule_sets` is `active`.
Precedence: seed lists < active rules; `alias_block` beats any add. `news_articles` gains `ruleSetVersion`; re-tag
selects `tagVersion < TAG_VERSION OR ruleSetVersion < active`. Rollback = activate the parent (one step, §9.4).

## 7. Feedback logging (`news_tag_feedback`)
Row: `articleId, tag ("I:SHAH", "M:IN", "D:CRUDE_SUPPLY"), symbol?, kind (wrong_company | irrelevant | misleading |
missed | wrong_market), signal (judge | audit | stats | owner), reason ≤ 300, verdictId?, trackerId?, tagVersion,
ruleSetVersion, status (open | resolved | dismissed), resolvedByRuleId?, createdAt`. Signals:
1. **Judge** (only when v3 renders — the judge sees no news in observe). The verdict gains `newsIgnored`: array
   (max 3) of `{ref: "h1".."h8", kind: irrelevant|misleading|wrong_company|wrong_market, why ≤ 120}`, possibly empty.
   Prompt line: *list a headline only if it is about a different company/event or would mislead about this
   position; not merely unimportant; this field never changes your verdict.* The cycle maps `ref → articleId` from
   the packet it built. A missing/malformed field (the CLI judge cannot enforce the schema) is treated as `[]` and
   counted; it **never** invalidates a verdict.
2. **Nightly audit** (§9.2). 3. **Statistics** (§9.3). 4. **Owner** — later UI; an admin endpoint accepts rows now.

## 8. Prompt, schema and stamps
v3 renders only when `NEWS_EVENTS_V2_ENABLED=true` **and** `NEWS_CONTEXT_V3=true`, so its base stamp is always one
of v9–v12 / v2.6–v2.9. Instead of eight more table rows the stamp gets a **suffix**: `v9+n3/t1` (P8). With v3 off:
`VERDICT_SCHEMA` keeps object identity (`golden-fixtures.ts` keys on it), all 16 existing prompt hashes and stamps
are unchanged, and stored packets replay byte-equal. With v3 on: `VERDICT_SCHEMA_N3` = the live schema +
required `newsIgnored` (structured outputs need full `required`); the prompt adds 3 lines (headline `ref`/`why`, the
`driver` rung, `newsIgnored`). The overnight prompt (o4) is unchanged in this spec. Token cost: +~10 per headline
+ ≤ 3×30 output ≈ +170 worst case.

## 9. Night jobs
**9.1 Runner (shared with spec #2).** `NightJobRunner` in a new `night-jobs` module: Postgres advisory lock per job,
idempotent per `(job, nightOf)`, a `night_job_runs` row (`status, startedAt, finishedAt, budget {calls, tokensIn,
tokensOut, costInr}, summary json, error`), hard deadline 07:30 IST, LLM calls only through `AiGatewayService` (ledger
in `ai_calls`). New jobs `news.profile`, `news.audit`, `news.curate`, `news.label` added to `AI_JOBS` at priority 4
(below every `sentinel.*`/`review.*`). Schedule Mon–Sat nights after MCX close and the overnight late window
(`OVERNIGHT_CRON_MCX_LATE` 00:03/00:08): audit 00:30, curator 01:15, profile prebuild 02:30.
**9.2 Audit.** Per position tracked that day (`trade_trackers` / `core_positions` open at any time that day): the
headlines v3 attached (or would have, in observe), the broad-tagger headlines for the symbol that v3 dropped, and
untagged headlines containing a profile token case-insensitively (≤ 40 total) → one LLM call labels each
`relevant | irrelevant | misleading | wrong_company | missed` with a reason. One more call on a 60-headline sample
checks `markets`. Non-`relevant` labels become feedback rows. ≤ 15 calls/night.
**9.3 Statistics (no LLM).** (a) Alias anomaly: an alias whose 24 h hits exceed 5× its 30-day median and ≥ 10 hits,
or whose hits concentrate in bylines/quotes → `irrelevant` (signal `stats`). (b) Candidate aliases: Title-Case
1–4-grams in ≥ 3 untagged headlines/day that are a prefix of exactly one EQUITY_L name → `missed`. (c) Source
hygiene: a source DOWN (v2 §4.4) on 3 consecutive nights → `source_drop` proposal (fixes ET Auto, P10).
**9.4 Curator.** (1) Cluster open feedback of the last 7 days deterministically (same tag / alias / entity / token).
(2) For clusters with support ≥ 2, one LLM call proposes rules, constrained to §6 kinds and told to prefer the
**systematic** kinds (`needs_context_word`, `generic_word`, `market_entity`, `driver_phrase`) over a symbol-scoped
`alias_block`. ≤ 10 proposals/night. (3) Evaluate each in memory with the pure `tagArticle` on the labelled set
(§10) + the feedback-linked articles: apply only if precision does not drop for any kind (company, commodity, index,
market, position-relevance), company recall does not drop > 0.5 pp, the proposal resolves ≥ 2 feedback rows, and it
changes tags on ≤ 2 % of the last 7 days' articles (else owner review). Greedy: re-evaluate after each accept;
≤ 5 applied/night. (4) Mode `propose` writes rules as `proposed` only; mode `auto` creates rule set N+1, marks
feedback `resolved`, re-tags 48 h, calls `NewsIndexService.rebuild()` and rebuilds the position matcher. (5) Morning
summary in `night_job_runs.summary` + one `[news-curator]` log line: each change, why (feedback ids), precision/
recall before → after, and the rollback command. Rollback (`POST /api/admin/news-tag-rules/rollback`, owner-only,
or SQL) activates the parent set and re-tags. The curator can never edit the labelled set.

## 10. Labelled evaluation set
~1,000 real prod headlines from the last 7 days, stratified by source (read-only `\copy` export: `id, title, summary,
source, category, publishedAt`; no user data). Labeller: two independent LLM passes (`news.label`, different
prompts), a third adjudicates disagreements; owner spot-checks 50. Labels: `companies[], commodities[], indices[],
markets[], drivers[]`, plus a **position-relevance subset** (~200) for symbols we actually traded:
`relevant | irrelevant | misleading` per (headline, symbol). Checked in at
`apps/api/src/modules/news-events/__fixtures__/eval/headlines-2026-10.jsonl` (headlines are public; no secrets),
grown only by the labeller pipeline. Metrics per kind, per source, market accuracy, position-relevance precision.
**Go-live bar** for `NEWS_EVENTS_V2_ENABLED=true` with v3 on: open-position relevance precision ≥ 95 %, company
recall ≥ 85 % (P11). The one-off labelling runs on the developer machine's CLI, not the prod account (P6).

## 11. LLM placement, cost and latency
- **Transport:** the gateway routes `news.*` like other non-sentinel jobs (`config/ai-routes.json`): default
  `claude-cli` (`claude-sonnet-5`), no fallback (P4). They share the judge's OAuth account, whose weekly limit
  was hit 2026-10-15 (runbook §3), so: hard caps **≤ 40 calls/night, ≤ 400 k input tokens/night, ≤ 20 intraday
  profile builds/day**; a **circuit breaker** — any 429 / "limit" reply stops every `news.*` job until the reset
  time and logs it; no retries; jobs never run while a position's session is open except single profile builds.
  With `api` the existing `AI_API_DAILY_CAP_INR` meter applies (fix the SP3 cache-token undercount first).
- **Latency:** packet path unchanged (peek, ~1 ms, spy test: zero I/O); ingest matcher < 1 ms/article; profile
  build async (baseline immediate); night jobs ≤ 90 min total.

## 12. Data model (expand-only, one migration)
New: `news_entity_profiles` (`symbol, version, active, builtBy, model, promptVersion, profile Json, rejected Json,
createdAt`; unique(`symbol`,`version`)); `news_tag_rules` (`ruleSetVersion, kind, symbol?, pattern, params Json,
status proposed|active|rejected|rolled_back, origin seed|curator|owner, evidence Json, createdAt`);
`news_tag_rule_sets` (`version` unique, `parentVersion`, `active`, `metrics Json`, `summary`, `appliedAt`);
`news_tag_feedback` (§7; index `createdAt`, (`kind`,`status`)); `night_job_runs` (unique `job`,`nightOf`).
Altered: `news_articles` + `ruleSetVersion Int @default(0)`. `sentinel_verdicts.newsShadow` gains a `v3` key in
observe (also written when v2 is `true` and v3 is `observe`). Existing readers ignore all of it.

## 13. Safety
The curator and audit write only: `news_tag_rules`, `news_tag_rule_sets`, `news_entity_profiles`,
`news_tag_feedback`, `night_job_runs`, tag columns of `news_articles`. A module-graph test asserts `night-jobs` and
the news modules import nothing from trade-engine, sentinel-executor, exit, order or gate code. LLM output is data:
schema-validated, literal phrases only, blast-radius capped. `newsIgnored` is advisory and never read by any exit
path. Kill switches: `NEWS_CONTEXT_V3=false` (live), `NEWS_CURATOR_MODE=off` (night), one-step rollback.

## 14. Configuration
`NEWS_CONTEXT_V3=false|observe|true` · `NEWS_CURATOR_MODE=off|propose|auto` · `NEWS_LLM_NIGHT_MAX_CALLS=40` ·
`NEWS_LLM_NIGHT_MAX_INPUT_TOKENS=400000` · `NEWS_PROFILE_MAX_BUILDS_PER_DAY=20` · `NEWS_PROFILE_REFRESH_DAYS=90`.
Typos parse as off (v2 `parseNewsEventsConfig` style); boot line `[news-ctx] v3=… curator=… caps=…`.

## 15. Testing
Unit tables: the 4 prod cases (HDFC Life → HDFCLIFE; SHAH not tagged from "…, says Rajesh Shah"; BoE → GLOBAL only
from an `indian` feed; Houthi/Saudi → `CRUDE_SUPPLY` → CRUDEOIL own rung, OMC driver rung); generic-word computation
on the EQUITY_L fixture; needs-context with/without context, person veto; every live-master MCX name has a set;
profile gates (uniqueness, blast radius) reject LLM junk; matcher bounds; ladder with the `driver` rung; `ref`
stability; `newsIgnored` malformed → `[]`. Flag-off identity: 16 prompt hashes, `VERDICT_SCHEMA` identity, packet
replay byte-equal; golden snapshots for `+n3`. Curator: a proposal that lowers precision on the fixture is rejected;
rollback restores tags; budget breaker on a fake 429; advisory lock prevents double runs. Eval harness prints the
metric table in CI (no thresholds in CI until M0 sets the baseline).

## 16. Rollout
**M0** labelled set + baseline metrics of v2 as deployed. **M1** §5 systematic rules + rules store + TAG_VERSION 2
(improves v2 observe; no packet change). **M2** profiles + position matcher, `NEWS_CONTEXT_V3=observe` (shadow in
`newsShadow.v3`). **M3** audit + stats feedback; curator `propose` for **2 nights** (P7), owner reads summaries.
**M4** curator `auto`. **M5** when the go-live bar is met: `NEWS_EVENTS_V2_ENABLED=true` + `NEWS_CONTEXT_V3=true` on
the owner's shadow sentinel (stamp `v9+n3/t1`), judge feedback starts.

## 17. Owner decisions (defaults)
- **P1** profiles only for watched open positions on the live path; v2 broad tagger kept for other layers. *(yes)*
- **P2** v2 instrument tags not confirmed by the profile are dropped from the packet. *(yes — precision first)*
- **P3** only `own` and commodity primary-driver hits wake the judge. *(yes)*
- **P4** `news.*` jobs on `claude-cli` (Sonnet) with the §11 caps + breaker; no API fallback. *(yes)*
- **P5** nightly profile prebuild ≤ 15/night over F&O stocks + MCX + indices. *(yes)*
- **P6** one-off labelling on the developer CLI, not the prod account. *(yes)*
- **P7** curator `propose` for 2 nights, then `auto` with morning summary + one-step rollback. *(yes; alt: stay propose)*
- **P8** stamp suffix `+n3` instead of new table rows. *(yes)*
- **P9** auto-apply bar: no precision drop in any kind, recall −0.5 pp max, support ≥ 2, ≤ 2 % blast radius. *(yes)*
- **P10** a source DOWN 3 consecutive nights is dropped automatically (ET Auto first). *(yes)*
- **P11** go-live bar 95 % relevance precision / 85 % company recall gates the v2 `true` flip. *(yes)*
- **P12** judge `newsIgnored` max 3 items, advisory only. *(yes)*

## 18. Changes to the deployed v2 design
v2 §5.5 market rule (category alone ⇒ IN) is replaced by §5.3; v2 §5.2's hand `AMBIGUOUS_SYMBOLS` / blocklist growth is
replaced by §5.2 word lists; v2 §17 M3 ("`true` after 2–3 days observe") is now gated by the §10 bar (P11); v2 §7
instrument rung becomes profile-confirmed when v3 renders; `newsShadow` is no longer "NULL unless v2 observe".
