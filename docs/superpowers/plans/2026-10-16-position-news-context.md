# Position News Context v3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This plan is written for a **team of parallel agents**: one small Foundation set first, then five streams (R, P, S, N, E) in separate worktrees, then Integration. Read "Team Execution" before picking up any task.

**Goal:** For each open, watched position, show the judge a short, precise set of headlines about *that* company / commodity / index and its price drivers (each with `ref` + one-phrase `why`, read in ~1 ms from memory), log every wrong / misleading / missed tag with its source, and let a bounded nightly curator turn the logs into data rule changes that apply to every symbol — with `NEWS_CONTEXT_V3=false` leaving packets, prompts, schema and stamps byte-identical to today.

**Architecture:** The v2 broad tagger (`news-events/tagging`) gains systematic, data-driven rules (computed generic words + brand short-names, needs-context word lists with a person veto on both the name and the ticker path, entity-dictionary market classification, a driver catalogue, a complete MCX map) whose changeable part lives in `news_tag_rules` / `news_tag_rule_sets` (versioned, one active, one-step rollback). A new `profiles/` part builds an `EntityProfile` per watched underlying (deterministic baseline at once, LLM enrichment async, gated) and a `PositionNewsMatcher` that matches every ingested article against the watched profiles in memory. The sentinel reads the matches through a type-only port and renders an own → driver → sector → index → market ladder with `ref`/`why`, gets a `newsIgnored` verdict field (advisory, ≤ 3) and the stamp suffix `+n3`. A new `night-jobs` module (advisory-locked, idempotent, budgeted, breakered, LLM only through the AI gateway) runs the nightly audit, statistics + source hygiene, curator and profile prebuild. A labelled evaluation set (JSONL, checked in) and a pure metrics runner gate the curator's auto-apply and the go-live flip.

**Tech Stack:** NestJS 11 + TypeScript, Prisma 6 (PostgreSQL/TimescaleDB), `@nestjs/schedule` crons, the SP3 AI gateway (`AiGatewayService`, `claude-cli` provider), Jest.

**Spec:** `docs/superpowers/specs/2026-10-16-position-news-context-design.md` (owner-APPROVED 2026-10-16, all defaults P1–P12). Read it before any task. Background you will need: `docs/superpowers/specs/2026-10-16-news-events-design.md` + `docs/superpowers/plans/2026-10-16-news-events.md` (the v2 this builds on: index keys R1, ladder R2/R3, edge-triggering R4, observe R5), `docs/guides/ai-data-and-account-runbook.md` (shared OAuth account, judge token switch).

**Base:** `main` @ 000eaf1 + spec/plan commits on `docs/news-context-loop`.

---

## Owner Decisions (approved 2026-10-16, all defaults)

| # | Decision | Status |
|---|---|---|
| P1 | Profiles only for watched open positions on the live path; v2 broad tagger kept for other layers | yes |
| P2 | v2 instrument tags not confirmed by the profile are dropped from the packet | yes |
| P3 | Only `own` and commodity primary-driver hits wake the judge | yes |
| P4 | `news.*` jobs on `claude-cli` (Sonnet) with §11 caps + breaker; no API fallback | yes |
| P5 | Nightly profile prebuild ≤ 15/night over F&O stocks + MCX + indices | yes |
| P6 | One-off labelling on the developer CLI, not the prod account | yes |
| P7 | Curator `propose` for 2 nights, then `auto` with morning summary + one-step rollback | yes |
| P8 | Stamp suffix `+n3` instead of new table rows | yes |
| P9 | Auto-apply bar: no precision drop in any kind, recall −0.5 pp max, support ≥ 2, ≤ 2 % blast radius | yes |
| P10 | A source DOWN 3 consecutive nights is dropped automatically (ET Auto first) | yes |
| P11 | Go-live bar 95 % relevance precision / 85 % company recall gates the v2 `true` flip | yes |
| P12 | Judge `newsIgnored` max 3 items, advisory only | yes |

## Global Constraints

- **⚠ NEVER DELETE DIRECTORIES anywhere in the repo or a worktree** — no `Remove-Item -Recurse`, `rm -rf`, `rmdir /s`, `git clean -fdx`, `del /s`. Every worktree's `node_modules` (root, `apps/api`, `apps/web`, `packages/shared`) is a JUNCTION into the one shared install; a recursive delete follows the junction and wipes the install every agent is using. Remove single files you created with `git rm <file>` or `Remove-Item <file>` (no `-Recurse`). Only Integration removes worktrees, and only after `rmdir <junction>` (no `/s`) on each junction.
- **Safety (spec §13).** Nothing in this feature places, modifies or cancels an order, alters a price trigger, or touches the exit-discipline gate, `sentinel-executor/`, `exit-discipline/`, `trade-engine/`, `trade-core/`, `auto-trade/` (no task edits a file there). `newsIgnored` is advisory: it is written to `news_tag_feedback` and logs only — no exit path reads it. News never forces an exit; the v9 "a headline alone is never a reason for EXIT_NOW" line stays.
- **Flag off ⇒ byte-identical.** `NEWS_CONTEXT_V3` unset/`false`/any typo: the matcher, profile builds and v3 shadow do not run; the live packet JSON, all **16** prompt texts (8 news-off pinned today + the 8 news-on texts S1 pins first), every stamp, `VERDICT_SCHEMA` (object identity, `golden-fixtures.ts` and `jobFor` key on it) and stored-packet replay are byte-identical to the Foundation tip. The golden snapshot file is never updated to make a change pass; new scenarios are *added*. `observe`: everything is computed, the v3 blocks are stored under `sentinel_verdicts.newsShadow.v3`, nothing the judge sees changes. Only `NEWS_EVENTS_V2_ENABLED=true` **and** `NEWS_CONTEXT_V3=true` render v3.
- **Hot path never awaits network, DB or an LLM.** Packet build and the tick source read v3 through synchronous `peek`s of memory (spy tests: zero I/O). Profile builds and DB profile loads are enqueued/deferred (`setImmediate`), never awaited by the cycle. The ingest matcher is synchronous and < 1 ms/article.
- **LLM jobs bounded and breakered (shared OAuth account with the live judge).** Every `news.*` call goes through `NewsLlmClient` → `AiGatewayService` (ledger in `ai_calls`), never a direct transport (except the one-off dev labeller, P6). Hard caps: ≤ `NEWS_LLM_NIGHT_MAX_CALLS` (40) calls/night, ≤ `NEWS_LLM_NIGHT_MAX_INPUT_TOKENS` (400 000) input tokens/night, ≤ `NEWS_PROFILE_MAX_BUILDS_PER_DAY` (20) intraday profile builds. Any 429 / "limit" / "usage" reply opens a breaker that stops **every** `news.*` job until the reset time (no retries). `news.*` never has a fallback provider. Night jobs finish by 07:30 IST (hard deadline) and never start a call while any position's session is open, except single intraday profile builds.
- **Config.** `NEWS_CONTEXT_V3=false|observe|true` · `NEWS_CURATOR_MODE=off|propose|auto` · `NEWS_LLM_NIGHT_MAX_CALLS=40` [0,200] · `NEWS_LLM_NIGHT_MAX_INPUT_TOKENS=400000` [0,5000000] · `NEWS_PROFILE_MAX_BUILDS_PER_DAY=20` [0,200] · `NEWS_PROFILE_REFRESH_DAYS=90` [7,365]. Exact trimmed lower-case words only; a typo is `false`/`off` and is reported once at boot. Boot line `[news-ctx] v3=… curator=… caps=calls 40/night, input 400000/night, profiles 20/day refresh 90d`. v3 *computes* only when `NEWS_EVENTS_V2_ENABLED` computes (`observe|true`); it *renders* only when v2 renders (`true`) and v3 is `true`.
- **Migration:** expand-only, ONE migration `prisma/migrations/20261017120000_news_context_v3/` (Task F3). No change to an existing column, index or constraint. Existing readers ignore all new columns/tables.
- **Logs:** `[news-ctx]` config/boot, `[news-tag]` tagger/rules/re-tag (existing), `[news-rules]` rule-set load/activate/rollback, `[news-profile]` profile builds and gate rejections, `[news-match]` matcher rebuilds, `[news-shadow]` observe summary (existing line + ` v3=…`), `[news-feedback]` feedback writes, `[night-job]` runner lifecycle, `[news-llm]` caps and breaker, `[news-audit]`, `[news-stats]`, `[news-curator]` (one morning line), `[news-source]` hygiene drop.
- **Tests (several agents share one machine — memory).** Per task run ONLY the targeted files: `cd apps/api && npx jest <paths> --ci --maxWorkers=2`. The full suite runs ONLY in Integration: `cd apps/api && npx jest --ci --maxWorkers=2` (NEVER default workers — OOM). Typecheck per task: `cd apps/api && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -c "error TS"` must print **174** (the pre-existing env baseline); add none.
- **Commits:** Conventional Commits, scopes `news-context`, `news-events`, `trade-sentinel`, `night-jobs`, `ai-gateway`, `news`. Always `git add <explicit paths>` then `git commit -m "…" -- <same paths>` — never `git add -A`, `git add .`, `git commit -a`, `git stash` (shared-index hazard). Every message ends with a blank line and `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. No push. No production access or writes from any task (scripts that read prod are *delivered* and run by the owner in the Production Gate).
- **Worktrees:** created only by the coordinator (see Team Execution). Never `npm install`; `npx prisma generate` is fine; never `prisma migrate dev/reset` against a shared DB.

## Where the Code Differs from the Spec

1. **Flag name.** The spec's `NEWS_CONTEXT_V3` is used as written (not `…_ENABLED`), parsed v2-style (`parseNewsContextConfig`, typos ⇒ `false`).
2. **§4.3 "`RosterService.build` sees an underlying with no active profile".** `RosterService.build` only has the broker tradingsymbol; the underlying (`structureSymbol`) is resolved later by the tick source and reaches news only in `SentinelCycleService` where `NewsWatchBook.upsert` is fed (sentinel-cycle.service.ts ~L617). The watched-underlying set is therefore pushed from `NewsWatchBook` (Task S4) to `PositionNewsReader.setWatched` — the roster is not touched.
3. **"All 16 prompt hashes".** Today only the 8 news-off texts are sha-pinned (`sentinel-agent.service.spec.ts` L642–L801); the 8 news-on texts (v9–v12, v2.6–v2.9) are pinned only via `undoNews` attribution. Task S1 Step 1 records their sha256/length on the Foundation tip and pins them before any prompt edit, so the 16-hash identity is literal.
4. **`VERDICT_SCHEMA` identity is read in two places**, not one: `golden-fixtures.ts` and `ai-gateway/sentinel/sentinel-gateway.transport.ts::jobFor`. `VERDICT_SCHEMA_N3` must map to `sentinel.judge` there too (Task S1), or every v3 verdict is ledgered as `sentinel.unknown`.
5. **The gateway returns no usage to callers.** `AiGateway.call` resolves to the message only, so the night token cap cannot be metered from the call. Task N1 adds an additive `callWithMeta` (same code path; `call` keeps returning the provider's message by reference — golden-tested) and the client pre-checks with a conservative estimate `ceil(chars / 3.5)`.
6. **§9.1 "Postgres advisory lock per job".** Session-level advisory locks are unsafe through Prisma's pooled connections (unlock may run on another connection). The runner claims a run with a transaction-scoped `pg_try_advisory_xact_lock(hashtextextended('night:<job>:<nightOf>',0))` + an insert into `night_job_runs` (unique `job, nightOf`, status `running`); a `running` row older than the deadline is taken over (`status=failed, error='abandoned'`).
7. **§4.2 "Bull job `news-profile`".** An in-process serial `ProfileBuildQueue` instead: the gateway's `PriorityScheduler` already serialises CLI calls, a Redis queue adds a moving part on the 512 MB host, and a lost build is re-requested by the next watched-change or the nightly prebuild. The intraday cap counter is seeded at boot from `ai_calls` (`job='news.profile'` since IST midnight).
8. **§7 tags `D:<DRIVER>` but §12 adds no column for them.** The migration also adds `news_articles.drivers TEXT[] DEFAULT ARRAY[]::TEXT[]` (expand-only); `ArticleTags.drivers?` is optional (present only when non-empty, so every existing `toEqual` on tags stays green) and the index keys it `D:<KEY>`. v2 ladders never read `D:` keys.
9. **The bus carries `IndexedArticle` (title capped at 160, no summary).** Live matching is title-only; the night audit reads title + summary from the DB, and the "broad-tagger headlines v3 dropped" input catches summary-only mentions (Open Question 1).
10. **§5.2 needs-context on the ticker path** applies to *Capitalised* ticker tokens (`Shah`) and single-word aliases; ALL-CAPS tickers (`GAIL`, `NMDC`) are exempt — the v2 case rule already reads ALL-CAPS as ticker intent. The legacy `extractSymbols` / `AMBIGUOUS_SYMBOLS` in `news/services/extract-symbols.ts` (also used by legacy `relatedSymbols`) are **not edited**; v3 uses a new positional `tickerHits` in `news-events/tagging/`.
11. **§5.4 "9 gaps".** `COTTON` is a benchmark (`MCX_BENCHMARKS_V2`) but `MCX_UNDERLYINGS` deliberately filters it out, so the boot check reports it. `MCXBULLDEX`/`MCXMETLDEX` have no single benchmark: they become **composite** positions — `NewsPosition.key` is the composite name and the new optional `NewsPosition.components` lists the component benchmarks; `instrumentKeysOf` returns `I:<component>` for each. (Events for a composite resolve by its own key and therefore see only market-wide events — acceptable, noted.)
12. **MCX/F&O universe from `instruments`.** The instrument table is refreshed for CASH equities only (instrument-master cron); NFO/MCX rows can be stale. The MCX completeness test reads a checked-in snapshot (`__fixtures__/mcx-master-names.json`, seeded from the spec's list + current map, refreshed by the owner with `scripts/mcx-master-snapshot.ts` in the Gate). The prebuild universe = traded underlyings (180 d) ∪ index underlyings ∪ the MCX snapshot ∪ NSE `fo_mktlots.csv` (through `NseClient`, fixture fallback).
13. **§4.1 index profiles "top-10 weight constituents".** No table holds index weights: a checked-in `config/news-index-constituents.json` (dated; boot warns when > 45 days old).
14. **§4.2 "OMCs/airlines → CRUDE".** Not sectors in `SectorMapService` (15 NSE sectoral indices only), so the defaults table has symbol-level overrides (`BPCL`, `HINDPETRO`, `IOC`, `INDIGO`, `SPICEJET`, …). `CRUDE` in the spec = drivers `CRUDE_SUPPLY` + `CRUDE_DEMAND`.
15. **`newsShadow` shapes.** v2 `observe` + v3 `false` keeps today's `{news, events}` byte-for-byte. v3 `observe` adds a `v3` key (`{news: <v3 blocks>, refs, dropped}`); with v2 `true` + v3 `observe` the row carries `{v3: …}` only (spec §12). **Extension:** with v3 `true` the row carries `{v3: {refs, dropped}}` (no blocks — they are in `packet`), because the night audit (§9.2) needs the article ids of what the judge saw and the packet deliberately has none.
16. **`ref → articleId`.** Packet headlines carry no article id (and must not — it would leak into the judge's view and the stamp). The v3 block builder returns a side map kept in a module-level `WeakMap<ContextPacket, Record<ref, articleId>>` (`newsRefsOf(packet)`), never serialised.
17. **Night schedule "Mon–Sat nights".** Cron day-of-week `2-6` (Tue–Sat early morning = Mon–Fri trading nights), the same days as `OVERNIGHT_CRON_MCX_LATE`: audit `0 30 0 * * 2-6`, curator `0 15 1 * * 2-6`, prebuild `0 30 2 * * 2-6`, stats folded into the audit run's start (no LLM). `nightOf` = the IST date of the evening before (Open Question 2).
18. **Source hygiene "DOWN on 3 consecutive nights".** `SourceHealthBook` is in-memory and per-process; the stats job snapshots `health.all()` into its `night_job_runs.summary` each night and reads the two previous nights' rows.
19. **Labelled set needs a prod read.** No agent has prod access: Task E2 delivers a read-only export (`\copy` SQL + `tsx` script) that the owner runs (Gate M0); labelling runs on the dev CLI (P6). Until `headlines-2026-10.jsonl` exists the curator refuses `auto` (logs why) and the eval spec prints "no labelled set".
20. **ai-routes.json must list every `AI_JOBS` entry** (boot throws "missing route"), and two spec fixtures enumerate the jobs (`route-config.spec.ts json()`, `ai-gateway.service.spec.ts ROUTES_JSON`) — Task F1 updates all three with the four new jobs. Their default priority (4) is what `priorityOf` already returns; no change there.
21. **§13 module-graph test** checks **direct** imports of every file under `news-events/**` and `night-jobs/**` (a transitive walk from `news-index.service.ts` already reaches `market-data/` through `market-holidays.service`, which is not an execution path) against the cycle walk's `FORBIDDEN` pattern plus `sentinel-executor|exit-discipline|trade-core`.
22. **§7 judge `newsIgnored`.** The verdict row has no column for it; it is stored only as `news_tag_feedback` rows (signal `judge`) and counted on the agent (`newsIgnoredMalformed`).
23. **"Propose for 2 nights, then auto" (P7)** is enforced in code: `NEWS_CURATOR_MODE=auto` acts as `propose` until two completed `news.curate` runs with `summary.mode='propose'` exist, so the owner may set `auto` on day one.
24. **§6 re-tag predicate `ruleSetVersion < active` cannot roll back.** After a rollback the active version goes DOWN, so rows stamped with the newer set would never be re-tagged. The predicate is `tagVersion < TAG_VERSION OR ruleSetVersion <> active`. A version change detected by the rules service (curator, rollback endpoint, or a manual SQL `UPDATE`) reloads the rules and re-tags 48 h itself, so the SQL rollback path works without a restart.
25. **§9.3(a) "alias anomaly".** Stored tags record the SYMBOL, not which alias matched. The anomaly statistic is per instrument tag (`I:<SYMBOL>` daily counts); the byline/quote test re-scans that symbol's single-word aliases and Capitalised ticker in the 24 h titles with the `WordPolicy` and flags a symbol whose hits are ≥ 60 % person-context.
26. **The labelled set at runtime.** `__fixtures__/` is not part of the compiled `dist`. The curator resolves the set from `NEWS_EVAL_SET_PATH`, else by walking up from `__dirname` to `apps/api/src/modules/news-events/__fixtures__/eval/headlines-2026-10.jsonl` (present because the image copies the repo); absent ⇒ no `auto` (Gate checks presence).
27. **§9.3(c)/P10 "dropped automatically".** A `source_drop` changes no tag, so it skips the precision bar, but it still follows the curator mode: `propose` writes it as proposed, `auto` applies it. The aggregator stops fetching a dropped source on the next fetch after the rule set is active (`[news-source] <name> dropped by rule set vN`).
28. **Pure files the cycle must not import.** `context-types.ts` holds data tables (`DRIVER_KEYS`, `DRIVER_BENCHMARKS`) and DI token strings so every stream can import them without reaching another stream's code; it imports only types from `./types`.

## Planner Rulings

- **K1 — Keys.** v2 keys unchanged (`I:/S:/X:/M:`); new `D:<DRIVER_KEY>` (index only; never in a v2 rung). A position's matcher key is `positionKeyOf(p) = "<kind>:<key>"` (`STOCK:INFY`, `INDEX:NIFTY`, `COMMODITY:CRUDEOIL`, `COMMODITY:GOLD` for MCXBULLDEX).
- **K2 — What a profile confirms.** STOCK own = a profile name / product / person full name / an `NSE Announcements` row force-tagged with the symbol. INDEX and COMMODITY own = the v2 keyword tag `X:`/`I:` of the key (the keyword sets are already guarded) unless an `exclusions[]` phrase is in the title; COMMODITY own also = a **driver** tag whose catalogue entry lists this benchmark (`via:'driver'`). `related` = parent / subsidiary / constituent names (never wakes). `driver` (STOCK/INDEX only) = `tags.drivers ∩ profile.drivers` (never wakes).
- **K3 — Wakes (P3).** `wakes = layer==='own' && (via !== 'driver' || driver.primary)`. A COMMODITY's catalogue-primary drivers are `primary:true`.
- **K4 — Ladder v3.** Rungs `instrument` (own + related, ceiling 8) → `driver` (ceiling 2) → `sector` (3) → `index` (2) → `market` (2); total 8; window 6 h. Every article carrying the position's own v2 instrument key that the matcher did NOT confirm is claimed-and-dropped (excluded from every rung, listed in `dropped`). Refs `h1…h8` in final order. `why ≤ 40` chars: match `why`, else `sector: <S>`, `index: <X>`, `market: <M>`.
- **K5 — Fresh/edge (v3 true).** `freshCount` / `fresh` = matches with `wakes` and `publishedAt ≥ now − 30 min` and `!dateInferred`; the v2 edge-trigger memory (R4 of v2) is reused unchanged.
- **K6 — Rules precedence.** Seed lists (code) < active rule set rows; `alias_block` beats any add; rules are literal phrases (escaped, compiled into tries) — never regex.
- **K7 — Observe.** `computing = v2.computing && v3Mode !== 'false'`; `rendering = v2.rendering && v3Mode === 'true'`. Matcher, profile builds, shadow and judge-feedback plumbing run when computing; packet/prompt/schema/stamp/wake change only when rendering.

## Review Focus

1. **v3 `observe` must be invisible to the judge.** With `NEWS_EVENTS_V2_ENABLED=true` and `NEWS_CONTEXT_V3=observe`, the packet, prompt, schema and stamp must be exactly the v2-true ones while the shadow is written. *Task S4 Step 1 (`observe ⇒ v2-true packet hash`), Task S5 Step 1 (`judge-…-news-n3-observe` equals its v2 twin).*
2. **The matcher is not ready (boot, profile still loading, no EQUITY_L name) under `true`.** The headlines block must say the profile/matcher cannot see yet — never fall back silently to unconfirmed v2 instrument tags and never claim "no news about this company". *Task S3 Step 1 (`warming matches ⇒ absent with reason`).*
3. **A retag or curator re-tag republishes an article whose tags changed.** The matcher must replace that article's matches (not add a second copy), and a removed own match must disappear from the next packet. *Task P5 Step 1 (`republish replaces matches`).*
4. **A judge reply with a garbage `newsIgnored`** (string, 7 items, unknown ref `h9`, ref not in this packet) never costs the verdict: kept verdict, `[]`/filtered items, counter incremented; unknown refs never become feedback rows. *Task S2 Step 1, Task S4 Step 1.*
5. **The breaker trips mid-night.** A 429 in the audit stops the curator and prebuild that night (no call made), the `night_job_runs` rows say `breaker-open` with the reset time, and the next night runs normally after the reset. *Task N1 Step 1, Task N2 Step 1.*

---

## Team Execution

### Branches and worktrees (coordinator only)

```
main @000eaf1 ── docs/news-context-loop (spec + plan)
                     └── feature/news-context-v3   (worktree .claude/worktrees/nctx)      ← Foundation F1–F3, then Integration
                              ├── feature/nctx-r  (.claude/worktrees/nctx-r)   Stream R  rules for every symbol
                              ├── feature/nctx-p  (.claude/worktrees/nctx-p)   Stream P  profiles + matcher
                              ├── feature/nctx-s  (.claude/worktrees/nctx-s)   Stream S  sentinel integration
                              ├── feature/nctx-n  (.claude/worktrees/nctx-n)   Stream N  night jobs + curator
                              └── feature/nctx-e  (.claude/worktrees/nctx-e)   Stream E  evaluation set
```

Create each worktree from the MAIN checkout (`C:\Users\AryanKumar\Desktop\GrW`):

```powershell
git worktree add .claude/worktrees/nctx-r -b feature/nctx-r feature/news-context-v3
cmd /c mklink /J "C:\Users\AryanKumar\Desktop\GrW\.claude\worktrees\nctx-r\node_modules" "C:\Users\AryanKumar\Desktop\GrW\node_modules"
cmd /c mklink /J "C:\Users\AryanKumar\Desktop\GrW\.claude\worktrees\nctx-r\apps\api\node_modules" "C:\Users\AryanKumar\Desktop\GrW\apps\api\node_modules"
cmd /c mklink /J "C:\Users\AryanKumar\Desktop\GrW\.claude\worktrees\nctx-r\apps\web\node_modules" "C:\Users\AryanKumar\Desktop\GrW\apps\web\node_modules"
cmd /c mklink /J "C:\Users\AryanKumar\Desktop\GrW\.claude\worktrees\nctx-r\packages\shared\node_modules" "C:\Users\AryanKumar\Desktop\GrW\packages\shared\node_modules"
cd .claude/worktrees/nctx-r/apps/api; npx prisma generate --schema ../../prisma/schema.prisma
```

Junction targets are ABSOLUTE (a relative target resolves against the cwd and points nowhere). Streams start only after F3 is committed on `feature/news-context-v3`. One agent per stream, tasks in order inside a stream. Streams never merge each other; Integration merges them.

### Dependency graph

```
F1 ─► F2 ─► F3 ──┬─► R1 ─► R2 ─► R3 ─► R4 ─► R5 ─► R6 ──────────────┐
                 ├─► P1 ─► P2 ─► P3 ─► P4 ─► P5 ────────────────────┤
                 ├─► S1 ─► S2 ─► S3 ─► S4 ─► S5 ────────────────────┤
                 ├─► N1 ─► N2 ─► N3 ─► N4 ─► N5 ─► N6 ─► N7 ────────┤
                 └─► E1 ─► E2 ─► E3 ─► E4 ──────────────────────────┤
                                                                    ▼
                                               I1 (merge R,E,P,N,S + wire DI) ─► I2 (full suite + whole-branch review)
```

Cross-stream needs are satisfied by Foundation interfaces + stubs (`news-events/testing-v3.ts`), never by waiting: P builds against `WordPolicy` (implemented in R2), N7 against `evaluate()`'s signature (implemented in E1) and `CandidateTagger` (R6) / `CandidateRelevance` (P4); S against `PositionNewsReader` (P5) and `NewsFeedbackSink` (N3). Real bindings happen only in I1.

### File ownership (a file is edited by exactly one stream; Foundation edits are done before streams start)

| Area | Owner |
|---|---|
| `prisma/schema.prisma`, the migration, `deploy/env/api.env.example`, `config/ai-routes.json`, `ai-gateway/ai-job.ts` (+ the two route fixtures), `news-events/context-types.ts`, `news-events/news-context-config.ts`, `news-events/testing-v3.ts`, `news-events/types.ts`, `keys.ts::toIndexedArticle`, `news-index.ts` / `news-index.service.ts` `get`+`itemsSince`+`ROW_SELECT`, `trade-sentinel/ports/position-news.port.ts`, `trade-sentinel/ports/news-feedback.port.ts`, `news-events-core.module.ts` | **F** |
| `news-events/tagging/**` (all), `news-events/keys.ts` (MCX tables, composites), `news-events/config.ts` (`TAG_VERSION`), `news-events/rules/**`, `news-events/ingest/retag.service.ts`, `news-events/ingest/nse-announcements.service.ts`, `news/services/news-aggregator.service.ts`, `news/news.module.ts`, `apps/api/scripts/mcx-master-snapshot.ts`, `scripts/fetch-word-lists.ts` | **R** |
| `news-events/profiles/**`, `config/news-index-constituents.json`, `config/news-driver-defaults.json` | **P** |
| `trade-sentinel/**` (except the two F ports), `news-events/index/ladder-v3.ts`, `news-events/index/news-index.service.ts` `peekV3`, `trade-sentinel/ports/news-index.port.ts`, `ai-gateway/sentinel/sentinel-gateway.transport.ts` | **S** |
| `night-jobs/**`, `ai-gateway/ai-gateway.service.ts` (`callWithMeta`), `news-events/feedback/**`, `news-events/curator/**`, `news-events/audit/**` | **N** |
| `news-events/eval/**`, `news-events/__fixtures__/eval/**`, `apps/api/scripts/news-eval-*.ts`, `apps/api/scripts/sql/news-eval-export.sql` | **E** |
| `app.module.ts`, `trade-sentinel.module.ts` new bindings, cross-stream wiring | **I1** |

---

## Interfaces (defined in Foundation — every stream codes against these names)

### `apps/api/src/modules/news-events/news-context-config.ts` (F1, PURE — imports nothing)

```ts
export type NewsContextMode = 'false' | 'observe' | 'true';
export type CuratorMode = 'off' | 'propose' | 'auto';
export const NEWS_CONTEXT_CONFIG = 'NEWS_CONTEXT_CONFIG';

export interface NewsContextConfig {
  mode: NewsContextMode;
  /** v2 computes (observe|true) AND v3 is observe|true. */
  computing: boolean;
  /** v2 renders (true) AND v3 is true. */
  rendering: boolean;
  curator: CuratorMode;
  nightMaxCalls: number;
  nightMaxInputTokens: number;
  profileMaxBuildsPerDay: number;
  profileRefreshDays: number;
  problems: string[];
}

/** Ladder v3 (spec §4.5). */
export const V3_LAYER_CAPS = { instrument: 8, driver: 2, sector: 3, index: 2, market: 2 } as const;
export const V3_MAX_HEADLINES = 8;
export const WHY_MAX = 40;
export const NEWS_IGNORED_MAX = 3;
export const NEWS_IGNORED_WHY_MAX = 120;
export const FEEDBACK_REASON_MAX = 300;
export const BLAST_RADIUS_MAX = 0.003;          // §4.2: > 0.3 % of 30 d ⇒ generic
export const BLAST_WINDOW_DAYS = 30;
export const GENERIC_WORD_SHARE = 0.005;        // §5.1: ≥ 0.5 % of EQUITY_L names
export const CONTEXT_WINDOW_TOKENS = 6;         // §5.2: ±6 tokens
export const MATCHER_MAX_PER_KEY = 50;
export const CURATOR_MAX_PROPOSALS = 10;
export const CURATOR_MAX_APPLIED = 5;
export const CURATOR_MIN_SUPPORT = 2;
export const CURATOR_MAX_RECALL_DROP_PP = 0.5;
export const CURATOR_MAX_BLAST_SHARE = 0.02;
export const AUDIT_MAX_CALLS = 15;
export const AUDIT_MAX_HEADLINES = 40;
export const AUDIT_MARKET_SAMPLE = 60;
export const PREBUILD_MAX_PER_NIGHT = 15;
export const NIGHT_DEADLINE_IST = '07:30';
export const SOURCE_DROP_NIGHTS = 3;

export function parseNewsContextConfig(env: Record<string, string | undefined>): NewsContextConfig;
export function newsContextBootLine(c: NewsContextConfig): string;
```

### `apps/api/src/modules/news-events/context-types.ts` (F2, PURE — `import type` from `./types` only)

```ts
import type { ArticleTags, FreshItem, IndexedArticle, MarketTag, NewsAsOf, NewsPosition, PositionKind } from './types';

/* ── drivers (§5.4) ── */
export const DRIVER_KEYS = [
  'CRUDE_SUPPLY', 'CRUDE_DEMAND', 'GOLD_MACRO', 'BASE_METALS', 'AGRI_MONSOON', 'INR_USD', 'GAS_WEATHER',
  'POWER_DEMAND', 'STEEL_CHINA', 'EDIBLE_OIL', 'US_TECH_SPEND', 'RBI_POLICY', 'FII_FLOWS', 'US_YIELDS',
] as const;
export type DriverKey = (typeof DRIVER_KEYS)[number];
export const isDriverKey = (s: string): s is DriverKey => (DRIVER_KEYS as readonly string[]).includes(s);
/** Which MCX benchmarks each driver moves; `primaryFor` ⊂ benchmarks wakes a COMMODITY position (K3). Phrases live in R4's catalogue. */
export const DRIVER_BENCHMARKS: Readonly<Record<DriverKey, { benchmarks: readonly string[]; primaryFor: readonly string[] }>> = {
  CRUDE_SUPPLY: { benchmarks: ['CRUDEOIL'], primaryFor: ['CRUDEOIL'] },
  CRUDE_DEMAND: { benchmarks: ['CRUDEOIL'], primaryFor: ['CRUDEOIL'] },
  GOLD_MACRO: { benchmarks: ['GOLD', 'SILVER'], primaryFor: ['GOLD'] },
  BASE_METALS: { benchmarks: ['COPPER', 'ZINC', 'LEAD', 'ALUMINIUM', 'NICKEL'], primaryFor: ['COPPER', 'ZINC', 'LEAD', 'ALUMINIUM', 'NICKEL'] },
  AGRI_MONSOON: { benchmarks: ['COTTON', 'CARDAMOM', 'MENTHAOIL', 'COTTONOIL'], primaryFor: ['COTTON', 'CARDAMOM'] },
  INR_USD: { benchmarks: ['CRUDEOIL', 'GOLD', 'SILVER', 'COPPER', 'NATURALGAS'], primaryFor: [] },
  GAS_WEATHER: { benchmarks: ['NATURALGAS'], primaryFor: ['NATURALGAS'] },
  POWER_DEMAND: { benchmarks: ['ELECDMBL', 'NATURALGAS'], primaryFor: ['ELECDMBL'] },
  STEEL_CHINA: { benchmarks: ['STEELREBAR'], primaryFor: ['STEELREBAR'] },
  EDIBLE_OIL: { benchmarks: ['COTTONOIL', 'SUNOIL'], primaryFor: ['COTTONOIL', 'SUNOIL'] },
  US_TECH_SPEND: { benchmarks: [], primaryFor: [] },
  RBI_POLICY: { benchmarks: [], primaryFor: [] },
  FII_FLOWS: { benchmarks: [], primaryFor: [] },
  US_YIELDS: { benchmarks: ['GOLD', 'SILVER'], primaryFor: [] },
};

/* ── DI tokens (strings; bound in I1) ── */
export const WORD_POLICY = 'NEWS_WORD_POLICY';             // R6 provides (NewsModule)
export const NEWS_LLM = 'NEWS_LLM';                         // N1 provides (NewsLlmModule)
export const CANDIDATE_TAGGER = 'NEWS_CANDIDATE_TAGGER';    // R6
export const CANDIDATE_RELEVANCE = 'NEWS_CANDIDATE_RELEVANCE'; // P5
export const RETAG_RUNNER = 'NEWS_RETAG_RUNNER';            // R6 (RetagService)
export const INDEX_REBUILDER = 'NEWS_INDEX_REBUILDER';      // I1 → NewsIndexService
export const MATCHER_REBUILDER = 'NEWS_MATCHER_REBUILDER';  // P5
export const PROFILE_PREBUILDER = 'NEWS_PROFILE_PREBUILDER'; // P3
export const PROFILE_FLAGGER = 'NEWS_PROFILE_FLAGGER';      // P3
export const RULE_SET_ADMIN = 'NEWS_RULE_SET_ADMIN';        // R5/R6

/* ── profiles (§4.1) ── */
export type NameStrength = 'strong' | 'needs-context';
export interface ProfileName { text: string; strength: NameStrength }
export interface ProfileRelation { symbol: string; relation: 'parent' | 'subsidiary' | 'constituent'; names: ProfileName[] }
export interface ProfilePerson { fullName: string; role: string }
export interface ProfileDriver { key: DriverKey; note: string; primary: boolean }
export interface EntityProfile {
  symbol: string;
  kind: PositionKind;
  names: ProfileName[];
  parent: ProfileRelation[];
  subsidiaries: ProfileRelation[];
  related: ProfileRelation[];        // index constituents
  people: ProfilePerson[];
  products: ProfileName[];
  drivers: ProfileDriver[];
  sector: string | null;
  indices: string[];
  exclusions: string[];
}
export type ProfileRejectReason = 'not-unique' | 'prefix-shared' | 'needs-context-word' | 'blast-radius' | 'generic' | 'schema' | 'too-short';
export interface ProfileRejection { field: string; text: string; reason: ProfileRejectReason; detail?: string }
export type ProfileBuiltBy = 'baseline' | 'llm';
export interface StoredProfile {
  symbol: string; version: number; active: boolean; builtBy: ProfileBuiltBy; model: string | null;
  promptVersion: string | null; profile: EntityProfile; rejected: ProfileRejection[]; createdAt: Date;
}

/* ── matcher (§4.4) ── */
export type MatchLayer = 'own' | 'related' | 'driver';
export type MatchVia = 'name' | 'product' | 'person' | 'filing' | 'keyword' | 'relation' | 'driver';
export interface PositionMatch {
  articleId: string; layer: MatchLayer; via: MatchVia; why: string; strength: 'strong' | 'context';
  wakes: boolean; publishedAt: number;
}
export const positionKeyOf = (p: Pick<NewsPosition, 'kind' | 'key'>): string => `${p.kind}:${p.key}`;
export type PositionMatchesPeek =
  | { status: 'ok'; profileVersion: number; builtBy: ProfileBuiltBy; matches: readonly PositionMatch[] }
  | { status: 'warming' | 'unavailable'; reason: string };

/* ── ladder v3 (§4.5) ── */
export type NewsLayerV3 = 'instrument' | 'driver' | 'sector' | 'index' | 'market';
export interface LayeredHeadlineV3 {
  ref: string; title: string; source: string; sentiment: string | null; publishedAt: string;
  layer: NewsLayerV3; key: string; ageMin: number; why: string;
}
export type NewsPeekV3 =
  | {
      status: 'ok'; headlines: LayeredHeadlineV3[]; refs: Record<string, string>; newestAt: string | null;
      freshCount: number; fresh: FreshItem[]; asOf: NewsAsOf; dropped: Array<{ articleId: string; key: string }>;
    }
  | { status: 'warming' | 'unavailable'; reason: string };

/* ── word policy (§5.2) — implemented by R2, stubbed in testing-v3 ── */
export type ContextVerdict = 'company' | 'person' | 'none';
export interface WordPolicy {
  /** English word (top 30k), common Indian first/surname, or place ⇒ a single-word hit needs company context. */
  needsContext(word: string): boolean;
  /** Context around the hit covering tokens [start, end) of `tokens` (original case). Person beats company. */
  verdictAt(tokens: readonly string[], start: number, end: number): ContextVerdict;
}

/* ── rules as data (§6) ── */
export const RULE_KINDS = [
  'alias_add', 'alias_block', 'needs_context_word', 'generic_word', 'market_entity', 'driver_phrase', 'profile_flag', 'source_drop',
] as const;
export type RuleKind = (typeof RULE_KINDS)[number];
export type RuleStatus = 'proposed' | 'active' | 'rejected' | 'rolled_back';
export type RuleOrigin = 'seed' | 'curator' | 'owner';
/** params by kind: market_entity {market: MarketTag}; driver_phrase {driver: DriverKey}; profile_flag {reason}; source_drop {reason, nightsDown}; others {}. */
export interface TagRuleInput {
  kind: RuleKind; symbol: string | null; pattern: string; params: Record<string, unknown>; origin: RuleOrigin; evidence: Record<string, unknown>;
}
export interface TagRuleRow extends TagRuleInput { id: string; ruleSetVersion: number; status: RuleStatus; createdAt: Date }
export interface RuleSetRow { version: number; parentVersion: number | null; active: boolean; metrics: Record<string, unknown>; summary: string; appliedAt: Date | null }

/* ── feedback (§7) ── */
export const FEEDBACK_KINDS = ['wrong_company', 'irrelevant', 'misleading', 'missed', 'wrong_market'] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];
export const FEEDBACK_SIGNALS = ['judge', 'audit', 'stats', 'owner'] as const;
export type FeedbackSignal = (typeof FEEDBACK_SIGNALS)[number];
export interface FeedbackInput {
  articleId: string; tag: string; symbol: string | null; kind: FeedbackKind; signal: FeedbackSignal; reason: string;
  verdictId?: string | null; trackerId?: string | null; tagVersion: number; ruleSetVersion: number;
}
export type NewsIgnoredKind = 'irrelevant' | 'misleading' | 'wrong_company' | 'wrong_market';
export interface NewsIgnoredItem { ref: string; kind: NewsIgnoredKind; why: string }

/* ── LLM client (§11) — implemented by N1, stubbed in testing-v3 ── */
export type NewsLlmJob = 'news.profile' | 'news.audit' | 'news.curate' | 'news.label';
export type NewsLlmScope = 'night' | 'intraday';
export interface NewsLlmRequest { job: NewsLlmJob; scope: NewsLlmScope; system: string; user: string; schema: Record<string, unknown>; maxOutputTokens: number }
export type NewsLlmFailure = 'breaker-open' | 'cap-calls' | 'cap-tokens' | 'cap-intraday' | 'deadline' | 'session-open' | 'error' | 'unparseable';
export type NewsLlmResult =
  | { ok: true; json: unknown; tokensIn: number | null; tokensOut: number | null }
  | { ok: false; reason: NewsLlmFailure; detail: string };
export interface NightBudgetSnapshot { calls: number; tokensIn: number; tokensOut: number; costInr: number }
/** Never throws. */
export interface NewsLlm {
  call(req: NewsLlmRequest): Promise<NewsLlmResult>;
  breakerOpenUntil(): Date | null;
  usage(scope: NewsLlmScope): NightBudgetSnapshot;
}

/* ── night jobs (§9.1) ── */
export type NightJobName = 'news.audit' | 'news.curate' | 'news.prebuild';
export interface NightJobContext { job: NightJobName; nightOf: string; deadline: Date; llm: NewsLlm; log(line: string): void }
export interface NightJobOutcome { summary: Record<string, unknown> }

/* ── cross-stream ports used by night jobs ── */
export interface RetagRunner { retagWindow(now: Date, windowMs: number): Promise<number> }
export interface IndexRebuilder { rebuild(): Promise<void> }
export interface MatcherRebuilder { rebuildAll(): void }
export interface ProfilePrebuilder { prebuild(ctx: NightJobContext, limit: number): Promise<{ built: number; skipped: number; remaining: number }> }
export interface ProfileFlagger { flag(symbol: string, reason: string): Promise<void> }
/** Rule-set administration the curator and the owner endpoint use (R5 store behind R6's service). */
export interface RuleSetAdmin {
  activeVersion(): Promise<number>;
  activeRules(): Promise<TagRuleInput[]>;
  /** New immutable set = parent's active rules + `added`; activated in one transaction when `activate`. Returns its version. */
  createRuleSet(o: { parentVersion: number; added: readonly TagRuleInput[]; metrics: Record<string, unknown>; summary: string; activate: boolean }): Promise<number>;
  /** Proposed rows (status `proposed`) recorded against the current active version. */
  propose(rows: readonly TagRuleInput[]): Promise<number>;
  /** Activate the parent of the active set (parent 0 = seeds only: nothing active); null when nothing is active. The rules service then reloads + re-tags 48 h. */
  rollback(): Promise<{ from: number; to: number } | null>;
}

/* ── evaluation (§10) ── */
export interface LabelledHeadline {
  id: string; title: string; summary: string; source: string; category: string; publishedAt: string;
  labels: { companies: string[]; commodities: string[]; indices: string[]; markets: MarketTag[]; drivers: string[] };
  relevance: Array<{ symbol: string; label: 'relevant' | 'irrelevant' | 'misleading' }>;
  meta: { passA: string; passB: string; adjudicated: boolean; ownerChecked: boolean };
}
export type EvalKind = 'company' | 'commodity' | 'index' | 'market' | 'driver';
export interface KindScore { tp: number; fp: number; fn: number; precision: number | null; recall: number | null }
export interface EvalReport {
  n: number; byKind: Record<EvalKind, KindScore>; bySource: Record<string, Record<EvalKind, KindScore>>;
  marketAccuracy: number | null; relevance: { n: number; tp: number; fp: number; precision: number | null };
}
export type TagFn = (h: Pick<LabelledHeadline, 'title' | 'summary' | 'source' | 'category'>) => ArticleTags;
export type RelevanceFn = (h: LabelledHeadline, symbol: string) => boolean;
export interface CandidateTagger { forRules(rules: readonly TagRuleInput[]): TagFn }
export interface CandidateRelevance { forRules(rules: readonly TagRuleInput[]): RelevanceFn }

/** Re-exported so ports can stay single-import. */
export type { IndexedArticle };
```

### Ports (F2, type-only imports — `news-events.structure.spec.ts` asserts it)

`apps/api/src/modules/trade-sentinel/ports/position-news.port.ts`

```ts
import type { IndexedArticle, NewsPosition } from '../../news-events/types';
import type { PositionMatchesPeek } from '../../news-events/context-types';

/** The cycle's read of the open-position matcher (spec §4.4). All methods synchronous; no I/O. */
export interface PositionNewsReader {
  /** The full set of watched underlyings across users (≤ 5 per user). Cheap; rebuild work is deferred. */
  setWatched(positions: readonly NewsPosition[]): void;
  peek(position: NewsPosition, now: Date): PositionMatchesPeek;
  /** positionKeyOf(...) of every watched position this article wakes (K3). Pure over the compiled profiles. */
  wakeHits(article: IndexedArticle): string[];
}
export const POSITION_NEWS = 'SENTINEL_POSITION_NEWS';
```

`apps/api/src/modules/trade-sentinel/ports/news-feedback.port.ts`

```ts
import type { NewsIgnoredKind } from '../../news-events/context-types';

export interface JudgeFeedback {
  articleId: string; tag: string; symbol: string; kind: NewsIgnoredKind; reason: string; verdictId: string | null; trackerId: string;
}
/** Fire-and-forget: never throws, never awaited by the cycle. */
export interface NewsFeedbackSink { recordJudge(rows: readonly JudgeFeedback[]): void }
export const NEWS_FEEDBACK = 'SENTINEL_NEWS_FEEDBACK';
```

`trade-sentinel/ports/news-index.port.ts` gains (Task S3) an optional method — absent ⇒ v3 unavailable:

```ts
peekV3?(position: NewsPosition, matches: PositionMatchesPeek, now: Date): NewsPeekV3;
```

### Stream-implemented APIs other streams call (names fixed here)

| API | File | Stream |
|---|---|---|
| `createWordPolicy(lists: WordLists): WordPolicy`, `loadWordLists(): WordLists` | `news-events/tagging/word-policy.ts` | R2 |
| `computeGenericWords(names: readonly string[], share = GENERIC_WORD_SHARE): Set<string>`, `brandShortName(official: string, generic: ReadonlySet<string>): string \| null` | `news-events/tagging/brand-names.ts` | R1 |
| `DRIVER_CATALOGUE: Readonly<Record<DriverKey, { phrases: readonly string[]; benchmarks: readonly string[]; primaryFor: readonly string[] }>>` | `news-events/tagging/driver-catalogue.ts` | R4 |
| `compileRules(version, rows): { rules: CompiledRules; problems: string[] }`, `NewsRuleStore implements RuleSetAdmin` (+ `activate(v)`) | `news-events/rules/*.ts` | R5 |
| `NewsTagRulesService.reload()`, `.droppedSources()`, `.current(): CompiledRules`, `implements CandidateTagger`; `RetagService.retagWindow(now, ms)` (`RetagRunner`) | `news-events/rules/news-tag-rules.service.ts`, `ingest/retag.service.ts` | R6 |
| `ProfileBuildService.request(position: NewsPosition)`, `.baselineFor(position)`, `.onBuilt(fn)`, `.prebuild(ctx, limit)` (`ProfilePrebuilder`), `.flag(symbol, reason)` (`ProfileFlagger`) | `news-events/profiles/profile-build.service.ts` | P3 |
| `compileProfiles(entries, policy): CompiledProfiles` with `.match(a)`; `profileRelevance(profiles, policy): CandidateRelevance` | `news-events/profiles/profile-matcher.ts` | P4 |
| `PositionNewsMatcherService implements PositionNewsReader, MatcherRebuilder` | `news-events/profiles/position-news-matcher.service.ts` | P5 |
| `NewsLlmClient implements NewsLlm`, provided as `NEWS_LLM` by `NewsLlmModule` (its own module so P and N both import it without a cycle) | `night-jobs/news-llm.client.ts`, `night-jobs/news-llm.module.ts` | N1 |
| `NightJobRunner.run(job, fn, opts?: { nightOf? })` → `RunResult`; `nightOfFor(now)`, `deadlineFor(nightOf)` | `night-jobs/night-job-runner.ts` | N2 |
| `NewsFeedbackService implements NewsFeedbackSink` (+ `record(rows: FeedbackInput[])`) | `news-events/feedback/news-feedback.service.ts` | N3 |
| `evaluate(set, tag: TagFn, relevant?: RelevanceFn): EvalReport`, `readLabelledSet(path)`, `formatReport(r)`, `compareReports(before, after)` | `news-events/eval/*.ts` | E1 |
| `newsBlocksV3(peek, at)`, `newsRefsOf(packet)` | `trade-sentinel/services/news-blocks-v3.ts` | S3 |

---

## File Structure

```
prisma/schema.prisma                                             (M) F3  NewsArticle.ruleSetVersion+drivers; 5 new models
prisma/migrations/20261017120000_news_context_v3/migration.sql   (C) F3
deploy/env/api.env.example                                       (M) F1  NEWS_CONTEXT_* block
config/ai-routes.json                                            (M) F1  news.profile|audit|curate|label routes
config/news-index-constituents.json                              (C) P1  top-10 constituents per index underlying (dated)
config/news-driver-defaults.json                                 (C) P1  sector → drivers, symbol overrides (OMCs, airlines…)

apps/api/scripts/
  mcx-master-snapshot.ts            (C) R4  read-only: SELECT DISTINCT MCX names → __fixtures__/mcx-master-names.json
  fetch-word-lists.ts               (C) R2  one-off: fetch + trim the public word/name/place lists (records source + licence)
  fetch-equity-l.ts                 (C) R1  one-off: EQUITY_L.csv through NseClient → __fixtures__/equity-l-full.csv
  news-eval-export.ts               (C) E2  read-only export of ~1,000 headlines (stratified) → JSONL (unlabelled)
  sql/news-eval-export.sql          (C) E2  psql \copy alternative
  news-eval-label.ts                (C) E3  dev-CLI labeller: pass A, pass B, adjudicate; resumable
  news-eval-report.ts               (C) E4  prints the metric table for a tagger build

apps/api/src/modules/news-events/
  news-context-config.ts (+spec)    F1  parseNewsContextConfig, constants
  context-types.ts                  F2  shared v3 shapes (see Interfaces)
  testing-v3.ts                     F2  stubWordPolicy, fakeNewsLlm, fakePositionNews, fakeFeedbackSink, profile()/match() builders
  types.ts                          (M) F2  ArticleTags.drivers?, NewsRowLike.drivers?
  keys.ts                           (M) F2 toIndexedArticle/keysOfTags drivers; R4 MCX tables + composites
  config.ts                         (M) R6 TAG_VERSION 2
  news-events-core.module.ts        (M) F1 NEWS_CONTEXT_CONFIG provider + boot line
  news-events.structure.spec.ts     (M) F2 new pure files + ports
  news-context.safety.spec.ts       (C) F2 module-graph (direct imports) test for news-events/** and night-jobs/**
  schema-v3.spec.ts                 (C) F3 migration is expand-only
  __fixtures__/equity-l-full.csv    (C) R1 full NSE EQUITY_L snapshot (public)
  __fixtures__/mcx-master-names.json(C) R4
  __fixtures__/fo-stocks.json       (C) P3 F&O stock list fallback
  __fixtures__/eval/                (C) E1–E4 tiny synthetic fixture + (owner, Gate M0) headlines-2026-10.jsonl, baseline-v2.json
  tagging/
    brand-names.ts (+spec)          R1 computeGenericWords, brandShortName
    alias-derivation.ts (+spec)     (M) R1 kind 'short' rows
    lists/*.txt                     R2 english-30k, in-first-names, in-surnames, places (each with a source/licence header)
    word-policy.ts (+spec)          R2 loadWordLists, createWordPolicy
    ticker-hits.ts (+spec)          R2 positional ticker path with needs-context + person veto
    name-matcher.ts (+spec)         (M) F2 export tokenSpans; R2 match().hits (per-hit token span)
    phrase-trie.ts (+spec)          R3 literal phrase trie (case rule, longest match; never RegExp)
    market-entities.ts (+spec)      R3 IN/GLOBAL dictionaries, marketTagsV3
    market-sector-rules.ts          (M) R3 marketTags delegates to marketTagsV3 (signature unchanged)
    driver-catalogue.ts (+spec)     R4 DRIVER_CATALOGUE, driverTags
    commodity-index-keywords.ts     (M) R4 keyword sets for the 9 gaps
    tag-article.ts (+spec)          (M) R2/R3/R4/R6 needs-context, markets v3, drivers, compiled rules
    tagger.service.ts (+spec)       (M) R6 rules snapshot, ruleSetVersion, drivers, MCX snapshot check
  rules/
    compile-rules.ts (+spec)        R5 compileRules (literal phrases → tries/sets; alias_block wins)
    rule-store.ts (+spec)           R5 NewsRuleStore (rule sets, activate, rollback)
    news-tag-rules.service.ts (+spec) R6 active set cache, 5-min version poll, reload, droppedSources, candidate tagger
  ingest/
    retag.service.ts (+spec)        (M) R6 OR ruleSetVersion < active; retagWindow(now, ms)
    nse-announcements.service.ts    (M) R6 ruleSetVersion + drivers on insert
  index/
    news-index.ts (+spec)           (M) F2 get(id), itemsSince(ms)
    news-index.service.ts (+spec)   (M) F2 ROW_SELECT drivers, get, itemsSince; S3 peekV3
    ladder-v3.ts (+spec)            S3 v3 rungs, claim/drop, refs, fresh
  profiles/
    profile-schema.ts (+spec)       P1 validateProfile (JSON guard), PROFILE_LLM_SCHEMA, PROFILE_PROMPT_VERSION 'p1'
    baseline-profile.ts (+spec)     P1 buildBaselineProfile (pure)
    profile-gates.ts (+spec)        P2 gateProfile (uniqueness, prefix, needs-context, blast radius)
    blast-corpus.ts (+spec)         P2 BlastCorpus (30-d titles → phrase hit rate)
    profile.repository.ts (+spec)   P3 versions, active, staleness
    profile-build.service.ts (+spec) P3 ProfileBuildQueue, request/prebuild/flag, intraday cap
    profile-matcher.ts (+spec)      P4 compileProfiles, profileRelevance (pure)
    position-news-matcher.service.ts (+spec) P5 PositionNewsReader + MatcherRebuilder
    news-profiles.module.ts         P5
  feedback/
    news-feedback.module.ts             N3 repository + service + NewsRulesOps; provides NEWS_FEEDBACK
    news-rules-ops.ts (+spec)           N3 refreshAfterRuleChange, rollback
    dto/news-feedback.dto.ts            N3
    news-feedback.repository.ts (+spec) N3
    news-feedback.service.ts (+spec)    N3 NewsFeedbackSink impl, owner rows
    news-feedback.controller.ts (+spec) N3 POST /api/admin/news-tag-feedback, POST /api/admin/news-tag-rules/rollback
  audit/
    news-stats.ts (+spec)           N4 alias anomaly, candidate aliases, source hygiene (pure)
    news-stats.job.ts (+spec)       N4
    news-audit.job.ts (+spec)       N5
  curator/
    cluster.ts (+spec)              N6 deterministic clustering
    proposals.ts (+spec)            N6 LLM proposal prompt/schema/validation
    evaluate-proposal.ts (+spec)    N7 apply bar (P9), greedy accept (evaluator passed in as an argument)
    news-curator.job.ts (+spec)     N7 propose/auto, re-tag, rebuild, summary
  eval/
    labelled-set.ts (+spec)         E1 readLabelledSet, validateLabelledLine
    metrics.ts (+spec)              E1 evaluate, compareReports, formatReport
    export-plan.ts (+spec)          E2 stratifiedQuota
    label-prompts.ts (+spec)        E3 pass A/B/adjudicator prompts + schema
    label-merge.ts (+spec)          E3 mergePasses, pickRelevancePairs
    build-tagger.ts (+spec)         E4 buildFixtureTagger, runEvalReportForCi
    eval-report.spec.ts             E4 prints the table in CI (no thresholds)

apps/api/src/modules/night-jobs/
  news-llm.client.ts (+spec)        N1 NewsLlmClient (caps, breaker, estimate, session guard)
  news-llm.module.ts                N1 provides NEWS_LLM (imported by NewsProfilesModule and NightJobsModule)
  night-job-run.repository.ts (+spec) N2
  night-job-runner.ts (+spec)       N2 claim/lock/deadline/finish
  night-jobs.cron.ts (+spec)        N2 the three crons (audit+stats, curator, prebuild)
  night-jobs.module.ts              N2

apps/api/src/modules/ai-gateway/
  ai-job.ts                         (M) F1 four news.* jobs
  ai-gateway.service.ts (+spec)     (M) N1 callWithMeta (additive)
  routes/route-config.spec.ts, ai-gateway.service.spec.ts (M) F1 fixtures gain the four routes
  sentinel/sentinel-gateway.transport.ts (+spec) (M) S1 VERDICT_SCHEMA_N3 → sentinel.judge

apps/api/src/modules/trade-sentinel/
  ports/position-news.port.ts       (C) F2
  ports/news-feedback.port.ts       (C) F2
  ports/news-index.port.ts          (M) S3 peekV3?
  prompts/sentinel-system-prompt.ts (M) S1 newsV3 option, 3 lines, +n3 suffix
  services/sentinel-agent.service.ts (+spec) (M) S1/S2 VERDICT_SCHEMA_N3, newsIgnored parsing
  services/news-ignored.ts (+spec)  S2 parseNewsIgnored (pure)
  services/news-blocks-v3.ts (+spec) S3 newsBlocksV3, newsRefsOf, shadowSummaryV3
  services/context-packet.service.ts (M) S4 v3 render + shadow
  services/context-packet.news-v3.spec.ts (C) S4 v2-true hashes recorded first; v3 off/observe identity
  services/news-watch-book.ts       (M) S4 positionKey, onChange
  services/news-wake.service.ts     (M) S4 v3 wake via wakeHits
  adapters/tick-source.adapter.ts   (M) S4 fresh from peekV3 under v3 true
  services/sentinel-cycle.service.ts (M) S4 setWatched, newsIgnored → feedback
  golden/golden-fixtures.ts, golden/news-attribution.ts, golden/sentinel-golden.spec.ts (M) S5 new n3 scenarios (snapshots ADDED, never rewritten)

apps/api/src/app.module.ts          (M) I1 NewsProfilesModule, NewsFeedbackModule, NightJobsModule
apps/api/src/modules/news-events/news-context.wiring.spec.ts (C) I1 every v3 token resolves
apps/api/src/modules/news-events/news-context.flag-off.e2e.spec.ts (C) I1 flag-off identity end to end
apps/api/src/modules/trade-sentinel/trade-sentinel.module.ts (M) I1 POSITION_NEWS, NEWS_FEEDBACK bindings
```

---

## Foundation (on `feature/news-context-v3`, committed BEFORE any stream starts)

### Task F1: v3 config, AI jobs and routes, env

> ⚠ NEVER delete directories anywhere in the repo (no `Remove-Item -Recurse`, `rm -rf`, `rmdir /s`, `git clean -fdx`) — worktrees hold node_modules junctions into the shared install. Run ONLY the targeted tests named in this task.

**Files:**
- Create: `apps/api/src/modules/news-events/news-context-config.ts`, `apps/api/src/modules/news-events/news-context-config.spec.ts`
- Modify: `apps/api/src/modules/news-events/news-events-core.module.ts`, `apps/api/src/modules/ai-gateway/ai-job.ts`, `config/ai-routes.json`, `apps/api/src/modules/ai-gateway/routes/route-config.spec.ts`, `apps/api/src/modules/ai-gateway/ai-gateway.service.spec.ts`, `deploy/env/api.env.example`

**Interfaces:**
- Consumes: nothing (the file reads `NEWS_EVENTS_V2_ENABLED` itself with v2's exact-word rule; it must stay import-free).
- Produces: `NEWS_CONTEXT_CONFIG` provider (exported by `NewsEventsCoreModule`), `parseNewsContextConfig`, `newsContextBootLine`, all constants listed in Interfaces; `AiJob` gains `'news.profile' | 'news.audit' | 'news.curate' | 'news.label'`.

- [ ] **Step 0: Record the tsc baseline.** `cd apps/api && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -c "error TS"` → expect `174`. Every later task must print the same.

- [ ] **Step 1: Write the failing test** `news-context-config.spec.ts`:

```ts
import { newsContextBootLine, parseNewsContextConfig } from './news-context-config';

describe('parseNewsContextConfig', () => {
  it.each([
    // [NEWS_CONTEXT_V3, NEWS_EVENTS_V2_ENABLED, mode, computing, rendering]
    [undefined, 'observe', 'false', false, false],
    ['true', 'false', 'true', false, false],
    ['observe', 'observe', 'observe', true, false],
    ['true', 'observe', 'true', true, false],
    ['observe', 'true', 'observe', true, false],
    ['true', 'true', 'true', true, true],
    [' TRUE ', 'true', 'true', true, true],
    ['ture', 'true', 'false', false, false],
  ])('v3=%j v2=%j → mode %s computing %s rendering %s', (v3, v2, mode, computing, rendering) => {
    const c = parseNewsContextConfig({ NEWS_CONTEXT_V3: v3 as string | undefined, NEWS_EVENTS_V2_ENABLED: v2 });
    expect([c.mode, c.computing, c.rendering]).toEqual([mode, computing, rendering]);
  });

  it('v3 never computes when v2 is off', () => {
    expect(parseNewsContextConfig({ NEWS_CONTEXT_V3: 'true' })).toMatchObject({ mode: 'true', computing: false, rendering: false });
  });

  it('curator mode: exact words only; a typo is off and reported', () => {
    expect(parseNewsContextConfig({ NEWS_CURATOR_MODE: 'auto' }).curator).toBe('auto');
    expect(parseNewsContextConfig({ NEWS_CURATOR_MODE: ' Propose ' }).curator).toBe('propose');
    const c = parseNewsContextConfig({ NEWS_CURATOR_MODE: 'autp' });
    expect(c.curator).toBe('off');
    expect(c.problems).toEqual([expect.stringMatching(/NEWS_CURATOR_MODE="autp" is not off\|propose\|auto/)]);
  });

  it('defaults', () => {
    expect(parseNewsContextConfig({})).toEqual({
      mode: 'false', computing: false, rendering: false, curator: 'off', nightMaxCalls: 40, nightMaxInputTokens: 400000,
      profileMaxBuildsPerDay: 20, profileRefreshDays: 90, problems: [],
    });
  });

  it('out-of-range numbers fall back and are reported; 0 builds/day is legal', () => {
    const c = parseNewsContextConfig({ NEWS_LLM_NIGHT_MAX_CALLS: '500', NEWS_PROFILE_REFRESH_DAYS: '3', NEWS_PROFILE_MAX_BUILDS_PER_DAY: '0' });
    expect([c.nightMaxCalls, c.profileRefreshDays, c.profileMaxBuildsPerDay]).toEqual([40, 90, 0]);
    expect(c.problems).toHaveLength(2);
  });

  it('boot line', () => {
    expect(newsContextBootLine(parseNewsContextConfig({ NEWS_EVENTS_V2_ENABLED: 'observe', NEWS_CONTEXT_V3: 'observe', NEWS_CURATOR_MODE: 'propose' }))).toBe(
      '[news-ctx] v3=observe (computing) curator=propose caps=calls 40/night, input 400000/night, profiles 20/day refresh 90d',
    );
  });
});
```

- [ ] **Step 2: Run it** — `cd apps/api && npx jest src/modules/news-events/news-context-config.spec.ts --ci --maxWorkers=2` → FAIL (cannot find module).

- [ ] **Step 3: Implement** `news-context-config.ts` (PURE — no imports). Declare `NewsContextConfig` and every constant exactly as listed under Interfaces, then:

```ts
function word<T extends string>(raw: string | undefined, allowed: readonly T[], off: T, key: string, problems: string[]): T {
  const v = (raw ?? '').trim().toLowerCase();
  if ((allowed as readonly string[]).includes(v)) return v as T;
  if (v !== '') problems.push(`${key}="${raw}" is not ${allowed.join('|')} — treated as ${off}`);
  return off;
}

export function parseNewsContextConfig(env: Record<string, string | undefined>): NewsContextConfig {
  const problems: string[] = [];
  const mode = word<NewsContextMode>(env.NEWS_CONTEXT_V3, ['false', 'observe', 'true'], 'false', 'NEWS_CONTEXT_V3', problems);
  const curator = word<CuratorMode>(env.NEWS_CURATOR_MODE, ['off', 'propose', 'auto'], 'off', 'NEWS_CURATOR_MODE', problems);
  const v2 = (env.NEWS_EVENTS_V2_ENABLED ?? '').trim().toLowerCase(); // v2's own exact-word rule; v2 reports its typos
  const int = (key: string, def: number, min: number, max: number): number => {
    const v = env[key];
    if (v === undefined || v.trim() === '') return def;
    const n = Number(v.trim());
    if (!Number.isInteger(n) || n < min || n > max) {
      problems.push(`${key}=${v} is out of range [${min}, ${max}] — using ${def}`);
      return def;
    }
    return n;
  };
  return {
    mode,
    computing: (v2 === 'observe' || v2 === 'true') && mode !== 'false',
    rendering: v2 === 'true' && mode === 'true',
    curator,
    nightMaxCalls: int('NEWS_LLM_NIGHT_MAX_CALLS', 40, 0, 200),
    nightMaxInputTokens: int('NEWS_LLM_NIGHT_MAX_INPUT_TOKENS', 400_000, 0, 5_000_000),
    profileMaxBuildsPerDay: int('NEWS_PROFILE_MAX_BUILDS_PER_DAY', 20, 0, 200),
    profileRefreshDays: int('NEWS_PROFILE_REFRESH_DAYS', 90, 7, 365),
    problems,
  };
}

export function newsContextBootLine(c: NewsContextConfig): string {
  const state = c.rendering ? 'rendering' : c.computing ? 'computing' : 'idle';
  return (
    `[news-ctx] v3=${c.mode} (${state}) curator=${c.curator} caps=calls ${c.nightMaxCalls}/night, ` +
    `input ${c.nightMaxInputTokens}/night, profiles ${c.profileMaxBuildsPerDay}/day refresh ${c.profileRefreshDays}d`
  );
}
```

- [ ] **Step 4: Provider + boot line** in `news-events-core.module.ts`: add `{ provide: NEWS_CONTEXT_CONFIG, useFactory: () => parseNewsContextConfig(process.env) }` to `providers` and `NEWS_CONTEXT_CONFIG` to `exports`; inject it (`@Inject(NEWS_CONTEXT_CONFIG) private readonly ctx: NewsContextConfig`); in `onModuleInit`, after the v2 lines: `logger.log(newsContextBootLine(this.ctx)); for (const p of this.ctx.problems) logger.warn(\`[news-ctx] ${p}\`);`.

- [ ] **Step 5: AI jobs.** `ai-job.ts`: append `'news.profile', 'news.audit', 'news.curate', 'news.label'` after `'news.impact'` and extend the `priorityOf` comment ("news.profile|audit|curate|label fall to 4 — below every sentinel.*/review.*, spec §9.1"). Add to `config/ai-routes.json` AND to both spec fixtures (`route-config.spec.ts` `json()`, `ai-gateway.service.spec.ts` `ROUTES_JSON`):

```json
"news.profile": { "provider": "claude-cli", "model": "claude-sonnet-5", "fallback": [], "maxWaitMs": 300000 },
"news.audit":   { "provider": "claude-cli", "model": "claude-sonnet-5", "fallback": [], "maxWaitMs": 600000 },
"news.curate":  { "provider": "claude-cli", "model": "claude-sonnet-5", "fallback": [], "maxWaitMs": 600000 },
"news.label":   { "provider": "claude-cli", "model": "claude-sonnet-5", "fallback": [], "maxWaitMs": 600000 }
```

Add to `route-config.spec.ts` (import `priorityOf` from `../ai-job`):

```ts
it('news.* context jobs: claude-cli, Sonnet, no fallback (spec P4), priority 4', () => {
  const routes = loadRoutes(json(), {});
  for (const j of ['news.profile', 'news.audit', 'news.curate', 'news.label'] as const) {
    expect(routes[j]).toEqual(expect.objectContaining({ provider: 'claude-cli', model: 'claude-sonnet-5', fallback: [] }));
    expect(priorityOf(j)).toBe(4);
  }
});
```

- [ ] **Step 6: Env example** — append after the `NEWS_EVENTS_*` block of `deploy/env/api.env.example`:

```
# Position news context v3 (docs/superpowers/specs/2026-10-16-position-news-context-design.md §14)
# false|observe|true — renders only with NEWS_EVENTS_V2_ENABLED=true AND this =true.
NEWS_CONTEXT_V3=false
# off|propose|auto — auto acts as propose until 2 propose nights are recorded (P7).
NEWS_CURATOR_MODE=off
NEWS_LLM_NIGHT_MAX_CALLS=40
NEWS_LLM_NIGHT_MAX_INPUT_TOKENS=400000
NEWS_PROFILE_MAX_BUILDS_PER_DAY=20
NEWS_PROFILE_REFRESH_DAYS=90
```

- [ ] **Step 7: Verify** — `cd apps/api && npx jest src/modules/news-events/news-context-config.spec.ts src/modules/ai-gateway --ci --maxWorkers=2` → PASS. tsc → 174.

- [ ] **Step 8: Commit** — `git add` the eight files, then `git commit -m "feat(news-context): v3 config, news.* AI jobs and routes, env keys" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- <the same eight paths>`.

### Task F2: Shared v3 types, ports, index accessors, test stubs, safety test

> ⚠ NEVER delete directories anywhere in the repo (no `Remove-Item -Recurse`, `rm -rf`, `rmdir /s`, `git clean -fdx`) — worktrees hold node_modules junctions into the shared install. Run ONLY the targeted tests named in this task.

**Files:**
- Create: `news-events/context-types.ts`, `news-events/testing-v3.ts`, `news-events/news-context.safety.spec.ts`, `trade-sentinel/ports/position-news.port.ts`, `trade-sentinel/ports/news-feedback.port.ts`
- Modify: `news-events/types.ts`, `news-events/keys.ts` (`keysOfTags`, `toIndexedArticle` only), `news-events/keys.spec.ts`, `news-events/index/news-index.ts` (+spec), `news-events/index/news-index.service.ts` (+spec), `news-events/tagging/name-matcher.ts` (export only), `news-events/news-events.structure.spec.ts`

**Interfaces:**
- Produces: `context-types.ts` (incl. `DRIVER_BENCHMARKS`, the DI token strings and `RuleSetAdmin`) and the two ports exactly as in Interfaces; `ArticleTags.drivers?: string[]`, `NewsRowLike.drivers?: string[]`, `NewsPosition.components?: string[]`; `keysOfTags` emits `D:<KEY>`; `instrumentKeysOf` honours `components`; `NewsIndex.get(id)`, `NewsIndex.itemsSince(sinceMs)` (newest first); `NewsIndexService.get(id)`, `NewsIndexService.itemsSince(sinceMs)` (empty unless `ready`); `tokenSpans(text)` exported from `name-matcher.ts`.

- [ ] **Step 1: Write the failing tests.**

`keys.spec.ts` — add:

```ts
it('drivers: keyed D:<KEY>; absent or empty drivers add no key and no property', () => {
  expect(keysOfTags({ instruments: [], sectors: [], indices: [], markets: [], drivers: ['CRUDE_SUPPLY'] })).toEqual(['D:CRUDE_SUPPLY']);
  const row = { id: 'a', title: 't', source: 's', sentiment: null, publishedAt: new Date(0), fetchedAt: new Date(0), dateInferred: false,
    instruments: ['SBIN'], sectors: [], indices: [], markets: [] };
  expect(toIndexedArticle(row).tags).toEqual({ instruments: ['SBIN'], sectors: [], indices: [], markets: [] });
  expect('drivers' in toIndexedArticle({ ...row, drivers: [] }).tags).toBe(false);
  expect(toIndexedArticle({ ...row, drivers: ['GOLD_MACRO'] }).tags.drivers).toEqual(['GOLD_MACRO']);
});
```

`index/news-index.spec.ts` — add:

```ts
it('get(id) and itemsSince(ms) read without changing anything', () => {
  const ix = mk();
  ix.upsert(tagged('a', 10, ['SBIN']), NOW);
  ix.upsert(tagged('b', 400, ['TCS']), NOW);
  expect(ix.get('a')?.id).toBe('a');
  expect(ix.get('zz')).toBeUndefined();
  expect(ix.itemsSince(NOW - 6 * H).map((x) => x.id)).toEqual(['a']);
  expect(ix.itemsSince(0).map((x) => x.id)).toEqual(['a', 'b']);
  expect(ix.size).toBe(2);
});
```

`news-events.structure.spec.ts` — extend the existing tables (merge into the existing `it.each`; do not duplicate titles):

```ts
it.each(['types.ts', 'config.ts', 'news-context-config.ts'])('%s imports nothing', /* existing body */);
it('context-types.ts imports only types from ./types', () => {
  const src = readFileSync(join(__dirname, 'context-types.ts'), 'utf8');
  for (const m of src.matchAll(/^import\s+(.*)$/gm)) expect(m[1]).toMatch(/^type\s.*from '\.\/types';$/);
});
it.each(['news-index.port.ts', 'events.port.ts', 'position-news.port.ts', 'news-feedback.port.ts'])('the sentinel port %s is type-only', /* existing body */);
```

`news-context.safety.spec.ts` (spec §13; direct imports — "differs" 21):

```ts
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const MODULES = join(__dirname, '..');
const FORBIDDEN = /execution|order|broker|angel|smart-?api|trade-engine|auto-trade|sentinel-executor|exit-discipline|trade-core/i;
function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.ts$/.test(n) && !/\.spec\.ts$/.test(n) ? [p] : [];
  });
}

describe('spec §13: news context code imports nothing that can trade', () => {
  const all = [...files(join(MODULES, 'news-events')), ...files(join(MODULES, 'night-jobs'))];
  it('finds the files it checks', () => expect(all.length).toBeGreaterThan(30));
  it.each(all.map((f) => [f.slice(MODULES.length + 1)]))('%s', (rel) => {
    const src = readFileSync(join(MODULES, rel), 'utf8');
    const specs = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    expect(specs.filter((s) => FORBIDDEN.test(s))).toEqual([]);
  });
});
```

If an EXISTING v2 file fails this test, stop and report it to the coordinator — never weaken the pattern.

- [ ] **Step 2: Run** `cd apps/api && npx jest src/modules/news-events/keys.spec.ts src/modules/news-events/index/news-index.spec.ts src/modules/news-events/news-events.structure.spec.ts src/modules/news-events/news-context.safety.spec.ts --ci --maxWorkers=2` → FAIL (`drivers`, `get`, `itemsSince`, missing files).

- [ ] **Step 3: Implement.**
  - `types.ts`: `ArticleTags { …; /** v3 driver keys (§5.4); present only when non-empty. */ drivers?: string[] }`; `NewsRowLike { …; drivers?: string[] }`; `NewsPosition { …; /** v3 composite MCX index (MCXBULLDEX/MCXMETLDEX): its component benchmarks. Absent otherwise. */ components?: string[] }`.
  - `keys.ts`: `keysOfTags` appends `...(t.drivers ?? []).map((k) => \`D:${k}\`)`; `toIndexedArticle` spreads `...(row.drivers && row.drivers.length ? { drivers: [...row.drivers] } : {})` into `tags`; `instrumentKeysOf(p)` returns `(p.components ?? [p.key]).map(…)` with the existing `X:`/`I:` prefix rule (no position has `components` until R4, so nothing changes now).
  - `news-index.ts`:

```ts
/** The held article with this id (no copy), or undefined. */
get(id: string): IndexedArticle | undefined {
  return this.items.get(id)?.a;
}

/** Every held article published at or after `sinceMs`, newest first (a fresh array). */
itemsSince(sinceMs: number): IndexedArticle[] {
  let end = 0;
  while (end < this.order.length && this.order[end].publishedAt >= sinceMs) end++;
  return this.order.slice(0, end);
}
```

    and count `a.tags.drivers ?? []` in `approxBytes` with the other tag arrays.
  - `news-index.service.ts`: `ROW_SELECT` gains `drivers: true`; `get(id)` / `itemsSince(ms)` delegate to `this.index` and return `undefined` / `[]` unless `state === 'ready'`.
  - `name-matcher.ts`: rename the private `tokens` to exported `tokenSpans`; keep `const tokens = tokenSpans;`.
  - `context-types.ts` and both ports: verbatim from Interfaces.
  - `testing-v3.ts` (jest helpers; imported only by specs, like `testing.ts`):

```ts
import type { IndexedArticle, NewsPosition } from './types';
import { positionKeyOf } from './context-types';
import type {
  ContextVerdict, EntityProfile, NewsLlm, NewsLlmRequest, NewsLlmResult, NightBudgetSnapshot, PositionMatch, PositionMatchesPeek, WordPolicy,
} from './context-types';

/** A WordPolicy from explicit lists — for streams that build before R2 lands. */
export function stubWordPolicy(o: { needsContext?: string[]; person?: string[]; company?: string[] } = {}): WordPolicy {
  const lc = (xs: string[]) => new Set(xs.map((w) => w.toLowerCase()));
  const nc = lc(o.needsContext ?? ['Shah', 'Trent', 'Bailey', 'Apollo']);
  const person = lc(o.person ?? ['says', 'said', 'analyst', 'analysts', 'CEO', 'Mr', 'Ms']);
  const company = lc(o.company ?? ['Ltd', 'Limited', 'shares', 'stock', 'results', 'profit', 'IPO']);
  return {
    needsContext: (w) => nc.has(w.toLowerCase()),
    verdictAt(tokens, start, end): ContextVerdict {
      const win = [...tokens.slice(Math.max(0, start - 6), start), ...tokens.slice(end, end + 6)].map((t) => t.toLowerCase());
      if (win.some((t) => person.has(t))) return 'person';
      return win.some((t) => company.has(t)) ? 'company' : 'none';
    },
  };
}

export function profile(over: Partial<EntityProfile> & Pick<EntityProfile, 'symbol' | 'kind'>): EntityProfile {
  return { names: [], parent: [], subsidiaries: [], related: [], people: [], products: [], drivers: [], sector: null, indices: [], exclusions: [], ...over };
}

export function match(over: Partial<PositionMatch> & { articleId: string }): PositionMatch {
  return { layer: 'own', via: 'name', why: 'name: X', strength: 'strong', wakes: true, publishedAt: Date.UTC(2026, 9, 16, 4, 30), ...over };
}

/** Scripted NewsLlm: replies consumed in order; every request recorded. */
export function fakeNewsLlm(replies: NewsLlmResult[] = []) {
  const calls: NewsLlmRequest[] = [];
  let open: Date | null = null;
  const zero: NightBudgetSnapshot = { calls: 0, tokensIn: 0, tokensOut: 0, costInr: 0 };
  const llm: NewsLlm = {
    async call(req) {
      calls.push(req);
      if (open) return { ok: false, reason: 'breaker-open', detail: `stub breaker until ${open.toISOString()}` };
      return replies.shift() ?? { ok: false, reason: 'error', detail: 'fakeNewsLlm: no scripted reply' };
    },
    breakerOpenUntil: () => open,
    usage: () => ({ ...zero, calls: calls.length }),
  };
  return Object.assign(llm, { calls, openBreakerUntil: (d: Date | null) => { open = d; } });
}

export function fakePositionNews(peeks: Record<string, PositionMatchesPeek> = {}, wake: (a: IndexedArticle) => string[] = () => []) {
  return {
    setWatched: jest.fn((_: readonly NewsPosition[]) => undefined),
    peek: jest.fn((p: NewsPosition, _now?: Date): PositionMatchesPeek => peeks[positionKeyOf(p)] ?? { status: 'unavailable', reason: 'no stub peek' }),
    wakeHits: jest.fn(wake),
  };
}

export function fakeFeedbackSink() {
  return { recordJudge: jest.fn() };
}
```

- [ ] **Step 4: Verify** — the Step 2 command plus `src/modules/news-events/index/news-index.service.spec.ts src/modules/news-events/tagging/name-matcher.spec.ts src/modules/trade-sentinel/services/context-packet.news-events.spec.ts` → PASS (packet hashes unchanged: no fixture carries drivers). tsc → 174.

- [ ] **Step 5: Commit** — explicit pathspecs; `feat(news-context): shared v3 types, sentinel ports, index get/itemsSince, test stubs, safety test`.

### Task F3: Expand-only migration

> ⚠ NEVER delete directories anywhere in the repo (no `Remove-Item -Recurse`, `rm -rf`, `rmdir /s`, `git clean -fdx`) — worktrees hold node_modules junctions into the shared install. Run ONLY the targeted tests named in this task.

**Files:**
- Create: `prisma/migrations/20261017120000_news_context_v3/migration.sql`, `apps/api/src/modules/news-events/schema-v3.spec.ts`
- Modify: `prisma/schema.prisma`

**Interfaces:**
- Produces: `prisma.newsEntityProfile`, `prisma.newsTagRule`, `prisma.newsTagRuleSet`, `prisma.newsTagFeedback`, `prisma.nightJobRun`; `NewsArticle.ruleSetVersion: number`, `NewsArticle.drivers: string[]`.

- [ ] **Step 1: Write the failing test** `schema-v3.spec.ts`:

```ts
import { readFileSync } from 'fs';
import { join } from 'path';

const root = join(__dirname, '..', '..', '..', '..', '..');
const schema = readFileSync(join(root, 'prisma', 'schema.prisma'), 'utf8');
const sql = readFileSync(join(root, 'prisma', 'migrations', '20261017120000_news_context_v3', 'migration.sql'), 'utf8');

describe('news context v3 migration is expand-only (spec §12)', () => {
  it('never drops, alters or renames', () => expect(sql).not.toMatch(/\bDROP\b|ALTER COLUMN|RENAME/i));
  it('news_articles gains ruleSetVersion and drivers only', () => {
    expect(sql).toMatch(/ADD COLUMN "ruleSetVersion" INTEGER NOT NULL DEFAULT 0/);
    expect(sql).toMatch(/ADD COLUMN "drivers" TEXT\[\] DEFAULT ARRAY\[\]::TEXT\[\]/);
    expect(sql.match(/ALTER TABLE "news_articles"/g)).toHaveLength(1);
  });
  it.each(['news_entity_profiles', 'news_tag_rules', 'news_tag_rule_sets', 'news_tag_feedback', 'night_job_runs'])('creates %s', (t) => {
    expect(sql).toMatch(new RegExp(`CREATE TABLE "${t}"`));
  });
  it('uniques and indexes', () => {
    expect(sql).toMatch(/UNIQUE INDEX "news_entity_profiles_symbol_version_key"/);
    expect(sql).toMatch(/UNIQUE INDEX "news_tag_rule_sets_version_key"/);
    expect(sql).toMatch(/UNIQUE INDEX "night_job_runs_job_nightOf_key"/);
    expect(sql).toMatch(/INDEX "news_tag_feedback_createdAt_idx"/);
    expect(sql).toMatch(/INDEX "news_tag_feedback_kind_status_idx"/);
    expect(sql).toMatch(/INDEX "news_articles_drivers_idx" ON "news_articles" USING GIN \("drivers"\)/);
  });
  it('the schema declares the same', () => {
    expect(schema).toMatch(/model NewsEntityProfile \{[\s\S]*?@@unique\(\[symbol, version\]\)[\s\S]*?@@map\("news_entity_profiles"\)/);
    expect(schema).toMatch(/model NightJobRun \{[\s\S]*?@@unique\(\[job, nightOf\]\)[\s\S]*?@@map\("night_job_runs"\)/);
    expect(schema).toMatch(/ruleSetVersion\s+Int\s+@default\(0\)/);
  });
});
```

- [ ] **Step 2: Run** `cd apps/api && npx jest src/modules/news-events/schema-v3.spec.ts --ci --maxWorkers=2` → FAIL.

- [ ] **Step 3: Schema.** In `NewsArticle` add `ruleSetVersion Int @default(0)` and `drivers String[] @default([])` (doc "v3 §6/§5.4") and `@@index([drivers], type: Gin)`. After `MarketEvent` add:

```prisma
/// Position news context v3 (spec §4): versioned entity profile per underlying; one active.
model NewsEntityProfile {
  id            String   @id @default(cuid())
  symbol        String
  version       Int
  active        Boolean  @default(false)
  builtBy       String   // baseline | llm
  model         String?
  promptVersion String?
  profile       Json
  rejected      Json     @default("[]")
  createdAt     DateTime @default(now())

  @@unique([symbol, version])
  @@index([symbol, active])
  @@map("news_entity_profiles")
}

/// Rules as data (spec §6). Literal phrases only, never regex.
model NewsTagRule {
  id             String   @id @default(cuid())
  ruleSetVersion Int
  kind           String
  symbol         String?
  pattern        String
  params         Json     @default("{}")
  status         String   // proposed | active | rejected | rolled_back
  origin         String   // seed | curator | owner
  evidence       Json     @default("{}")
  createdAt      DateTime @default(now())

  @@index([ruleSetVersion])
  @@index([kind, status])
  @@map("news_tag_rules")
}

/// Immutable rule-set versions; exactly one active (spec §6).
model NewsTagRuleSet {
  id            String    @id @default(cuid())
  version       Int       @unique
  parentVersion Int?
  active        Boolean   @default(false)
  metrics       Json      @default("{}")
  summary       String    @default("")
  appliedAt     DateTime?
  createdAt     DateTime  @default(now())

  @@map("news_tag_rule_sets")
}

/// Wrong / misleading / missed tag log (spec §7).
model NewsTagFeedback {
  id               String   @id @default(cuid())
  articleId        String
  tag              String
  symbol           String?
  kind             String
  signal           String
  reason           String
  verdictId        String?
  trackerId        String?
  tagVersion       Int
  ruleSetVersion   Int
  status           String   @default("open")
  resolvedByRuleId String?
  createdAt        DateTime @default(now())

  @@index([createdAt])
  @@index([kind, status])
  @@index([articleId])
  @@map("news_tag_feedback")
}

/// One row per (job, nightOf) — the night runner's claim, budget and summary (spec §9.1).
model NightJobRun {
  id         String    @id @default(cuid())
  job        String
  nightOf    String    // YYYY-MM-DD, IST date of the evening
  status     String    // running | done | failed | skipped
  startedAt  DateTime  @default(now())
  finishedAt DateTime?
  budget     Json      @default("{}")
  summary    Json      @default("{}")
  error      String?

  @@unique([job, nightOf])
  @@index([job, startedAt])
  @@map("night_job_runs")
}
```

- [ ] **Step 4: Migration SQL** — hand-written to match what Prisma emits (v2 conventions: `TEXT[] DEFAULT ARRAY[]::TEXT[]`, `TIMESTAMP(3)`, `JSONB NOT NULL DEFAULT '[]'`, `<table>_pkey`, `<table>_<cols>_key|idx`):

```sql
-- Position news context v3 (docs/superpowers/specs/2026-10-16-position-news-context-design.md §12). Expand-only.
ALTER TABLE "news_articles"
  ADD COLUMN "ruleSetVersion" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "drivers" TEXT[] DEFAULT ARRAY[]::TEXT[];
CREATE INDEX "news_articles_drivers_idx" ON "news_articles" USING GIN ("drivers");

CREATE TABLE "news_entity_profiles" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "builtBy" TEXT NOT NULL,
    "model" TEXT,
    "promptVersion" TEXT,
    "profile" JSONB NOT NULL,
    "rejected" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "news_entity_profiles_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "news_entity_profiles_symbol_version_key" ON "news_entity_profiles"("symbol", "version");
CREATE INDEX "news_entity_profiles_symbol_active_idx" ON "news_entity_profiles"("symbol", "active");

CREATE TABLE "news_tag_rules" (
    "id" TEXT NOT NULL,
    "ruleSetVersion" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "symbol" TEXT,
    "pattern" TEXT NOT NULL,
    "params" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "evidence" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "news_tag_rules_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "news_tag_rules_ruleSetVersion_idx" ON "news_tag_rules"("ruleSetVersion");
CREATE INDEX "news_tag_rules_kind_status_idx" ON "news_tag_rules"("kind", "status");

CREATE TABLE "news_tag_rule_sets" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "parentVersion" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "metrics" JSONB NOT NULL DEFAULT '{}',
    "summary" TEXT NOT NULL DEFAULT '',
    "appliedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "news_tag_rule_sets_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "news_tag_rule_sets_version_key" ON "news_tag_rule_sets"("version");

CREATE TABLE "news_tag_feedback" (
    "id" TEXT NOT NULL,
    "articleId" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "symbol" TEXT,
    "kind" TEXT NOT NULL,
    "signal" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "verdictId" TEXT,
    "trackerId" TEXT,
    "tagVersion" INTEGER NOT NULL,
    "ruleSetVersion" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "resolvedByRuleId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "news_tag_feedback_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "news_tag_feedback_createdAt_idx" ON "news_tag_feedback"("createdAt");
CREATE INDEX "news_tag_feedback_kind_status_idx" ON "news_tag_feedback"("kind", "status");
CREATE INDEX "news_tag_feedback_articleId_idx" ON "news_tag_feedback"("articleId");

CREATE TABLE "night_job_runs" (
    "id" TEXT NOT NULL,
    "job" TEXT NOT NULL,
    "nightOf" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "budget" JSONB NOT NULL DEFAULT '{}',
    "summary" JSONB NOT NULL DEFAULT '{}',
    "error" TEXT,
    CONSTRAINT "night_job_runs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "night_job_runs_job_nightOf_key" ON "night_job_runs"("job", "nightOf");
CREATE INDEX "night_job_runs_job_startedAt_idx" ON "night_job_runs"("job", "startedAt");
```

Drift check (if a local shadow DB URL exists): `cd apps/api && npx prisma migrate diff --from-migrations ../../prisma/migrations --to-schema-datamodel ../../prisma/schema.prisma --shadow-database-url "$SHADOW_DATABASE_URL"` → "No difference detected". Without one: `npx prisma validate --schema ../../prisma/schema.prisma`, and say in the commit body that the drift check runs in I1 / the Gate.

- [ ] **Step 5: Verify** — `npx jest src/modules/news-events/schema-v3.spec.ts src/modules/news-events/schema.spec.ts --ci --maxWorkers=2` → PASS; `npx prisma generate --schema ../../prisma/schema.prisma`; tsc → 174.

- [ ] **Step 6: Commit** — `feat(news-context): expand-only migration (profiles, tag rules, rule sets, feedback, night job runs)`. The coordinator now creates the five stream worktrees from this commit (each runs `npx prisma generate` once).

---

## Stream R — systematic rules for every symbol (worktree `nctx-r`, branch `feature/nctx-r`)

Goal: spec §5 + §6 — the broad tagger's mistakes are fixed by rules that apply to every symbol (computed, list-driven, data-driven), never by growing hand lists. Tasks are sequential (R1 → R6). `tag-article.ts` is edited by R2, R3, R4 and R6 in that order.

### Task R1: Computed generic words and brand short-names

> ⚠ NEVER delete directories anywhere in the repo (no `Remove-Item -Recurse`, `rm -rf`, `rmdir /s`, `git clean -fdx`) — worktrees hold node_modules junctions into the shared install. Run ONLY the targeted tests named in this task.

**Files:**
- Create: `news-events/tagging/brand-names.ts`, `news-events/tagging/brand-names.spec.ts`, `news-events/__fixtures__/equity-l-full.csv`, `apps/api/scripts/fetch-equity-l.ts`
- Modify: `news-events/tagging/alias-derivation.ts` (+spec), `news-events/tagging/alias-loader.service.ts` (+spec), `news-events/tagging/name-matcher.ts` (accept kind `short`)

**Interfaces:**
- Consumes: `stripSuffixes`, `parseEquityL` (alias-derivation), `GENERIC_WORD_SHARE` (news-context-config).
- Produces: `computeGenericWords(names: readonly string[], share = GENERIC_WORD_SHARE): Set<string>` (lower-case tokens); `brandShortName(official: string, generic: ReadonlySet<string>): string | null`; `AliasKind` gains `'short'`; `deriveAliases(rows, curated?, blocklist?, blocked?, ambiguous?, generic?)` — the 6th parameter adds `short` rows (absent ⇒ exactly today's output).

- [ ] **Step 1: Capture the fixture.** `apps/api/scripts/fetch-equity-l.ts` (run with `cd apps/api && npx tsx scripts/fetch-equity-l.ts`) fetches `EQUITY_L_URL` through `new NseClient({ log: console.warn })` and writes the body unchanged to `src/modules/news-events/__fixtures__/equity-l-full.csv` (public NSE data, ~2,200 rows). If NSE refuses from your machine, stop and tell the coordinator (they fetch it once); do not hand-write rows.

- [ ] **Step 2: Write the failing tests** `brand-names.spec.ts`:

```ts
import { readFileSync } from 'fs';
import { join } from 'path';
import { brandShortName, computeGenericWords } from './brand-names';
import { deriveAliases, parseEquityL } from './alias-derivation';

const listed = parseEquityL(readFileSync(join(__dirname, '..', '__fixtures__', 'equity-l-full.csv'), 'utf8'));
const generic = computeGenericWords(listed.map((r) => r.name));

describe('computed generic words (spec §5.1)', () => {
  it('words in ≥ 0.5 % of EQUITY_L names are generic', () => {
    for (const w of ['insurance', 'company', 'industries', 'finance', 'holdings', 'technologies']) expect(generic.has(w)).toBe(true);
  });
  it('brand words are not', () => {
    for (const w of ['hdfc', 'infosys', 'wipro', 'voltas', 'motherson']) expect(generic.has(w)).toBe(false);
  });
  it('the threshold scales with the list, never a hand list', () => {
    const tiny = computeGenericWords(['Alpha Finance Limited', 'Beta Finance Limited', 'Gamma Steel Limited'], 0.5);
    expect([...tiny].sort()).toEqual(['finance']);
  });
});

describe('brandShortName', () => {
  it.each([
    ['HDFC Life Insurance Company Limited', 'HDFC Life'],
    ['Bajaj Holdings & Investment Limited', 'Bajaj'],
    ['Infosys Limited', null],        // nothing generic to drop ⇒ no short form (the derived name covers it)
  ])('%s → %s', (official, want) => expect(brandShortName(official, generic)).toBe(want));
});

describe('deriveAliases with short names', () => {
  const out = deriveAliases(listed, {}, undefined, new Set(), {}, generic);
  const shortOf = (s: string) => out.filter((a) => a.symbol === s && a.kind === 'short').map((a) => a.alias);
  it('HDFC Life → HDFCLIFE (the 2026-10-16 miss)', () => expect(shortOf('HDFCLIFE')).toEqual(['HDFC Life']));
  it('a short name that is a strict prefix shared by ≥ 2 companies is not kept', () => {
    expect(out.some((a) => a.alias === 'Bajaj' && a.kind === 'short')).toBe(false);
    expect(out.some((a) => a.alias === 'Tata' && a.kind === 'short')).toBe(false);
  });
  it('without the generic set the output is exactly today\'s', () => {
    expect(deriveAliases(listed.slice(0, 200))).toEqual(deriveAliases(listed.slice(0, 200), undefined, undefined, undefined, undefined, undefined));
    expect(deriveAliases(listed.slice(0, 200)).some((a) => a.kind === 'short')).toBe(false);
  });
});
```

Also add to `tag-article.spec.ts`:

```ts
it('HDFC Life shares slip despite analyst upgrades → HDFCLIFE (spec §1 case 1)', () => {
  const rows = [{ symbol: 'HDFCLIFE', name: 'HDFC Life Insurance Company Limited' }, { symbol: 'HDFCBANK', name: 'HDFC Bank Limited' }];
  const g = computeGenericWords(['HDFC Life Insurance Company Limited', 'X Insurance Company Limited', 'Y Insurance Company Limited'], 0.5);
  const m = new NameMatcher(deriveAliases(rows, {}, undefined, new Set(), {}, g));
  expect(tagArticle({ title: 'HDFC Life shares slip despite analyst upgrades', summary: '', source: 'ET', category: 'company' },
    { ...ctx, matcher: m }).instruments).toEqual(['HDFCLIFE']);
});
```

(If a fixture word's share sits right at the threshold — print `[...generic].sort()` once — change only the *example* row, never the 0.5 % rule.)

- [ ] **Step 3: Run** `cd apps/api && npx jest src/modules/news-events/tagging/brand-names.spec.ts src/modules/news-events/tagging/tag-article.spec.ts --ci --maxWorkers=2` → FAIL.

- [ ] **Step 4: Implement** `brand-names.ts`:

```ts
import { GENERIC_WORD_SHARE } from '../news-context-config';
import { stripSuffixes } from './alias-derivation';

const words = (s: string) => s.split(/\s+/).filter(Boolean);

/** Spec §5.1: a token present in ≥ `share` of the names is generic. Lower-case; counted once per name. */
export function computeGenericWords(names: readonly string[], share = GENERIC_WORD_SHARE): Set<string> {
  const counts = new Map<string, number>();
  for (const n of names) for (const w of new Set(words(stripSuffixes(n)).map((x) => x.toLowerCase()))) counts.set(w, (counts.get(w) ?? 0) + 1);
  const min = Math.max(2, Math.ceil(names.length * share));
  return new Set([...counts].filter(([, c]) => c >= min).map(([w]) => w));
}

/** Suffix-stripped name minus TRAILING generic tokens (and a dangling "&"); null when nothing was dropped or nothing is left. */
export function brandShortName(official: string, generic: ReadonlySet<string>): string | null {
  const full = stripSuffixes(official);
  const toks = words(full);
  while (toks.length > 1 && (generic.has(toks[toks.length - 1].toLowerCase()) || toks[toks.length - 1] === '&')) toks.pop();
  const short = toks.join(' ');
  return short && short !== full ? short : null;
}
```

  In `alias-derivation.ts`: `AliasKind = 'official' | 'derived' | 'short' | 'curated' | 'blocked'`; `deriveAliases(..., generic?: ReadonlySet<string>)`: when `generic` is given, push `{ kind: 'short' }` candidates from `brandShortName` (admissible() applies, as for derived), then before the uniqueness filter drop a `short` candidate when ≥ 2 symbols have an official/derived name starting with `${short} ` (strict-prefix rule; count the candidate's own symbol). The existing uniqueness filter (one owner) then applies to all kinds. `alias-loader.service.ts::refresh` passes `computeGenericWords(listed.map((r) => r.name))` as the 6th argument (and the four existing defaults explicitly). `name-matcher.ts` needs no logic change (`short` rows behave as `derived`); add `short` to its doc comment.

- [ ] **Step 5: Verify** — `npx jest src/modules/news-events/tagging --ci --maxWorkers=2` → PASS (existing alias-derivation/name-matcher/tag-article cases unchanged). tsc → 174.

- [ ] **Step 6: Commit** — `feat(news-events): computed generic words and brand short-names for every listed company (§5.1)`.

### Task R2: Needs-context word lists, person veto, positional ticker path

> ⚠ NEVER delete directories anywhere in the repo (no `Remove-Item -Recurse`, `rm -rf`, `rmdir /s`, `git clean -fdx`) — worktrees hold node_modules junctions into the shared install. Run ONLY the targeted tests named in this task.

**Files:**
- Create: `news-events/tagging/lists/english-30k.txt`, `lists/in-first-names.txt`, `lists/in-surnames.txt`, `lists/places.txt`, `lists/countries.txt`, `apps/api/scripts/fetch-word-lists.ts`, `news-events/tagging/word-policy.ts` (+spec), `news-events/tagging/ticker-hits.ts` (+spec)
- Modify: `news-events/tagging/name-matcher.ts` (+spec) (`match().hits`), `news-events/tagging/tag-article.ts` (+spec)

**Interfaces:**
- Consumes: `WordPolicy`, `ContextVerdict`, `CONTEXT_WINDOW_TOKENS`; `isTickerShaped`, `hasNoCaseSignal`, `AMBIGUOUS_SYMBOLS` from `../../news/services/extract-symbols` (read-only use, file not edited).
- Produces: `interface WordLists { english: Set<string>; firstNames: Set<string>; surnames: Set<string>; places: Set<string> }` (all lower-case); `loadWordLists(dir?: string): WordLists` (cached); `createWordPolicy(lists: WordLists, extraNeedsContext?: Iterable<string>): WordPolicy`; `tickerHits(text: string, listed: ReadonlySet<string>, policy: WordPolicy, ambiguous?: ReadonlySet<string>): Array<{ symbol: string; tokenStart: number; tokenEnd: number }>`; `NameMatcher.match(text)` additionally returns `hits: Array<{ symbols: string[]; tokenStart: number; tokenEnd: number; words: number }>`; `TagContext.policy?: WordPolicy` (absent ⇒ v2 behaviour, byte-for-byte).

- [ ] **Step 1: Lists (data, not code).** `scripts/fetch-word-lists.ts` downloads and trims: English top ~30,000 by frequency, common Indian first names, common Indian surnames, places (all countries + Indian cities with population > 100,000), and `countries.txt` (`Country|Demonym[,Demonym…]` per line, used by R3). Acceptable licences ONLY: public domain, CC0, MIT, Apache-2.0, CC-BY-4.0 (e.g. GeoNames `cities15000` CC-BY-4.0 for cities). Each file starts with `# source: <url> · licence: <id> · fetched <YYYY-MM-DD> · <n> entries`, then one lower-case entry per line. If no list with an acceptable licence exists for a category, STOP and ask the coordinator (Open Question 4) — never copy a list with an unknown or share-alike licence. Size budget: all five files together < 600 KB.

- [ ] **Step 2: Write the failing tests** `word-policy.spec.ts`:

```ts
import { createWordPolicy, loadWordLists } from './word-policy';
import { tokenSpans } from './name-matcher';

const policy = createWordPolicy(loadWordLists());
const at = (text: string, word: string) => {
  const t = tokenSpans(text).map((x) => x.t);
  const i = t.indexOf(word);
  return policy.verdictAt(t, i, i + 1);
};

describe('needsContext (spec §5.2)', () => {
  it.each(['Shah', 'Trent', 'Focus', 'Pune', 'Rajesh', 'Premium'])('%s needs context', (w) => expect(policy.needsContext(w)).toBe(true));
  it.each(['Infosys', 'Motherson', 'Voltas', 'NMDC'])('%s does not', (w) => expect(policy.needsContext(w)).toBe(false));
});

describe('verdictAt', () => {
  it('person context vetoes: "…, says Rajesh Shah"', () => expect(at('Nifty conquers 20-DMA, says Rajesh Shah', 'Shah')).toBe('person'));
  it('person context vetoes: analyst / Mr', () => {
    expect(at('Shah, analyst at a brokerage, sees upside', 'Shah')).toBe('person');
    expect(at('Mr Shah sold his stake', 'Shah')).toBe('person');
  });
  it('company context within ±6 tokens', () => {
    expect(at('Shah Q2 results beat estimates', 'Shah')).toBe('company');
    expect(at('Trent shares hit record high', 'Trent')).toBe('company');
    expect(at('Brokerages raise Trent target price', 'Trent')).toBe('company');
  });
  it('neither ⇒ none; context beyond 6 tokens does not count', () => {
    expect(at('Trent opens new stores across the country', 'Trent')).toBe('none');
    expect(at('Trent a b c d e f g shares', 'Trent')).toBe('none');
  });
  it('person beats company', () => expect(at('Shah says shares look cheap', 'Shah')).toBe('person'));
});
```

`ticker-hits.spec.ts`:

```ts
import { tickerHits } from './ticker-hits';
import { createWordPolicy, loadWordLists } from './word-policy';

const policy = createWordPolicy(loadWordLists());
const listed = new Set(['SHAH', 'TRENT', 'NMDC', 'GAIL', 'VOLTAS']);
const syms = (t: string) => tickerHits(t, listed, policy).map((h) => h.symbol);

it('SHAH not tagged from an analyst quote (spec §1 case 2)', () => expect(syms('Nifty conquers 20-DMA, says Rajesh Shah')).toEqual([]));
it('a Capitalised needs-context ticker needs company context', () => {
  expect(syms('Trent opens 40 stores')).toEqual([]);
  expect(syms('Trent shares jump 6%')).toEqual(['TRENT']);
});
it('ALL-CAPS tickers are exempt from the word lists (Gail is a name, GAIL the company)', () => {
  expect(syms('GAIL raises gas tariff')).toEqual(['GAIL']);
  expect(syms('NMDC raises iron ore prices')).toEqual(['NMDC']);
});
it('distinctive Capitalised tickers need nothing', () => expect(syms('Voltas launches new ACs')).toEqual(['VOLTAS']));
it('an all-caps headline tags nothing (v2 rule kept)', () => expect(syms('GAIL RAISES GAS TARIFF FOR ALL USERS')).toEqual([]));
```

`tag-article.spec.ts` — add (build `ctx` with `policy: createWordPolicy(loadWordLists())`):

```ts
it('with a policy: a single-word needs-context alias needs company context; person vetoes', () => {
  const m = new NameMatcher([{ symbol: 'TRENT', alias: 'Trent', kind: 'curated' }]);
  const c = { ...ctx, matcher: m, policy, listed: new Set<string>() };
  expect(tagArticle({ title: 'Trent opens 40 stores', summary: '', source: 'ET', category: 'company' }, c).instruments).toEqual([]);
  expect(tagArticle({ title: 'Trent shares jump 6%', summary: '', source: 'ET', category: 'company' }, c).instruments).toEqual(['TRENT']);
});
it('without a policy the v2 output is unchanged', () => {
  expect(t('Tata Motors recalls 10,000 cars')).toEqual({ instruments: ['TATAMOTORS'], sectors: ['NIFTY AUTO'], indices: [], markets: [] });
});
```

- [ ] **Step 3: Run** `cd apps/api && npx jest src/modules/news-events/tagging/word-policy.spec.ts src/modules/news-events/tagging/ticker-hits.spec.ts src/modules/news-events/tagging/tag-article.spec.ts --ci --maxWorkers=2` → FAIL.

- [ ] **Step 4: Implement.** `word-policy.ts`:

```ts
import { readFileSync } from 'fs';
import { join } from 'path';
import { CONTEXT_WINDOW_TOKENS } from '../news-context-config';
import type { ContextVerdict, WordPolicy } from '../context-types';

export interface WordLists { english: Set<string>; firstNames: Set<string>; surnames: Set<string>; places: Set<string> }

const read = (dir: string, f: string) =>
  new Set(readFileSync(join(dir, f), 'utf8').split(/\r?\n/).map((l) => l.trim().toLowerCase()).filter((l) => l && !l.startsWith('#')));
let cached: WordLists | null = null;
export function loadWordLists(dir = join(__dirname, 'lists')): WordLists {
  if (cached && dir === join(__dirname, 'lists')) return cached;
  const l = { english: read(dir, 'english-30k.txt'), firstNames: read(dir, 'in-first-names.txt'), surnames: read(dir, 'in-surnames.txt'), places: read(dir, 'places.txt') };
  if (dir === join(__dirname, 'lists')) cached = l;
  return l;
}

const COMPANY = new Set(['ltd', 'limited', 'shares', 'share', 'stock', 'stocks', 'scrip', 'q1', 'q2', 'q3', 'q4', 'results', 'earnings', 'profit', 'order', 'orders', 'ipo', 'dividend', 'nse', 'bse']);
const PERSON = new Set(['analyst', 'analysts', 'ceo', 'cfo', 'md', 'chairman', 'founder', 'economist', 'strategist', 'says', 'said', 'told', 'mr', 'ms', 'mrs', 'dr']);

export function createWordPolicy(lists: WordLists, extraNeedsContext: Iterable<string> = []): WordPolicy {
  const extra = new Set([...extraNeedsContext].map((w) => w.toLowerCase()));
  return {
    needsContext(word) {
      const w = word.toLowerCase();
      return extra.has(w) || lists.english.has(w) || lists.firstNames.has(w) || lists.surnames.has(w) || lists.places.has(w);
    },
    verdictAt(tokens, start, end): ContextVerdict {
      const lo = Math.max(0, start - CONTEXT_WINDOW_TOKENS);
      const win = [...tokens.slice(lo, start), ...tokens.slice(end, end + CONTEXT_WINDOW_TOKENS)].map((t) => t.toLowerCase());
      const prev = start > 0 ? tokens[start - 1] : '';
      const firstNameBefore = /^[A-Z][a-z]+$/.test(prev) && lists.firstNames.has(prev.toLowerCase());
      const accordingTo = win.some((t, i) => t === 'according' && win[i + 1] === 'to');
      if (firstNameBefore || accordingTo || win.some((t) => PERSON.has(t))) return 'person';
      const targetPrice = win.some((t, i) => t === 'target' && win[i + 1] === 'price');
      return targetPrice || win.some((t) => COMPANY.has(t)) ? 'company' : 'none';
    },
  };
}
```

  `ticker-hits.ts`: tokenize with `/[A-Za-z0-9&]+/g` keeping indices (same split as `tokenise` in extract-symbols); return `[]` when `hasNoCaseSignal(text)`; for each token: `isTickerShaped`, upper ∈ `listed`, ∉ `ambiguous` (default `AMBIGUOUS_SYMBOLS`); if the token is Capitalised (not ALL-CAPS) and `policy.needsContext(token)`, require `verdictAt(...) === 'company'` OR a literal `(TOKEN)` / `(NSE: TOKEN)` within ±40 characters in the raw text; a `person` verdict always skips a Capitalised token. De-duplicate, first-seen order.

  `name-matcher.ts::match`: also collect `hits` (token start/end index of each longest match and its word count). `tag-article.ts`: when `ctx.policy` is set — (a) for every name hit with `words === 1` whose word `policy.needsContext(...)`, keep it only when `verdictAt === 'company'`; a dropped hit's span is NOT consumed (so its text still reaches keywords); (b) tickers come from `tickerHits(text, ctx.listed, ctx.policy)` instead of `extractSymbols`. Without `ctx.policy` the code path is exactly today's.

- [ ] **Step 5: Verify** — `npx jest src/modules/news-events/tagging --ci --maxWorkers=2` → PASS. tsc → 174.

- [ ] **Step 6: Commit** — `feat(news-events): needs-context word lists with person veto on names and tickers (§5.2)` (include the five list files and the script).

### Task R3: Market classification by entity dictionaries

> ⚠ NEVER delete directories anywhere in the repo (no `Remove-Item -Recurse`, `rm -rf`, `rmdir /s`, `git clean -fdx`) — worktrees hold node_modules junctions into the shared install. Run ONLY the targeted tests named in this task.

**Files:**
- Create: `news-events/tagging/market-entities.ts` (+spec), `news-events/tagging/phrase-trie.ts` (+spec)
- Modify: `news-events/tagging/market-sector-rules.ts` (+spec), `news-events/tagging/tag-article.ts` (+spec)

**Interfaces:**
- Consumes: `tokenSpans`, `lists/countries.txt` (R2), `MarketTag`.
- Produces: `PhraseTrie<T>` — `new PhraseTrie<T>(entries: Iterable<{ phrase: string; value: T }>)`, `.find(text): Array<{ value: T; start: number; end: number }>` (case rule: a phrase with any upper-case letter matches case-sensitively, an all-lower-case phrase case-insensitively; longest match; literal tokens, never RegExp); `MARKET_ENTITIES_IN`, `MARKET_ENTITIES_GLOBAL` (readonly string[]); `marketTagsV3(category: string, text: string, extra?: ReadonlyArray<{ phrase: string; market: MarketTag }>): MarketTag[]`. `marketTags(category, text)` keeps its signature and delegates to `marketTagsV3` (no `extra`).

- [ ] **Step 1: Write the failing tests** `market-entities.spec.ts`:

```ts
import { marketTagsV3 } from './market-entities';

it.each([
  ['indian', "BoE's Bailey says inflation fight not over", ['GLOBAL']],                 // spec §1 case 3
  ['indian', 'Markets open flat', ['IN']],                                              // no entity ⇒ feed prior
  ['global', 'Asian stocks mixed', ['GLOBAL']],
  ['indian', 'RBI holds repo rate; Fed signals a pause', ['IN', 'GLOBAL']],
  ['company', 'SEBI tightens F&O rules', ['IN']],
  ['company', 'Tata Motors recalls 10,000 cars', []],
  ['global', 'Sitharaman meets US Treasury Secretary', ['IN', 'GLOBAL']],
  ['indian', "Yemen's Houthis hit Saudi infrastructure", ['GLOBAL']],
  ['sector', 'the fed-up investor', []],
  ['indian', 'Maharashtra cuts stamp duty', ['IN']],
  ['global', 'Chinese exports slump; Japanese yen weakens', ['GLOBAL']],
])('marketTagsV3(%s, %s)', (category, text, want) => expect(marketTagsV3(category, text)).toEqual(want));

it('owner/curator market_entity rules extend the dictionaries', () => {
  expect(marketTagsV3('indian', 'Bundesbank warns on growth')).toEqual(['IN']);
  expect(marketTagsV3('indian', 'Bundesbank warns on growth', [{ phrase: 'Bundesbank', market: 'GLOBAL' }])).toEqual(['GLOBAL']);
});
```

`phrase-trie.spec.ts`: case rule (`Fed` matches "Fed", not "fed-up"; `monsoon` matches "Monsoon"), longest match (`Federal Reserve` over `Federal`), a pathological pattern `"(a+)+$"` is matched literally and returns instantly on a 10,000-char input.

Existing `market-sector-rules.spec.ts` rows keep passing unchanged (re-run them).

- [ ] **Step 2: Run** `cd apps/api && npx jest src/modules/news-events/tagging/market-entities.spec.ts src/modules/news-events/tagging/phrase-trie.spec.ts src/modules/news-events/tagging/market-sector-rules.spec.ts --ci --maxWorkers=2` → FAIL.

- [ ] **Step 3: Implement.** `phrase-trie.ts` (token trie over `tokenSpans`; two tries — exact-case and lower-case). `market-entities.ts`:

```ts
/** Spec §5.3. Proper nouns, matched as written. Countries/demonyms ≠ India come from lists/countries.txt. */
export const MARKET_ENTITIES_IN: readonly string[] = [
  'RBI', 'Reserve Bank of India', 'Reserve Bank', 'SEBI', 'MPC', 'GST', 'GST Council', 'CBDT', 'Finance Ministry', 'MoF',
  'Ministry of Finance', 'Government of India', 'Centre', 'NSE', 'BSE', 'Sitharaman', 'Nirmala Sitharaman', 'Modi', 'Malhotra',
  "India's", 'Indian economy', 'India CPI', 'India GDP', 'India inflation',
  // states and union territories
  'Maharashtra', 'Gujarat', 'Karnataka', 'Tamil Nadu', 'Kerala', 'Telangana', 'Andhra Pradesh', 'Uttar Pradesh', 'Bihar',
  'West Bengal', 'Odisha', 'Rajasthan', 'Madhya Pradesh', 'Punjab', 'Haryana', 'Assam', 'Jharkhand', 'Chhattisgarh', 'Delhi',
];
export const MARKET_ENTITIES_GLOBAL_CORE: readonly string[] = [
  'Fed', 'FOMC', 'Federal Reserve', 'Powell', 'ECB', 'Lagarde', 'BoE', 'Bank of England', 'Bailey', 'BoJ', 'Bank of Japan', 'Ueda',
  'PBoC', 'Treasury yields', 'Treasury yield', 'Wall Street', 'Nasdaq', 'Dow', 'S&P 500', 'Nikkei', 'Hang Seng', 'FTSE', 'DAX',
  'White House', 'Kremlin', 'Beijing', 'Washington', 'OPEC', 'IMF', 'World Bank', 'US CPI', 'US inflation', 'US jobs', 'US payrolls',
];
// MARKET_ENTITIES_GLOBAL = core + every country (≠ India) and demonym in lists/countries.txt, plus "US", "U.S.", "UK", "EU".

export function marketTagsV3(category: string, text: string, extra: ReadonlyArray<{ phrase: string; market: MarketTag }> = []): MarketTag[] {
  const found = new Set(trieWith(extra).find(text).map((h) => h.value));
  if (found.size === 0) {
    if (category === 'indian') return ['IN'];
    if (category === 'global') return ['GLOBAL'];
    return [];
  }
  return (['IN', 'GLOBAL'] as const).filter((m) => found.has(m));
}
```

  (`trieWith(extra)` caches the default trie and builds a combined one only when `extra` is non-empty; cache by `extra` identity.) Plain "India"/"Indian" are deliberately NOT entities (too broad for company copy). `marketTags` in `market-sector-rules.ts` becomes `return marketTagsV3(category, text);` (delete `IN_RE`/`GLOBAL_RE`; their terms are in the dictionaries). `tag-article.ts` keeps calling `marketTags(a.category, rest)`; R6 passes rule entities.

- [ ] **Step 4: Verify** — `npx jest src/modules/news-events/tagging --ci --maxWorkers=2` → PASS (the existing `tag-article.spec.ts` market rows are unchanged). tsc → 174.

- [ ] **Step 5: Commit** — `feat(news-events): market tags from entity dictionaries; feed category only a prior (§5.3)`.

### Task R4: Driver catalogue, complete MCX map, composites, MCX snapshot

> ⚠ NEVER delete directories anywhere in the repo (no `Remove-Item -Recurse`, `rm -rf`, `rmdir /s`, `git clean -fdx`) — worktrees hold node_modules junctions into the shared install. Run ONLY the targeted tests named in this task.

**Files:**
- Create: `news-events/tagging/driver-catalogue.ts` (+spec), `news-events/__fixtures__/mcx-master-names.json`, `apps/api/scripts/mcx-master-snapshot.ts`, `news-events/mcx-completeness.spec.ts`
- Modify: `news-events/keys.ts` (+`keys.spec.ts`), `news-events/tagging/commodity-index-keywords.ts` (+spec), `news-events/tagging/tag-article.ts` (+spec), `news-events/tagging/tagger.service.ts` (+spec, message only)

**Interfaces:**
- Consumes: `DRIVER_KEYS`, `DRIVER_BENCHMARKS`, `DriverKey`, `PhraseTrie` (R3).
- Produces: `DRIVER_CATALOGUE: Readonly<Record<DriverKey, readonly string[]>>` (literal phrases); `driverTags(text: string, extra?: ReadonlyArray<{ phrase: string; driver: DriverKey }>): DriverKey[]` (first-appearance order); `MCX_COMPOSITES: Readonly<Record<string, readonly string[]>>`; `newsPositionOf` returns `components` for composites; `tagArticle` output gains `drivers` (only when non-empty).

- [ ] **Step 1: Snapshot.** `scripts/mcx-master-snapshot.ts` (read-only, `DATABASE_URL`): `SELECT DISTINCT name FROM instruments WHERE exchange='MCX' AND "isActive" ORDER BY 1` → writes `{ "generatedAt": ISO, "source": "instruments (MCX, isActive)", "names": [...] }`. Agents have NO prod access: seed the file by hand as `{ "generatedAt": "2026-10-17", "source": "seed: spec §1 list + keys.ts MCX_UNDERLYINGS; refresh with scripts/mcx-master-snapshot.ts (Gate)", "names": [ ...current MCX_UNDERLYINGS, "COTTON", "CARDAMOM", "COTTONOIL", "ELECDMBL", "MCXBULLDEX", "MCXMETLDEX", "SILVER100", "STEELREBAR", "SUNOIL" ] }`.

- [ ] **Step 2: Write the failing tests** `mcx-completeness.spec.ts` (replaces the list-against-itself check, spec §5.4):

```ts
import snapshot from './__fixtures__/mcx-master-names.json';
import { instrumentKeysOf, newsPositionOf } from './keys';
import { COMMODITY_KEYWORDS_V2 } from './tagging/commodity-index-keywords';
import { DRIVER_BENCHMARKS, DRIVER_KEYS } from './context-types';

describe('every live-master MCX underlying maps to a benchmark with keywords and ≥ 1 driver', () => {
  it.each((snapshot as { names: string[] }).names.map((n) => [n]))('%s', (name) => {
    const p = newsPositionOf(name, 'MCX', null);
    expect('unresolved' in p).toBe(false);
    if ('unresolved' in p) return;
    for (const k of instrumentKeysOf(p)) {
      const bench = k.slice(2);
      expect(COMMODITY_KEYWORDS_V2[bench]?.length ?? 0).toBeGreaterThan(0);
      expect(DRIVER_KEYS.some((d) => DRIVER_BENCHMARKS[d].benchmarks.includes(bench))).toBe(true);
    }
  });
  it('composites list their components', () => {
    expect(newsPositionOf('MCXBULLDEX', 'MCX', null)).toMatchObject({ key: 'MCXBULLDEX', components: ['GOLD', 'SILVER'] });
    expect(instrumentKeysOf(newsPositionOf('MCXMETLDEX', 'MCX', null) as never)).toEqual(['I:COPPER', 'I:ZINC', 'I:LEAD', 'I:ALUMINIUM', 'I:NICKEL']);
    expect(newsPositionOf('SILVER100', 'MCX', null)).toMatchObject({ key: 'SILVER' });
  });
});
```

`driver-catalogue.spec.ts`:

```ts
import { driverTags } from './driver-catalogue';
it.each([
  ["Yemen's Houthis hit Saudi infrastructure", ['CRUDE_SUPPLY']],     // spec §1 case 4
  ['Oil jumps as Strait of Hormuz tension rises', ['CRUDE_SUPPLY']],
  ['IMD sees normal monsoon; kharif sowing up', ['AGRI_MONSOON']],
  ['LME copper hits record on China PMI', ['BASE_METALS']],
  ['India raises palm oil import duty', ['EDIBLE_OIL']],
  ['Gold firms as dollar index slips', ['GOLD_MACRO']],
  ['Rupee hits record low against dollar', ['INR_USD']],
  ['the imd-like acronym', []],
])('%s', (text, want) => expect(driverTags(text)).toEqual(want));
it('curator driver_phrase rules extend the catalogue', () => {
  expect(driverTags('Bab el-Mandeb closure feared')).toEqual([]);
  expect(driverTags('Bab el-Mandeb closure feared', [{ phrase: 'Bab el-Mandeb', driver: 'CRUDE_SUPPLY' }])).toEqual(['CRUDE_SUPPLY']);
});
```

`tag-article.spec.ts` — add: `t("Yemen's Houthis hit Saudi infrastructure", 'ET', 'global')` → `toEqual({ instruments: [], sectors: [], indices: [], markets: ['GLOBAL'], drivers: ['CRUDE_SUPPLY'] })` (needs R3 + R4), and `t('Cardamom prices firm on lower arrivals').instruments` → `['CARDAMOM']`.

`tagger.service.spec.ts` "boot check" case: STEELREBAR is now mapped — change the mocked master to `[{ name: 'CRUDEOIL' }, { name: 'NEWMCXTHING' }]` and the expected line to `'[news-tag] MCX underlying without keyword set: NEWMCXTHING'` (spec §5.4 wording).

- [ ] **Step 3: Run** `cd apps/api && npx jest src/modules/news-events/mcx-completeness.spec.ts src/modules/news-events/tagging/driver-catalogue.spec.ts src/modules/news-events/tagging/tag-article.spec.ts src/modules/news-events/tagging/tagger.service.spec.ts src/modules/news-events/keys.spec.ts --ci --maxWorkers=2` → FAIL.

- [ ] **Step 4: Implement.**
  - `driver-catalogue.ts` — seed phrases (literal; case rule from `PhraseTrie`):

```ts
export const DRIVER_CATALOGUE: Readonly<Record<DriverKey, readonly string[]>> = {
  CRUDE_SUPPLY: ['OPEC', 'OPEC+', 'Strait of Hormuz', 'Hormuz', 'Red Sea', 'Houthi', 'Houthis', 'Saudi Aramco', 'Aramco', 'Saudi infrastructure',
    'Saudi oil facilities', 'oil sanctions', 'sanctions on Iran', 'sanctions on Russia', 'Iranian oil', 'Russian oil', 'oil output', 'production cut'],
  CRUDE_DEMAND: ['oil demand', 'crude demand', 'fuel demand', 'IEA', 'crude inventories', 'oil inventories', 'refinery runs', 'China oil imports'],
  GOLD_MACRO: ['Federal Reserve', 'rate cut', 'rate cuts', 'real yields', 'dollar index', 'DXY', 'central bank buying', 'central bank gold', 'safe haven', 'safe-haven'],
  BASE_METALS: ['LME', 'China PMI', 'Caixin', 'China property', 'Chinese property', 'smelter', 'smelters'],
  AGRI_MONSOON: ['IMD', 'monsoon', 'sowing', 'kharif', 'rabi', 'rainfall deficit'],
  INR_USD: ['rupee', 'USD/INR', 'dollar-rupee', 'forex reserves'],
  GAS_WEATHER: ['Henry Hub', 'heating demand', 'cold snap', 'heatwave', 'LNG exports', 'gas storage'],
  POWER_DEMAND: ['power demand', 'electricity demand', 'peak demand', 'power shortage', 'power exchange prices'],
  STEEL_CHINA: ['China steel', 'steel output', 'iron ore', 'steel exports', 'safeguard duty'],
  EDIBLE_OIL: ['palm oil', 'soyoil', 'soybean oil', 'sunflower oil', 'edible oil', 'edible oil import duty'],
  US_TECH_SPEND: ['IT spending', 'tech spending', 'H-1B', 'H1B', 'discretionary spending'],
  RBI_POLICY: ['RBI policy', 'repo rate', 'MPC'],
  FII_FLOWS: ['FII', 'FIIs', 'FPI', 'FPIs', 'foreign investors', 'foreign outflows', 'foreign inflows'],
  US_YIELDS: ['Treasury yields', 'US yields', '10-year yield', 'bond yields'],
};
```

  - `keys.ts`: `MCX_BENCHMARKS_V2` += `'CARDAMOM', 'COTTONOIL', 'SUNOIL', 'STEELREBAR', 'ELECDMBL'`; `MCX_PARENT_V2.SILVER100 = 'SILVER'`; `MCX_GROUP` += `CARDAMOM/COTTONOIL/SUNOIL: 'MCX AGRI'`, `STEELREBAR: 'MCX BASE METALS'`, `ELECDMBL: 'MCX ENERGY'`, `MCXBULLDEX: 'MCX BULLION'`, `MCXMETLDEX: 'MCX BASE METALS'`; `export const MCX_COMPOSITES = { MCXBULLDEX: ['GOLD', 'SILVER'], MCXMETLDEX: ['COPPER', 'ZINC', 'LEAD', 'ALUMINIUM', 'NICKEL'] }`; `MCX_UNDERLYINGS` = benchmarks (now including COTTON) ∪ parents ∪ composites; `newsPositionOf` for a composite returns `{ kind: 'COMMODITY', underlying: base, key: base, components: [...MCX_COMPOSITES[base]], exchange, expiry }`. The existing `keys.spec.ts`/`commodity-index-keywords.spec.ts` completeness loop must skip composites (they have no own keywords) — check their components instead.
  - `commodity-index-keywords.ts` `V2_EXTRA` += `CARDAMOM: [{ re: /\bcardamom\b/gi }]`, `COTTONOIL: [{ re: /\bcotton ?seed oil\b/gi }, { re: /\bcottonseed oil\b/gi }]`, `SUNOIL: [{ re: /\bsunflower oil\b/gi }]`, `STEELREBAR: [{ re: /\b(?:steel rebars?|rebar prices?|TMT bars?)\b/gi }]`, `ELECDMBL: [{ re: /\b(?:electricity|power) (?:futures|prices?)\b/gi }]` — each with a positive and a negative case added to `commodity-index-keywords.spec.ts`.
  - `tag-article.ts`: `const drivers = driverTags(rest, ctx.rules?.driverPhrases)`; the returned object spreads `...(drivers.length ? { drivers } : {})` LAST (so existing `toEqual`s with 4 keys stay green).
  - `tagger.service.ts::checkMcxCoverage`: missing = master names for which `newsPositionOf(n,'MCX',null)` is unresolved; line `[news-tag] MCX underlying without keyword set: ${missing.join(', ')}`.

- [ ] **Step 5: Verify** — `npx jest src/modules/news-events --ci --maxWorkers=2` (this module only) → PASS; also `src/modules/trade-sentinel/services/context-packet.news-events.spec.ts` (the MCX CRUDEOILM fixture hash must not move). tsc → 174.

- [ ] **Step 6: Commit** — `feat(news-events): price-driver catalogue, complete MCX map with composites, master snapshot (§5.4)`.

### Task R5: Rules as data — compile + store

> ⚠ NEVER delete directories anywhere in the repo (no `Remove-Item -Recurse`, `rm -rf`, `rmdir /s`, `git clean -fdx`) — worktrees hold node_modules junctions into the shared install. Run ONLY the targeted tests named in this task.

**Files:**
- Create: `news-events/rules/compile-rules.ts` (+spec), `news-events/rules/rule-store.ts` (+spec)

**Interfaces:**
- Consumes: `TagRuleInput`, `RULE_KINDS`, `isDriverKey`, `RuleSetAdmin`, `AliasRow`.
- Produces:

```ts
export interface CompiledRules {
  version: number;
  aliasAdd: AliasRow[];                                   // kind 'curated' rows (symbol-scoped)
  aliasBlock: ReadonlySet<string>;                         // `${symbol}|${alias}`; `*|${alias}` blocks every owner
  needsContextWords: ReadonlySet<string>;                  // lower-case
  genericWords: ReadonlySet<string>;                       // lower-case
  marketEntities: ReadonlyArray<{ phrase: string; market: MarketTag }>;
  driverPhrases: ReadonlyArray<{ phrase: string; driver: DriverKey }>;
  profileFlags: ReadonlyArray<{ symbol: string; reason: string }>;
  droppedSources: ReadonlySet<string>;
}
export const EMPTY_RULES: CompiledRules; // version 0, everything empty
export function compileRules(version: number, rows: readonly TagRuleInput[]): { rules: CompiledRules; problems: string[] };
export function aliasRowsWithRules(rows: readonly AliasRow[], rules: CompiledRules): AliasRow[]; // adds aliasAdd, removes blocked (block beats add)
export class NewsRuleStore implements RuleSetAdmin { constructor(prisma: PrismaService); activate(version: number): Promise<void>; … }
```

- [ ] **Step 1: Write the failing tests.** `compile-rules.spec.ts`:

```ts
import { aliasRowsWithRules, compileRules } from './compile-rules';

const r = (kind: string, pattern: string, extra: Partial<{ symbol: string | null; params: Record<string, unknown> }> = {}) =>
  ({ kind, pattern, symbol: extra.symbol ?? null, params: extra.params ?? {}, origin: 'curator', evidence: {} }) as never;

it('compiles every kind; invalid rows are reported and skipped, never thrown', () => {
  const { rules, problems } = compileRules(3, [
    r('alias_add', 'HDFC Life', { symbol: 'HDFCLIFE' }),
    r('alias_block', 'Shah', { symbol: 'SHAH' }),
    r('needs_context_word', 'Bailey'),
    r('generic_word', 'Ventures'),
    r('market_entity', 'Bundesbank', { params: { market: 'GLOBAL' } }),
    r('driver_phrase', 'Bab el-Mandeb', { params: { driver: 'CRUDE_SUPPLY' } }),
    r('source_drop', 'ET Auto', { params: { reason: 'DOWN 3 nights' } }),
    r('alias_add', 'No Symbol'),                                    // missing symbol
    r('market_entity', 'X', { params: { market: 'MARS' } }),        // bad param
    r('driver_phrase', 'Y y', { params: { driver: 'NOPE' } }),       // bad driver
    r('teleport', 'Z z'),                                           // unknown kind
  ]);
  expect(rules.version).toBe(3);
  expect(rules.aliasAdd).toEqual([{ symbol: 'HDFCLIFE', alias: 'HDFC Life', kind: 'curated' }]);
  expect([...rules.aliasBlock]).toEqual(['SHAH|Shah']);
  expect([...rules.needsContextWords]).toEqual(['bailey']);
  expect(rules.droppedSources.has('ET Auto')).toBe(true);
  expect(problems).toHaveLength(4);
});

it('patterns are literal: a regex-looking pattern is a phrase, compiled in linear time', () => {
  const { rules } = compileRules(1, [r('driver_phrase', '(a+)+$', { params: { driver: 'CRUDE_SUPPLY' } })]);
  expect(rules.driverPhrases).toEqual([{ phrase: '(a+)+$', driver: 'CRUDE_SUPPLY' }]);
});

it('patterns: trimmed, 2..80 chars, no control characters', () => {
  const { problems } = compileRules(1, [r('generic_word', 'a'), r('generic_word', 'x'.repeat(81)), r('generic_word', 'bad\u0007word')]);
  expect(problems).toHaveLength(3);
});

it('alias_block beats alias_add; * blocks every owner', () => {
  const { rules } = compileRules(1, [
    r('alias_add', 'Trent', { symbol: 'TRENT' }), r('alias_block', 'Trent', { symbol: 'TRENT' }), r('alias_block', 'Focus', { symbol: '*' }),
  ]);
  const out = aliasRowsWithRules([{ symbol: 'FOCUSX', alias: 'Focus', kind: 'derived' }, { symbol: 'INFY', alias: 'Infosys', kind: 'derived' }], rules);
  expect(out).toEqual([{ symbol: 'INFY', alias: 'Infosys', kind: 'derived' }]);
});
```

`rule-store.spec.ts` (Prisma mocked with an in-memory fake of `newsTagRuleSet`/`newsTagRule` + `$transaction(fn)` + `$executeRaw` for the lock): no sets ⇒ `activeVersion()` 0, `activeRules()` []; `createRuleSet({ parentVersion: 0, added: [A], metrics: {}, summary: 'a', activate: true })` ⇒ 1, active; `createRuleSet({ parentVersion: 1, added: [B], metrics: {}, summary: 'b', activate: true })` ⇒ 2 whose rules are [A, B] (copied, a set is a complete snapshot) and set 1 is inactive; `rollback()` ⇒ `{ from: 2, to: 1 }`, set 2's rules `rolled_back`, set 1 active; `rollback()` on set 1 ⇒ `{ from: 1, to: 0 }` (version 0 = seeds only: deactivate all); `rollback()` with nothing active ⇒ `null`; `propose([C])` writes `status: 'proposed', ruleSetVersion: <active>` and changes nothing active; `createRuleSet` with a stale `parentVersion` (≠ active) throws `stale parent` (two curators cannot race).

- [ ] **Step 2: Run** `cd apps/api && npx jest src/modules/news-events/rules --ci --maxWorkers=2` → FAIL.

- [ ] **Step 3: Implement.** `compile-rules.ts` — pure, validates per kind (`alias_add` needs a non-`*` symbol; `alias_block` symbol may be `*`; `market_entity` `params.market ∈ {IN, GLOBAL}`; `driver_phrase` `isDriverKey(params.driver)`; `profile_flag` needs a symbol; `source_drop` pattern = source name), never constructs a `RegExp` from a pattern. `rule-store.ts` — every write in `prisma.$transaction(async (tx) => { await tx.$executeRaw\`SELECT pg_advisory_xact_lock(hashtextextended('news_tag_rules', 0))\`; … })`; version = `max(version)+1`; `rollback` sets the active set inactive, its rules `rolled_back`, and the parent active (or none when the parent is 0/null); log `[news-rules] activated v${n} (${rules} rules) — ${summary}` / `[news-rules] rolled back v${from} → v${to}`.

- [ ] **Step 4: Verify** — same command → PASS. tsc → 174.

- [ ] **Step 5: Commit** — `feat(news-events): rules as data — literal-phrase compiler and immutable rule-set store (§6)`.

### Task R6: Tagger on rules; TAG_VERSION 2; ruleSetVersion everywhere; re-tag; source drop

> ⚠ NEVER delete directories anywhere in the repo (no `Remove-Item -Recurse`, `rm -rf`, `rmdir /s`, `git clean -fdx`) — worktrees hold node_modules junctions into the shared install. Run ONLY the targeted tests named in this task.

**Files:**
- Create: `news-events/rules/news-tag-rules.service.ts` (+spec)
- Modify: `news-events/config.ts` (`TAG_VERSION = 2`), `news-events/tagging/tag-article.ts` (+spec) (`TagContext.rules?`), `news-events/tagging/tagger.service.ts` (+spec), `news-events/ingest/retag.service.ts` (+spec), `news-events/ingest/nse-announcements.service.ts` (+spec), `news/services/news-aggregator.service.ts` (+`news-aggregator.service.spec.ts`), `news/news.module.ts`

**Interfaces:**
- Consumes: `CompiledRules`, `compileRules`, `aliasRowsWithRules`, `NewsRuleStore` (R5); `createWordPolicy`, `loadWordLists` (R2); `computeGenericWords` (R1); DI tokens `WORD_POLICY`, `CANDIDATE_TAGGER`, `RETAG_RUNNER`, `RULE_SET_ADMIN`, `INDEX_REBUILDER`, `MATCHER_REBUILDER` (context-types).
- Produces: `NewsTaggerService.tag()` → `{ tags, version, ruleSetVersion }`; `NewsTaggerService.setRules(rules: CompiledRules)`; `NewsTagRulesService` (`reload(): Promise<boolean>` — true when the version changed, `current(): CompiledRules`, `droppedSources(): ReadonlySet<string>`, `forRules(rows): TagFn` (`CandidateTagger`), `policy: WordPolicy`); `RetagService.retagWindow(now: Date, windowMs: number): Promise<number>` (`RetagRunner`); NewsModule provides and exports `WORD_POLICY`, `CANDIDATE_TAGGER`, `RETAG_RUNNER`, `RULE_SET_ADMIN` (= `NewsRuleStore`), `NewsTagRulesService`.

- [ ] **Step 1: Write the failing tests.**

`retag.service.spec.ts` — replace the `where` expectation and add rollback/stamping:

```ts
expect(prisma.newsArticle.findMany.mock.calls[0][0].where).toEqual({
  publishedAt: { gte: new Date('2026-10-14T05:00:00Z') },
  OR: [{ tagVersion: { lt: 2 } }, { ruleSetVersion: { not: 7 } }],
});
expect(prisma.newsArticle.update.mock.calls[0][0].data).toMatchObject({ tagVersion: 2, ruleSetVersion: 7 });
```

  (the tagger stub returns `{ tags, version: 2, ruleSetVersion: 7 }`; construct `RetagService` with a rules stub `{ current: () => ({ version: 7 }) }` as a new optional 5th constructor argument), plus `it('retagWindow(now, 6h) uses the given window')`.

`news-tag-rules.service.spec.ts`:

```ts
it('boot: loads the active set, hands it to the tagger, logs the version', async () => { /* store.activeVersion → 3, activeRules → [alias_block SHAH|Shah] ⇒ tagger.setRules called with version 3 */ });
it('poll: a version change (curator, endpoint or SQL) reloads, re-tags 48 h and asks the index and matcher to rebuild', async () => { /* activeVersion 3 → 2 ⇒ reload true; retag.retagWindow(now, 48h) called once; indexRebuilder.rebuild + matcherRebuilder.rebuildAll called when bound */ });
it('poll with no change does nothing', async () => {});
it('a store failure keeps the current rules and logs once', async () => {});
it('forRules(rows) tags with the candidate rules and does not touch the live tagger', () => {
  /* live rules empty; forRules([alias_block SHAH|Shah, ...]) TagFn on 'Shah shares jump' ⇒ no SHAH; live tagger unchanged */
});
it('droppedSources reflects source_drop rows of the active set', async () => {});
it('flag false (v2 not computing): no load, no poll', () => {});
```

`tagger.service.spec.ts`: `after rebuild … version` now expects `{ …, version: 2, ruleSetVersion: 0 }`; add `it('setRules: blocked aliases stop matching, added aliases match, ruleSetVersion is stamped', …)`.

`news-aggregator.service.spec.ts`: add (1) a saved row carries `drivers` and `ruleSetVersion` from the tagger; (2) a source in `droppedSources()` is not fetched (its URL is never requested) and is logged once `[news-source] ET Auto dropped by rule set v4`; (3) with `NEWS_EVENTS_V2_ENABLED=false` the create payload is byte-identical to today (no `drivers`/`ruleSetVersion` keys).

- [ ] **Step 2: Run** `cd apps/api && npx jest src/modules/news-events/rules src/modules/news-events/ingest src/modules/news-events/tagging/tagger.service.spec.ts src/modules/news-events/tagging/tag-article.spec.ts src/modules/news/services/news-aggregator.service.spec.ts --ci --maxWorkers=2` → FAIL.

- [ ] **Step 3: Implement.**
  - `config.ts`: `TAG_VERSION = 2` with a comment "v3 §5 systematic rules (R1–R6)".
  - `tag-article.ts`: `TagContext.rules?: CompiledRules` → `policy` honours `rules.needsContextWords` (the caller builds the policy with them as `extraNeedsContext`), `marketTags` gets `rules.marketEntities` (via `marketTagsV3`), `driverTags` gets `rules.driverPhrases`; `genericWords` rules are used by the alias loader (R1 `brandShortName`) on its next refresh.
  - `tagger.service.ts`: holds `rules = EMPTY_RULES`, `lastRows: AliasRow[]`, `policy = createWordPolicy(loadWordLists())`; `rebuild(rows)` stores `lastRows` and builds `new NameMatcher(aliasRowsWithRules(rows, this.rules))`; `setRules(r)` rebuilds the policy with `r.needsContextWords` and the matcher from `lastRows`, logs `[news-tag] rules v${r.version} applied to the matcher`; `tag()` passes `{ matcher, listed, sectors, policy, rules }` and returns `{ tags, version: loaded ? TAG_VERSION : 0, ruleSetVersion: this.rules.version }`.
  - `news-tag-rules.service.ts` (`@Injectable`, in NewsModule): `onApplicationBootstrap` → if `cfg.computing && bootJobsEnabled()`: `reload()` then `setInterval(() => void this.poll(), 5 * 60_000).unref()`; `reload()` reads `store.activeVersion()`/`activeRules()`, `compileRules`, logs problems as `[news-rules] skipped rule …`, `tagger.setRules`, returns whether the version changed; `poll()` → `if (await reload()) { await retag.retagWindow(new Date(), RETAG_WINDOW_MS); await indexRebuilder?.rebuild(); matcherRebuilder?.rebuildAll(); }` — every step caught and logged, never thrown. `forRules(rows)` returns a pure `TagFn` over a fresh `NameMatcher(aliasRowsWithRules(tagger.lastRows, compiled))` + policy + compiled rules.
  - `retag.service.ts`: `retagWindow(now, windowMs)` with the new `where`; `run(now)` = `retagWindow(now, RETAG_WINDOW_MS)`; each update writes `{ ...tags, drivers: tags.drivers ?? [], tagVersion: TAG_VERSION, ruleSetVersion: active }` (`active` = `rules?.current().version ?? 0`); terminates because every page leaves the predicate.
  - `nse-announcements.service.ts` + `news-aggregator.service.ts`: on insert add `drivers: v2.tags.drivers ?? []` and `ruleSetVersion: v2.ruleSetVersion` inside the existing `v2 ? {…} : {}` spread only (flag-false payload unchanged); the aggregator filters `(this.sourcesForTest ?? rssSources())` through `this.rules?.droppedSources()` (`@Optional() NewsTagRulesService`), logging each dropped source once per process.
  - `news.module.ts`: providers `NewsRuleStore`, `NewsTagRulesService`, `{ provide: WORD_POLICY, useFactory: (s: NewsTagRulesService) => s.policy, inject: [NewsTagRulesService] }`, `{ provide: CANDIDATE_TAGGER, useExisting: NewsTagRulesService }`, `{ provide: RETAG_RUNNER, useExisting: RetagService }`, `{ provide: RULE_SET_ADMIN, useExisting: NewsRuleStore }`; export all six. (`INDEX_REBUILDER` / `MATCHER_REBUILDER` are injected `@Optional()` here and bound in I1.)

- [ ] **Step 4: Verify** — the Step 2 command → PASS; then `npx jest src/modules/news-events src/modules/news --ci --maxWorkers=2` → PASS. tsc → 174.

- [ ] **Step 5: Commit** — `feat(news-events): tagger on rules-as-data, TAG_VERSION 2, ruleSetVersion on every write, re-tag on any set change, source drop (§5/§6)`.

---

## Stream P — open-position profiles and the position matcher (worktree `nctx-p`, branch `feature/nctx-p`)

Goal: spec §4. Everything in `news-events/profiles/`. P never imports R's code: it uses `WordPolicy` (stub in tests, R2's in I1), reads aliases from the `instrument_name_aliases` table (where R1 adds `short` rows), and drivers from `DRIVER_BENCHMARKS` (context-types).

### Task P1: Profile schema, deterministic baseline, defaults config

> ⚠ NEVER delete directories anywhere in the repo (no `Remove-Item -Recurse`, `rm -rf`, `rmdir /s`, `git clean -fdx`) — worktrees hold node_modules junctions into the shared install. Run ONLY the targeted tests named in this task.

**Files:**
- Create: `news-events/profiles/profile-schema.ts` (+spec), `news-events/profiles/baseline-profile.ts` (+spec), `config/news-driver-defaults.json`, `config/news-index-constituents.json`

**Interfaces:**
- Consumes: `EntityProfile`, `ProfileName`, `ProfileDriver`, `DRIVER_BENCHMARKS`, `isDriverKey`, `WordPolicy`, `NewsPosition`.
- Produces:

```ts
export const PROFILE_PROMPT_VERSION = 'p1';
export const PROFILE_LLM_SCHEMA: Record<string, unknown>;          // structured-output JSON schema (full `required`, additionalProperties false)
export interface ProfileLlmOutput {
  names: Array<{ text: string; strength: 'strong' | 'needs-context' }>;
  parent: Array<{ symbol: string; names: string[] }>;
  subsidiaries: Array<{ symbol: string; names: string[] }>;
  people: Array<{ fullName: string; role: string }>;
  products: string[];
  drivers: Array<{ key: string; note: string }>;
  exclusions: string[];
}
export function validateProfileOutput(raw: unknown): { ok: true; value: ProfileLlmOutput } | { ok: false; problems: string[] };
export function profileSystemPrompt(): string;
export function profileUserPrompt(input: { symbol: string; kind: PositionKind; officialName: string | null; sector: string | null; masterRows: Array<{ symbol: string; name: string; exchange: string }>; baseline: EntityProfile }): string;

export interface DriverDefaults { sectors: Record<string, Array<{ key: string; note: string }>>; symbols: Record<string, Array<{ key: string; note: string }>> }
export interface IndexConstituents { asOf: string; indices: Record<string, string[]> }   // index underlying → top-10 symbols
export interface BaselineInput {
  position: NewsPosition;                 // kind, key, components
  aliases: ReadonlyArray<{ alias: string; kind: string }>;   // this symbol's rows from instrument_name_aliases
  aliasesOf(symbol: string): ReadonlyArray<{ alias: string; kind: string }>;   // for constituents
  sector: string | null;
  defaults: DriverDefaults;
  constituents: IndexConstituents;
  policy: WordPolicy;
}
export function buildBaselineProfile(i: BaselineInput): EntityProfile;
export function loadDriverDefaults(): DriverDefaults;            // config/news-driver-defaults.json via resolveAiConfig-style walk-up
export function loadIndexConstituents(): IndexConstituents;      // config/news-index-constituents.json; warns when asOf > 45 days old
```

- [ ] **Step 1: Config files.** `config/news-driver-defaults.json`:

```json
{
  "_note": "Spec §4.2: sector → default price drivers; symbol overrides for businesses no NSE sector index captures. Keys are DriverKey values (context-types.ts).",
  "sectors": {
    "NIFTY IT": [{ "key": "INR_USD", "note": "revenue in USD" }, { "key": "US_TECH_SPEND", "note": "client spending" }],
    "NIFTY BANK": [{ "key": "RBI_POLICY", "note": "rates and liquidity" }],
    "NIFTY PSU BANK": [{ "key": "RBI_POLICY", "note": "rates and liquidity" }],
    "NIFTY PVT BANK": [{ "key": "RBI_POLICY", "note": "rates and liquidity" }],
    "NIFTY FIN SERVICE": [{ "key": "RBI_POLICY", "note": "rates and liquidity" }],
    "NIFTY METAL": [{ "key": "BASE_METALS", "note": "metal prices" }, { "key": "STEEL_CHINA", "note": "China steel" }],
    "NIFTY ENERGY": [{ "key": "CRUDE_SUPPLY", "note": "crude prices" }, { "key": "CRUDE_DEMAND", "note": "crude prices" }],
    "NIFTY PHARMA": [{ "key": "INR_USD", "note": "exports in USD" }],
    "NIFTY AUTO": [{ "key": "CRUDE_SUPPLY", "note": "fuel prices" }],
    "NIFTY FMCG": [{ "key": "AGRI_MONSOON", "note": "rural demand, inputs" }, { "key": "EDIBLE_OIL", "note": "input cost" }],
    "NIFTY REALTY": [{ "key": "RBI_POLICY", "note": "home-loan rates" }]
  },
  "symbols": {
    "BPCL": [{ "key": "CRUDE_SUPPLY", "note": "input cost" }, { "key": "CRUDE_DEMAND", "note": "input cost" }],
    "HINDPETRO": [{ "key": "CRUDE_SUPPLY", "note": "input cost" }, { "key": "CRUDE_DEMAND", "note": "input cost" }],
    "IOC": [{ "key": "CRUDE_SUPPLY", "note": "input cost" }, { "key": "CRUDE_DEMAND", "note": "input cost" }],
    "INDIGO": [{ "key": "CRUDE_SUPPLY", "note": "jet fuel cost" }, { "key": "INR_USD", "note": "USD leases" }],
    "SPICEJET": [{ "key": "CRUDE_SUPPLY", "note": "jet fuel cost" }],
    "ONGC": [{ "key": "CRUDE_SUPPLY", "note": "realisations" }],
    "OIL": [{ "key": "CRUDE_SUPPLY", "note": "realisations" }],
    "ASIANPAINT": [{ "key": "CRUDE_SUPPLY", "note": "input cost" }],
    "TITAN": [{ "key": "GOLD_MACRO", "note": "gold price" }]
  }
}
```

`config/news-index-constituents.json`: `{ "asOf": "2026-10-01", "_note": "Top-10 by weight; refresh monthly by hand (plan 'differs' 13).", "indices": { "NIFTY": [10 symbols], "BANKNIFTY": [10], "FINNIFTY": [10], "MIDCPNIFTY": [10], "NIFTYNXT50": [10], "SENSEX": [10], "BANKEX": [10], "SENSEX50": [10] } }` — fill from the NSE/BSE factsheets (public); every symbol must be an NSE symbol present in `__fixtures__/equity-l.csv`-style EQUITY_L (a spec test asserts each is `[A-Z0-9&-]+`).

- [ ] **Step 2: Write the failing tests** `baseline-profile.spec.ts` (use `stubWordPolicy`, `profile` from `testing-v3`):

```ts
import { buildBaselineProfile, loadDriverDefaults, loadIndexConstituents } from './baseline-profile';
import { stubWordPolicy } from '../testing-v3';

const policy = stubWordPolicy({ needsContext: ['Trent'] });
const defaults = loadDriverDefaults();
const constituents = { asOf: '2026-10-01', indices: { NIFTY: ['HDFCBANK', 'RELIANCE'] } };
const aliasesOf = (s: string) => ({ HDFCBANK: [{ alias: 'HDFC Bank', kind: 'curated' }], RELIANCE: [{ alias: 'Reliance Industries', kind: 'curated' }] } as Record<string, Array<{ alias: string; kind: string }>>)[s] ?? [];

it('STOCK: every alias becomes a name; single needs-context words are marked; sector + symbol drivers', () => {
  const p = buildBaselineProfile({
    position: { kind: 'STOCK', underlying: 'BPCL', key: 'BPCL', exchange: 'NFO', expiry: null },
    aliases: [{ alias: 'Bharat Petroleum Corporation Limited', kind: 'official' }, { alias: 'Bharat Petroleum', kind: 'short' }, { alias: 'BPCL', kind: 'curated' }],
    aliasesOf, sector: 'NIFTY ENERGY', defaults, constituents, policy,
  });
  expect(p.names.map((n) => n.text)).toEqual(['BPCL', 'Bharat Petroleum', 'Bharat Petroleum Corporation Limited']);
  expect(p.names.every((n) => n.strength === 'strong')).toBe(true);
  expect(p.drivers.map((d) => d.key).sort()).toEqual(['CRUDE_DEMAND', 'CRUDE_SUPPLY']);
  expect(p.drivers.every((d) => d.primary === false)).toBe(true);
  expect(p.sector).toBe('NIFTY ENERGY');
});

it('a single-word needs-context alias is kept as needs-context, never dropped', () => {
  const p = buildBaselineProfile({ position: { kind: 'STOCK', underlying: 'TRENT', key: 'TRENT', exchange: 'NSE', expiry: null },
    aliases: [{ alias: 'Trent', kind: 'derived' }], aliasesOf, sector: null, defaults, constituents, policy });
  expect(p.names).toEqual([{ text: 'Trent', strength: 'needs-context' }]);
});

it('INDEX: constituents become related with their names; macro drivers', () => {
  const p = buildBaselineProfile({ position: { kind: 'INDEX', underlying: 'NIFTY', key: 'NIFTY', exchange: 'NFO', expiry: null },
    aliases: [], aliasesOf, sector: null, defaults, constituents, policy });
  expect(p.related).toEqual([
    { symbol: 'HDFCBANK', relation: 'constituent', names: [{ text: 'HDFC Bank', strength: 'strong' }] },
    { symbol: 'RELIANCE', relation: 'constituent', names: [{ text: 'Reliance Industries', strength: 'strong' }] },
  ]);
  expect(p.drivers.map((d) => d.key).sort()).toEqual(['FII_FLOWS', 'INR_USD', 'RBI_POLICY', 'US_YIELDS']);
});

it('COMMODITY: drivers from DRIVER_BENCHMARKS, primary per benchmark; composites union their components', () => {
  const crude = buildBaselineProfile({ position: { kind: 'COMMODITY', underlying: 'CRUDEOILM', key: 'CRUDEOIL', exchange: 'MCX', expiry: null },
    aliases: [], aliasesOf, sector: 'MCX ENERGY', defaults, constituents, policy });
  expect(crude.drivers.filter((d) => d.primary).map((d) => d.key).sort()).toEqual(['CRUDE_DEMAND', 'CRUDE_SUPPLY']);
  expect(crude.drivers.find((d) => d.key === 'INR_USD')?.primary).toBe(false);
  const bull = buildBaselineProfile({ position: { kind: 'COMMODITY', underlying: 'MCXBULLDEX', key: 'MCXBULLDEX', components: ['GOLD', 'SILVER'], exchange: 'MCX', expiry: null },
    aliases: [], aliasesOf, sector: 'MCX BULLION', defaults, constituents, policy });
  expect(bull.drivers.find((d) => d.key === 'GOLD_MACRO')?.primary).toBe(true);
});

it('config files load and are well-formed', () => {
  expect(Object.keys(loadIndexConstituents().indices)).toEqual(expect.arrayContaining(['NIFTY', 'BANKNIFTY']));
  for (const list of Object.values(loadDriverDefaults().sectors)) for (const d of list) expect(d.key).toMatch(/^[A-Z_]+$/);
});
```

`profile-schema.spec.ts`: a valid object passes; wrong types / extra keys / > 30 names / text > 80 chars / non-string items fail with named problems; `PROFILE_LLM_SCHEMA.required` lists all 7 keys and `additionalProperties === false` at every object level; `profileUserPrompt` contains the baseline JSON and no `\u0000`.

- [ ] **Step 3: Run** `cd apps/api && npx jest src/modules/news-events/profiles --ci --maxWorkers=2` → FAIL.

- [ ] **Step 4: Implement.** `buildBaselineProfile`: names = unique aliases sorted (`localeCompare`), strength `needs-context` iff one word and `policy.needsContext(word)`; STOCK drivers = `defaults.sectors[sector] ∪ defaults.symbols[symbol]` (dedupe by key; `isDriverKey` filter; `primary: false`); `indices` = every index whose constituents include the symbol; INDEX: names `[]` (own is the guarded v2 keyword, ruling K2), related = constituents with their aliases (`strong`, curated/short/derived first, ≤ 3 names each), drivers `RBI_POLICY, FII_FLOWS, US_YIELDS, INR_USD` (`primary:false`); COMMODITY: benchmarks = `components ?? [key]`, drivers = every `DriverKey` whose `DRIVER_BENCHMARKS.benchmarks` intersects them, `primary` = `primaryFor` intersects them, `note` = `"price driver"`. `exclusions` `[]`. `profileSystemPrompt()` (versioned `p1`):

```
You build a NEWS-MATCHING PROFILE for one Indian market underlying (a listed company, an index, or an MCX commodity).
Return only literal phrases exactly as they appear in Indian financial headlines — never patterns, never regex.
names: every short name, brand and common abbreviation the press uses for THIS company (strength "needs-context" when the phrase is also an ordinary English word, a person's name or a place).
parent / subsidiaries: listed group companies with their NSE symbols and names; their news is related, not own.
people: current top executives and promoters by FULL name only (never a surname alone) with their role.
products: only distinctive product or brand names that are not ordinary words.
drivers: keys from this list only: CRUDE_SUPPLY, CRUDE_DEMAND, GOLD_MACRO, BASE_METALS, AGRI_MONSOON, INR_USD, GAS_WEATHER, POWER_DEMAND, STEEL_CHINA, EDIBLE_OIL, US_TECH_SPEND, RBI_POLICY, FII_FLOWS, US_YIELDS — each with a one-line note on why it moves this underlying.
exclusions: look-alike phrases that are NOT this entity (e.g. a namesake company abroad).
Prefer fewer, certain items over many guesses. Output JSON matching the schema.
```

- [ ] **Step 5: Verify** — same command → PASS. tsc → 174.

- [ ] **Step 6: Commit** — `feat(news-events): entity profile schema, deterministic baseline, driver defaults and index constituents (§4.1/§4.2)`.

### Task P2: Profile gates (uniqueness, prefix, needs-context, blast radius)

> ⚠ NEVER delete directories anywhere in the repo (no `Remove-Item -Recurse`, `rm -rf`, `rmdir /s`, `git clean -fdx`) — worktrees hold node_modules junctions into the shared install. Run ONLY the targeted tests named in this task.

**Files:**
- Create: `news-events/profiles/blast-corpus.ts` (+spec), `news-events/profiles/profile-gates.ts` (+spec)

**Interfaces:**
- Consumes: `tokenSpans` (name-matcher), `BLAST_RADIUS_MAX`, `ProfileLlmOutput`, `EntityProfile`, `ProfileRejection`, `WordPolicy`.
- Produces:

```ts
export class BlastCorpus {
  constructor(titles: readonly string[]);
  get size(): number;
  /** Share of titles containing `phrase` as a token sequence (case-sensitive as written; all-lower-case phrase ⇒ case-insensitive). */
  hitRate(phrase: string): number;
}
export interface GateContext {
  symbol: string;
  /** alias text → owning symbols, over ALL listed companies (official/derived/short/curated). */
  owners: ReadonlyMap<string, ReadonlySet<string>>;
  /** every official/derived name, for the strict-prefix rule. */
  allNames: readonly string[];
  generic: ReadonlySet<string>;
  policy: WordPolicy;
  corpus: BlastCorpus;
}
export function gateProfile(baseline: EntityProfile, llm: ProfileLlmOutput, ctx: GateContext): { profile: EntityProfile; rejected: ProfileRejection[] };
```

- [ ] **Step 1: Write the failing tests** `profile-gates.spec.ts`:

```ts
import { BlastCorpus } from './blast-corpus';
import { gateProfile } from './profile-gates';
import { profile, stubWordPolicy } from '../testing-v3';

const owners = new Map<string, Set<string>>([['HDFC Bank', new Set(['HDFCBANK'])], ['HDFC Life', new Set(['HDFCLIFE'])]]);
const titles = [
  ...Array.from({ length: 997 }, (_, i) => `Markets update ${i}: Sensex flat`),
  'Tata group to invest in chips', 'Tata group shares mixed', 'Tata group eyes EV',      // 3/1000 = 0.3 % — at the limit
];
const corpus = new BlastCorpus([...titles, 'Markets wrap: group results', 'group of ministers meets']);
const ctx = { symbol: 'TATAMOTORS', owners, allNames: ['Tata Motors', 'Tata Steel', 'Tata Power'], generic: new Set(['group', 'industries']),
  policy: stubWordPolicy({ needsContext: ['Harrier'] }), corpus };
const base = profile({ symbol: 'TATAMOTORS', kind: 'STOCK', names: [{ text: 'Tata Motors', strength: 'strong' }] });
const llm = (o: Partial<Parameters<typeof gateProfile>[1]>) => ({ names: [], parent: [], subsidiaries: [], people: [], products: [], drivers: [], exclusions: [], ...o });

it('a name another company owns is rejected as not-unique', () => {
  const r = gateProfile(base, llm({ names: [{ text: 'HDFC Bank', strength: 'strong' }] }), ctx);
  expect(r.rejected).toEqual([expect.objectContaining({ field: 'names', text: 'HDFC Bank', reason: 'not-unique' })]);
});
it('a strict prefix shared by ≥ 2 companies is rejected ("Tata")', () => {
  expect(gateProfile(base, llm({ names: [{ text: 'Tata', strength: 'strong' }] }), ctx).rejected[0].reason).toBe('prefix-shared');
});
it('a single generic word is rejected; a single needs-context word is kept as needs-context', () => {
  const r = gateProfile(base, llm({ names: [{ text: 'Group', strength: 'strong' }], products: ['Harrier'] }), ctx);
  expect(r.rejected.map((x) => x.reason)).toEqual(['generic']);
  expect(r.profile.products).toEqual([{ text: 'Harrier', strength: 'needs-context' }]);
});
it('blast radius: a phrase in > 0.3 % of the last 30 days is generic', () => {
  const r = gateProfile(base, llm({ names: [{ text: 'Markets update', strength: 'strong' }] }), ctx);
  expect(r.rejected[0]).toMatchObject({ reason: 'blast-radius' });
  expect(r.rejected[0].detail).toMatch(/9\d\.\d+ %/);
});
it('people: full names only; a lone surname is rejected', () => {
  const r = gateProfile(base, llm({ people: [{ fullName: 'Chandrasekaran', role: 'Chairman' }, { fullName: 'N Chandrasekaran', role: 'Chairman' }] }), ctx);
  expect(r.profile.people).toEqual([{ fullName: 'N Chandrasekaran', role: 'Chairman' }]);
  expect(r.rejected[0]).toMatchObject({ field: 'people', reason: 'too-short' });
});
it('unknown driver keys are rejected as schema; baseline names are never removed', () => {
  const r = gateProfile(base, llm({ drivers: [{ key: 'MOON_PHASE', note: 'x' }, { key: 'CRUDE_SUPPLY', note: 'fuel' }] }), ctx);
  expect(r.profile.drivers).toEqual([{ key: 'CRUDE_SUPPLY', note: 'fuel', primary: false }]);
  expect(r.profile.names[0].text).toBe('Tata Motors');
});
it('parent/subsidiary names may belong to the related symbol, not to a third company', () => {
  const r = gateProfile(base, llm({ subsidiaries: [{ symbol: 'HDFCLIFE', names: ['HDFC Life'] }, { symbol: 'XYZ', names: ['HDFC Bank'] }] }), ctx);
  expect(r.profile.subsidiaries).toEqual([{ symbol: 'HDFCLIFE', relation: 'subsidiary', names: [{ text: 'HDFC Life', strength: 'strong' }] }]);
});
```

`blast-corpus.spec.ts`: exact-case vs lower-case rule, token boundaries ("Tata" does not hit "Tatanagar"), `hitRate` on an empty corpus is 0, 20,000 titles build in < 200 ms.

- [ ] **Step 2: Run** `cd apps/api && npx jest src/modules/news-events/profiles/profile-gates.spec.ts src/modules/news-events/profiles/blast-corpus.spec.ts --ci --maxWorkers=2` → FAIL.

- [ ] **Step 3: Implement.** Gate order per LLM phrase: length < 3 or > 80 ⇒ `too-short`/`schema`; already in baseline ⇒ keep (no gate); `owners.get(text)` contains another symbol ⇒ `not-unique`; ≥ 2 `allNames` start with `text + ' '` ⇒ `prefix-shared`; one word and `generic.has(lower)` ⇒ `generic`; `corpus.hitRate(text) > BLAST_RADIUS_MAX` ⇒ `blast-radius` (detail `"<rate as %> of <n> titles"`); else keep — strength `needs-context` when one word and `policy.needsContext(word)`, else the LLM's strength. People: ≥ 2 tokens, then blast radius. Relations: owners check against the relation's own symbol. `BlastCorpus`: first-token index (exact and lower-case maps) → candidate titles → sequence compare.

- [ ] **Step 4: Verify** — same command → PASS. tsc → 174.

- [ ] **Step 5: Commit** — `feat(news-events): profile gates — uniqueness, prefix, needs-context, 0.3 % blast radius (§4.2)`.

### Task P3: Profile repository and build service (queue, caps, prebuild, flag)

> ⚠ NEVER delete directories anywhere in the repo (no `Remove-Item -Recurse`, `rm -rf`, `rmdir /s`, `git clean -fdx`) — worktrees hold node_modules junctions into the shared install. Run ONLY the targeted tests named in this task.

**Files:**
- Create: `news-events/profiles/profile.repository.ts` (+spec), `news-events/profiles/profile-build.service.ts` (+spec), `news-events/__fixtures__/fo-stocks.json`

**Interfaces:**
- Consumes: `NEWS_LLM` (`NewsLlm`, `@Optional()` — absent ⇒ baseline only), `NEWS_CONTEXT_CONFIG`, `NseClient` (for `fo_mktlots.csv`), `SectorMapService`, `WORD_POLICY` (`@Optional()` — absent ⇒ `stub` is NOT used in prod: builds are skipped with a log), Prisma (`newsEntityProfile`, `instrumentNameAlias`, `newsArticle`, `aiCall`, `tradeTracker`, `corePosition`, `newsTagRule`), P1/P2 functions.
- Produces:

```ts
export class ProfileRepository {
  active(symbol: string): Promise<StoredProfile | null>;
  activeMany(symbols: readonly string[]): Promise<Map<string, StoredProfile>>;
  save(row: Omit<StoredProfile, 'version' | 'active' | 'createdAt'>): Promise<StoredProfile>;   // next version, activates it, deactivates others (one tx)
  missingOrStale(symbols: readonly string[], refreshDays: number, now: Date): Promise<string[]>;
}
export class ProfileBuildService implements ProfilePrebuilder, ProfileFlagger {
  request(position: NewsPosition): void;                     // intraday; never throws; never awaited by callers
  prebuild(ctx: NightJobContext, limit: number): Promise<{ built: number; skipped: number; remaining: number }>;
  flag(symbol: string, reason: string): Promise<void>;
  baselineFor(position: NewsPosition): EntityProfile | null; // synchronous from the in-memory alias/sector maps; null until names loaded
  onBuilt(fn: (symbol: string) => void): () => void;         // P5 listens to reload the matcher
}
```

- [ ] **Step 1: Write the failing tests** `profile-build.service.spec.ts` (fake Prisma, `fakeNewsLlm`, `stubWordPolicy`, fixed clock):

```ts
it('request() is synchronous, de-duplicates, and builds once in the background', async () => { /* request(INFY) ×3 ⇒ one llm.call (job news.profile, scope intraday), one save with builtBy 'llm', promptVersion 'p1' */ });
it('LLM junk is gated: rejected[] stored with reasons; the profile still saves with the baseline names', async () => {});
it('intraday cap: the (cap+1)th request makes no call and logs once per day', async () => { /* cfg.profileMaxBuildsPerDay = 2 */ });
it('the intraday counter is seeded from ai_calls since IST midnight at boot', async () => { /* aiCall.count → 2 with cap 2 ⇒ first request makes no call */ });
it('an LLM failure (breaker-open, cap, unparseable) stores nothing and leaves the baseline in force', async () => {});
it('a missing NEWS_LLM or WORD_POLICY: request() logs once and does nothing', () => {});
it('prebuild: flagged first, then missing, then stale (> refresh days, or EQUITY_L official name changed); ≤ limit; stops at the deadline', async () => {
  /* universe = traded underlyings (180 d) ∪ INDEX_UNDERLYINGS_V2 ∪ MCX snapshot names ∪ fo_mktlots (NseClient; fixture fallback); scope 'night' */
});
it('prebuild stops at the first breaker-open and reports remaining', async () => {});
it('flag(symbol) puts it first in the next prebuild and is idempotent', async () => {});
```

`profile.repository.spec.ts`: version increments per symbol; `save` deactivates the previous active row in the same transaction; `missingOrStale` returns symbols with no active row or `createdAt < now − refreshDays`.

- [ ] **Step 2: Run** `cd apps/api && npx jest src/modules/news-events/profiles/profile-build.service.spec.ts src/modules/news-events/profiles/profile.repository.spec.ts --ci --maxWorkers=2` → FAIL.

- [ ] **Step 3: Implement.** Serial in-process queue (`private queue: NewsPosition[]; private running = false;` drained with `void this.drain()`; each item: baseline → `llm.call({ job: 'news.profile', scope, system: profileSystemPrompt(), user: profileUserPrompt(...), schema: PROFILE_LLM_SCHEMA, maxOutputTokens: 2000 })` → `validateProfileOutput` → `gateProfile` with `BlastCorpus` (titles of the last `BLAST_WINDOW_DAYS` days, loaded once per drain, cached 1 h) and `owners`/`allNames` from `instrument_name_aliases` (loaded at boot and daily 08:10 IST via `@Cron('0 10 8 * * 1-5', { timeZone: 'Asia/Kolkata' })`) → `save`, then notify `onBuilt` listeners). In-memory maps: `aliasesBySymbol`, `owners`, `allNames`, `officialName`. `baselineFor` uses them + `SectorMapService.sectorOf` + configs. F&O list: `NseClient.getText('NSE fo_mktlots', 'https://nsearchives.nseindia.com/content/fo/fo_mktlots.csv')` parsed for the SYMBOL column, cached per day; on failure `__fixtures__/fo-stocks.json` (seed it with ~200 current F&O symbols from the same public file; note its date in the JSON). Logs: `[news-profile] built INFY v3 (llm p1, 2 rejected)`, `[news-profile] INFY stays on its baseline: <reason>`, `[news-profile] prebuild: built 12, skipped 1, remaining 140`.

- [ ] **Step 4: Verify** — same command → PASS. tsc → 174.

- [ ] **Step 5: Commit** — `feat(news-events): profile store and bounded build queue — intraday cap, nightly prebuild, flags (§4.3)`.

### Task P4: The pure position matcher

> ⚠ NEVER delete directories anywhere in the repo (no `Remove-Item -Recurse`, `rm -rf`, `rmdir /s`, `git clean -fdx`) — worktrees hold node_modules junctions into the shared install. Run ONLY the targeted tests named in this task.

**Files:**
- Create: `news-events/profiles/profile-matcher.ts` (+spec)

**Interfaces:**
- Consumes: `EntityProfile`, `PositionMatch`, `positionKeyOf`, `DRIVER_BENCHMARKS`, `WordPolicy`, `tokenSpans`, `WHY_MAX`, `CandidateRelevance`, `TagFn`, `LabelledHeadline`.
- Produces:

```ts
export interface ProfileEntry { position: NewsPosition; profile: EntityProfile; version: number; builtBy: ProfileBuiltBy }
export type MatchInput = Pick<IndexedArticle, 'id' | 'title' | 'source' | 'publishedAt' | 'tags'>;
export interface CompiledProfiles {
  readonly keys: readonly string[];
  match(a: MatchInput): Array<PositionMatch & { positionKey: string }>;
}
export function compileProfiles(entries: readonly ProfileEntry[], policy: WordPolicy): CompiledProfiles;
export function createCandidateRelevance(
  entriesBySymbol: () => ReadonlyMap<string, ProfileEntry>,
  tagFor: (rules: readonly TagRuleInput[]) => TagFn,
  policyFor: (rules: readonly TagRuleInput[]) => WordPolicy,
): CandidateRelevance;
```

- [ ] **Step 1: Write the failing tests** `profile-matcher.spec.ts`:

```ts
import { compileProfiles } from './profile-matcher';
import { article } from '../testing';
import { profile, stubWordPolicy } from '../testing-v3';

const policy = stubWordPolicy({ needsContext: ['Trent'] });
const stock = (symbol: string, over = {}) => ({ position: { kind: 'STOCK' as const, underlying: symbol, key: symbol, exchange: 'NSE', expiry: null },
  profile: profile({ symbol, kind: 'STOCK', ...over }), version: 1, builtBy: 'llm' as const });
const c = compileProfiles([
  stock('HDFCLIFE', { names: [{ text: 'HDFC Life', strength: 'strong' }], drivers: [{ key: 'RBI_POLICY', note: 'rates', primary: false }] }),
  stock('TRENT', { names: [{ text: 'Trent', strength: 'needs-context' }], people: [{ fullName: 'Noel Tata', role: 'Chairman' }] }),
  stock('BPCL', { names: [{ text: 'BPCL', strength: 'strong' }], drivers: [{ key: 'CRUDE_SUPPLY', note: 'input cost', primary: false }],
    parent: [], exclusions: [] }),
  { position: { kind: 'COMMODITY' as const, underlying: 'CRUDEOILM', key: 'CRUDEOIL', exchange: 'MCX', expiry: null },
    profile: profile({ symbol: 'CRUDEOIL', kind: 'COMMODITY', drivers: [{ key: 'CRUDE_SUPPLY', note: 'supply', primary: true }, { key: 'INR_USD', note: 'fx', primary: false }] }),
    version: 1, builtBy: 'baseline' as const },
  { position: { kind: 'INDEX' as const, underlying: 'NIFTY', key: 'NIFTY', exchange: 'NFO', expiry: null },
    profile: profile({ symbol: 'NIFTY', kind: 'INDEX', related: [{ symbol: 'HDFCBANK', relation: 'constituent', names: [{ text: 'HDFC Bank', strength: 'strong' }] }],
      exclusions: ['Nifty Bank'] }), version: 1, builtBy: 'baseline' as const },
], policy);
const tags = (o: Partial<{ instruments: string[]; indices: string[]; drivers: string[] }> = {}) => ({ instruments: [], sectors: [], indices: [], markets: [], ...o });
const m = (title: string, t = tags(), source = 'ET') => c.match(article({ id: 'a1', title, source, tags: t }))
  .map((x) => `${x.positionKey}:${x.layer}:${x.via}:${x.wakes}:${x.why}`);

it('own by name, with why', () => expect(m('HDFC Life shares slip despite analyst upgrades')).toEqual(['STOCK:HDFCLIFE:own:name:true:name: HDFC Life']));
it('needs-context name: only with company context; person context vetoes', () => {
  expect(m('Trent opens 40 stores')).toEqual([]);
  expect(m('Trent shares jump 6%')).toEqual(['STOCK:TRENT:own:name:true:name: Trent']);
});
it('person by full name only', () => {
  expect(m('Noel Tata steps up retail push')).toEqual(['STOCK:TRENT:own:person:true:person: Noel Tata (Chairman)']);
  expect(m('Tata steps up retail push')).toEqual([]);
});
it('driver: stock driver rung (never wakes); commodity own via primary driver (wakes) — Houthi case', () => {
  expect(m("Yemen's Houthis hit Saudi infrastructure", tags({ drivers: ['CRUDE_SUPPLY'] }))).toEqual([
    'STOCK:BPCL:driver:driver:false:driver: CRUDE_SUPPLY → input cost',
    'COMMODITY:CRUDEOIL:own:driver:true:driver: CRUDE_SUPPLY → supply',
  ]);
  expect(m('Rupee slips', tags({ drivers: ['INR_USD'] }))).toEqual(['COMMODITY:CRUDEOIL:own:driver:false:driver: INR_USD → fx']);
});
it('commodity/index own = the guarded v2 keyword tag; exclusions veto; constituents are related', () => {
  expect(m('Crude rises 2%', tags({ instruments: ['CRUDEOIL'] }))).toEqual(['COMMODITY:CRUDEOIL:own:keyword:true:keyword: CRUDEOIL']);
  expect(m('Nifty ends higher', tags({ indices: ['NIFTY'] }))).toEqual(['INDEX:NIFTY:own:keyword:true:keyword: NIFTY']);
  expect(m('Nifty Bank slips; Nifty flat', tags({ indices: ['NIFTY'] }))).toEqual([]);
  expect(m('HDFC Bank Q2 profit rises')).toEqual(['INDEX:NIFTY:related:relation:false:constituent: HDFC Bank']);
});
it('an NSE filing force-tagged with the symbol is own', () => {
  expect(m('Board meeting outcome', tags({ instruments: ['BPCL'] }), 'NSE Announcements')).toEqual(['STOCK:BPCL:own:filing:true:NSE filing']);
});
it('a v2 instrument tag alone confirms nothing for a STOCK (P2)', () => expect(m('Shah sees upside', tags({ instruments: ['HDFCLIFE'] }))).toEqual([]));
it('why is ≤ 40 chars; one match per (position, article), best layer wins', () => {
  for (const x of c.match(article({ id: 'z', title: 'HDFC Life and HDFC Bank both rise', tags: tags({ drivers: ['RBI_POLICY'] }) }))) expect(x.why.length).toBeLessThanOrEqual(40);
});
it('all-caps headline: names do not match (v2 case rule)', () => expect(m('HDFC LIFE SHARES SLIP ON HEAVY VOLUMES TODAY')).toEqual([]));
it('match is µs: 5,000 articles × 25 profiles < 250 ms', () => { /* timing with performance.now() */ });
```

- [ ] **Step 2: Run** `cd apps/api && npx jest src/modules/news-events/profiles/profile-matcher.spec.ts --ci --maxWorkers=2` → FAIL.

- [ ] **Step 3: Implement** — one case-sensitive token trie over every phrase of every entry (names, products, people, relation names, exclusions), each terminal carrying `{ positionKey, kind: 'name'|'product'|'person'|'relation'|'exclusion', text, strength, relation?, role? }`; per article: `hasNoCaseSignal(title)` ⇒ skip phrase matching (keyword/driver/filing rules still apply); walk tokens (longest match), apply exclusions first (an exclusion hit for a key suppresses that key's own/keyword matches), apply needs-context/person rules through `policy.verdictAt`; then tag-based rules (K2); dedupe per key with priority `own > related > driver` and `wakes = any`; truncate `why` to `WHY_MAX` (`…` at 39 chars + 1). `createCandidateRelevance` → `forRules(rules)` returns `(h, symbol) => compileProfiles([entry], policyFor(rules)).match({ id: h.id, title: h.title, source: h.source, publishedAt: Date.parse(h.publishedAt), tags: tagFor(rules)(h) }).length > 0` (entries cached per symbol).

- [ ] **Step 4: Verify** — same command → PASS. tsc → 174.

- [ ] **Step 5: Commit** — `feat(news-events): pure open-position matcher — own/related/driver with why, P2/P3 semantics (§4.4)`.

### Task P5: PositionNewsMatcherService + module

> ⚠ NEVER delete directories anywhere in the repo (no `Remove-Item -Recurse`, `rm -rf`, `rmdir /s`, `git clean -fdx`) — worktrees hold node_modules junctions into the shared install. Run ONLY the targeted tests named in this task.

**Files:**
- Create: `news-events/profiles/position-news-matcher.service.ts` (+spec), `news-events/profiles/news-profiles.module.ts`

**Interfaces:**
- Consumes: `PositionNewsReader`, `MatcherRebuilder`, `NEWS_INGEST_BUS`, `NewsIndexService.itemsSince/get` (F2), `ProfileBuildService`, `ProfileRepository`, `compileProfiles`, `NEWS_CONTEXT_CONFIG`, `WORD_POLICY`, `MATCHER_MAX_PER_KEY`.
- Produces: `PositionNewsMatcherService implements PositionNewsReader, MatcherRebuilder`; `NewsProfilesModule` (imports `PrismaModule`, `NewsEventsCoreModule`, `NewsIndexModule`, `NewsLlmModule` — added by I1 if N is not merged yet, see I1) providing and exporting `ProfileRepository`, `ProfileBuildService`, `PositionNewsMatcherService`, `{ provide: PROFILE_PREBUILDER, useExisting: ProfileBuildService }`, `{ provide: PROFILE_FLAGGER, useExisting: ProfileBuildService }`, `{ provide: MATCHER_REBUILDER, useExisting: PositionNewsMatcherService }`, `{ provide: CANDIDATE_RELEVANCE, useFactory: … createCandidateRelevance … }`.

- [ ] **Step 1: Write the failing tests** `position-news-matcher.service.spec.ts` (fake bus = `InProcessNewsIngestBus`, fake index with `itemsSince`/`get`, fake build service with `baselineFor`/`request`/`onBuilt`, fake repo, `stubWordPolicy`):

```ts
it('v3 off (not computing): peek says unavailable, the bus is never subscribed, setWatched is a no-op', () => {});
it('setWatched is synchronous and cheap; the rebuild runs on setImmediate, off the caller', async () => {
  /* setWatched([INFY]) returns before any repo call; after `await new Promise(setImmediate)` repo.activeMany was called */
});
it('before the profile is compiled the peek is warming with a "failure to look" reason (Review Focus 2)', () => {
  expect(svc.peek(INFY, now)).toEqual({ status: 'warming', reason: expect.stringMatching(/still loading.*NOT a finding/) });
});
// Shared fixtures for this file:
// const INFY = { kind: 'STOCK', underlying: 'INFY', key: 'INFY', exchange: 'NSE', expiry: null } as const;
// const CRUDE = { kind: 'COMMODITY', underlying: 'CRUDEOILM', key: 'CRUDEOIL', exchange: 'MCX', expiry: null } as const;
// const okMatches = (p) => { const r = svc.peek(p, now); if (r.status !== 'ok') throw new Error(r.reason); return r.matches; };
// build.baselineFor(INFY) → profile({ symbol: 'INFY', kind: 'STOCK', names: [{ text: 'Infosys', strength: 'strong' }] });
// build.baselineFor(CRUDE) → profile({ symbol: 'CRUDEOIL', kind: 'COMMODITY', drivers: [{ key: 'CRUDE_SUPPLY', note: 'supply', primary: true }] }).
it('baseline first, then the stored LLM profile replaces it; a missing profile is requested once', async () => {});
it('rescans the index 24 h on a watched change (≤ 5,000 items < 50 ms)', async () => {});
it('ingest push: a matching article lands in matches within the same tick; others do not', () => {});
it('a republished article (retag) REPLACES its matches — a removed own match disappears (Review Focus 3)', async () => {
  // INFY watched, baseline names ['Infosys']; COMMODITY:CRUDEOIL watched too.
  svc.setWatched([INFY, CRUDE]);
  await new Promise(setImmediate);
  bus.publish([article({ id: 'a', title: 'Infosys wins deal', tags: tags({ drivers: ['CRUDE_SUPPLY'] }) })]);
  expect(okMatches(INFY).map((m) => m.articleId)).toEqual(['a']);
  expect(okMatches(CRUDE).map((m) => m.articleId)).toEqual(['a']);
  // Re-tag republishes the same id with different tags; the title no longer names Infosys (corrected feed text).
  bus.publish([article({ id: 'a', title: 'Wipro wins deal', tags: tags() })]);
  expect(okMatches(INFY)).toEqual([]);
  expect(okMatches(CRUDE)).toEqual([]);
});
it('bounded: ≤ 50 matches per key, newest kept, older than 24 h pruned', () => {});
it('unwatched keys are dropped from matches and from the compiled set', async () => {});
it('wakeHits uses the compiled set synchronously (works before the bus subscriber ran)', () => {});
it('rebuildAll reloads profiles and rescans', async () => {});
it('a listener that throws never breaks the bus (the bus already isolates; we also catch and log)', () => {});
```

- [ ] **Step 2: Run** `cd apps/api && npx jest src/modules/news-events/profiles/position-news-matcher.service.spec.ts --ci --maxWorkers=2` → FAIL.

- [ ] **Step 3: Implement.** State: `watched: Map<positionKey, NewsPosition>`, `entries: Map<positionKey, ProfileEntry>`, `compiled: CompiledProfiles | null`, `matches: Map<positionKey, PositionMatch[]>` (newest first), `byArticle: Map<articleId, Set<positionKey>>`. `onApplicationBootstrap`: if `cfg.computing && bootJobsEnabled()` subscribe to the bus. `setWatched(ps)`: compute keys; equal set ⇒ return; else store and `setImmediate(() => void this.refresh())`. `refresh()`: for new keys use `build.baselineFor(p)` (null ⇒ leave warming), recompile, rescan `index.itemsSince(now − 24 h)`; then `await repo.activeMany(symbols)` → replace entries whose stored profile exists (`builtBy: 'llm'` or `'baseline'` rows), `build.request(p)` for the rest; recompile + rescan; log `[news-match] watched=5 profiles llm 3/baseline 2 matches=17 rebuilt in 12ms`. `onBuilt(symbol)` ⇒ `refresh()`. Ingest: for each item, delete its previous matches (`byArticle`), then insert `compiled.match(item)` (sorted newest first, cap `MATCHER_MAX_PER_KEY`, drop < now − 24 h). `peek` builds `{ status:'ok', profileVersion, builtBy, matches }` from memory only. Never throws out of a bus callback (try/catch + `[news-match]` warn).

- [ ] **Step 4: Verify** — `npx jest src/modules/news-events/profiles --ci --maxWorkers=2` → PASS. tsc → 174.

- [ ] **Step 5: Commit** — `feat(news-events): position news matcher service — push matching, bounded, rebuild off the hot path (§4.4)`.

---

## Stream S — sentinel integration (worktree `nctx-s`, branch `feature/nctx-s`)

Goal: spec §4.5, §7.1, §8. Everything the judge sees. S builds against `fakePositionNews` / `fakeFeedbackSink` (F2); the real matcher (P5) and feedback sink (N3) are bound in I1. **Identity first:** S1 Step 1 and S4 Step 1 record hashes on the Foundation tip BEFORE any edit.

### Task S1: Prompt `+n3`, `VERDICT_SCHEMA_N3`, 16 hash pins

> ⚠ NEVER delete directories anywhere in the repo (no `Remove-Item -Recurse`, `rm -rf`, `rmdir /s`, `git clean -fdx`) — worktrees hold node_modules junctions into the shared install. Run ONLY the targeted tests named in this task.

**Files:**
- Modify: `trade-sentinel/prompts/sentinel-system-prompt.ts`, `trade-sentinel/services/sentinel-agent.service.ts` (schema + options only), `trade-sentinel/services/sentinel-agent.service.spec.ts`, `trade-sentinel/golden/news-attribution.ts`, `ai-gateway/sentinel/sentinel-gateway.transport.ts` (+spec)

**Interfaces:**
- Consumes: `parseNewsContextConfig` (F1), `NEWS_IGNORED_MAX`.
- Produces: `SentinelPromptOptions.newsV3?: boolean` (effective only with `news: true`); `V3_NEWS_READING_LINES`, `V3_NEWS_IGNORED_RULE` (exported constants); `sentinelPromptVersion` appends `+n3`; `VERDICT_SCHEMA_N3` (new object; `VERDICT_SCHEMA` untouched); `NEWS_IGNORED_SCHEMA`; `undoN3(prompt)` in `golden/news-attribution.ts`; `jobFor` maps `VERDICT_SCHEMA_N3` → `sentinel.judge`.

- [ ] **Step 1: Record the 8 news-on hashes on the Foundation tip (before ANY edit).**

```bash
cd apps/api && npx tsx -e "
const { createHash } = require('crypto');
const { sentinelSystemPrompt } = require('./src/modules/trade-sentinel/prompts/sentinel-system-prompt');
const ON = [[true,false,true],[false,false,true],[true,false,false],[false,false,false],[true,true,false],[false,true,false],[true,true,true],[false,true,true]];
for (const [cues,triggers,discipline] of ON) { const t = sentinelSystemPrompt({ cues, triggers, discipline, news: true });
  console.log(JSON.stringify({ cues, triggers, discipline, len: t.length, sha: createHash('sha256').update(t,'utf8').digest('hex') })); }"
```

Paste the eight `{len, sha}` pairs into a new constant table in `sentinel-agent.service.spec.ts` (`/** feature/news-context-v3 @ <F3 sha>, recorded in news-context Task S1 Step 1. */ const NEWS_ON_PINS`) and add:

```ts
it('NEWS ON IS UNCHANGED, BYTE FOR BYTE: v9–v12 / v2.6–v2.9 hash-pinned (the other 8 of the 16)', () => {
  for (const [o, stamp] of ON) {
    const t = sentinelSystemPrompt(o);
    expect([stamp, t.length, sha(t)]).toEqual([stamp, NEWS_ON_PINS[stamp].len, NEWS_ON_PINS[stamp].sha]);
  }
});
```

Run `npx jest src/modules/trade-sentinel/services/sentinel-agent.service.spec.ts --ci --maxWorkers=2` → PASS (pins taken from the same code). Commit this pin alone first: `test(trade-sentinel): pin the eight news-on prompt hashes before v3`.

- [ ] **Step 2: Write the failing tests** (in `sentinel-agent.service.spec.ts`, INSIDE the existing `describe('prompt v9–v12 / v2.6–v2.9 (news & events v2)')` so `ON`, `OFF`, `sha`, `packet`, `reply`, `validVerdict` are in scope; import `VERDICT_SCHEMA_N3`, `NEWS_IGNORED_SCHEMA`, `V3_NEWS_READING_LINES`, `V3_NEWS_IGNORED_RULE`, `undoN3`):

```ts
describe('prompt +n3 (news context v3)', () => {
  const N3 = ON.map(([o, stamp]) => [{ ...o, newsV3: true }, `${stamp}+n3`] as [SentinelPromptOptions, string]);

  it.each(N3)('%j is stamped %s', (o, stamp) => expect(sentinelPromptVersion(o)).toBe(stamp));
  it.each(OFF)('%j with newsV3 but news off is the news-off text and stamp (n3 needs v2 rendering)', (o, stamp) => {
    expect(sentinelSystemPrompt({ ...o, newsV3: true })).toBe(sentinelSystemPrompt(o));
    expect(sentinelPromptVersion({ ...o, newsV3: true })).toBe(stamp);
  });
  it('the 16 existing texts are untouched (newsV3 false/absent)', () => {
    for (const [o, stamp] of ON) expect(sha(sentinelSystemPrompt({ ...o, newsV3: false }))).toBe(NEWS_ON_PINS[stamp].sha);
  });
  it.each(N3)('%j differs from its news twin ONLY by the three v3 lines', (o) => {
    expect(undoN3(sentinelSystemPrompt(o))).toBe(sentinelSystemPrompt({ ...o, newsV3: false }));
    const p = sentinelSystemPrompt(o);
    expect(p.split(V3_NEWS_READING_LINES)).toHaveLength(2);
    expect(p.split(V3_NEWS_IGNORED_RULE)).toHaveLength(2);
    expect(p).toMatch(/never changes your verdict/);
  });
  it('24 distinct texts, 24 distinct stamps', () => {
    const all = [...OFF, ...ON, ...N3];
    expect(new Set(all.map(([o]) => sentinelSystemPrompt(o))).size).toBe(24);
    expect(new Set(all.map(([, v]) => v)).size).toBe(24);
  });
  it('VERDICT_SCHEMA keeps its identity and keys; VERDICT_SCHEMA_N3 = it + required newsIgnored', () => {
    expect(VERDICT_SCHEMA.required).toEqual(['verdict', 'confidence', 'thesisStatus', 'recoveryAvailable', 'reason', 'evidence', 'invalidationPoint', 'reviewIn', 'exitTrigger']);
    expect(Object.keys(VERDICT_SCHEMA.properties)).not.toContain('newsIgnored');
    expect(VERDICT_SCHEMA_N3).not.toBe(VERDICT_SCHEMA);
    expect(VERDICT_SCHEMA_N3.required).toEqual([...VERDICT_SCHEMA.required, 'newsIgnored']);
    expect(VERDICT_SCHEMA_N3.properties.newsIgnored).toBe(NEWS_IGNORED_SCHEMA);
  });
  it.each([
    [{ NEWS_EVENTS_V2_ENABLED: 'true', MARKET_CUES_ENABLED: 'true', NEWS_CONTEXT_V3: 'true' }, 'v9+n3', true],
    [{ NEWS_EVENTS_V2_ENABLED: 'true', NEWS_CONTEXT_V3: 'true' }, 'v2.6+n3', true],
    [{ NEWS_EVENTS_V2_ENABLED: 'true', MARKET_CUES_ENABLED: 'true', NEWS_CONTEXT_V3: 'observe' }, 'v9', false],
    [{ NEWS_EVENTS_V2_ENABLED: 'observe', MARKET_CUES_ENABLED: 'true', NEWS_CONTEXT_V3: 'true' }, 'v7', false],
    [{ NEWS_EVENTS_V2_ENABLED: 'true', MARKET_CUES_ENABLED: 'true', NEWS_CONTEXT_V3: 'ture' }, 'v9', false],
  ] as const)('the agent under %j stamps %s and sends the n3 schema only when n3', async (env, stamp, n3) => {
    const c = jest.fn().mockResolvedValue(reply(n3 ? { ...validVerdict, newsIgnored: [] } : validVerdict));
    const agent = new SentinelAgentService({ messages: { create: c } } as never, { get: (k: string) => (env as Record<string, string>)[k] } as never);
    await agent.judge(packet());
    expect(agent.promptVersion).toBe(`${stamp}/${THESIS_PROMPT_VERSION}`);
    expect(c.mock.calls[0][0].output_config.format.schema).toBe(n3 ? VERDICT_SCHEMA_N3 : VERDICT_SCHEMA);
  });
});
```

`sentinel-gateway.transport.spec.ts`: `expect(jobFor(req(VERDICT_SCHEMA_N3))).toBe('sentinel.judge')` and a structural copy of it → `'sentinel.unknown'`.

- [ ] **Step 3: Run** `cd apps/api && npx jest src/modules/trade-sentinel/services/sentinel-agent.service.spec.ts src/modules/ai-gateway/sentinel --ci --maxWorkers=2` → FAIL.

- [ ] **Step 4: Implement.** In `sentinel-system-prompt.ts` (extend the version-table doc comment: "FROM v9+n3 A FOURTH SWITCH, NEWS_CONTEXT_V3 (effective only with news on): a `+n3` SUFFIX on the news-on stamps instead of eight new rows (P8)"):

```ts
/** v3 reading lines: follow the v9 exit line when news context v3 renders. Ends with a newline. */
export const V3_NEWS_READING_LINES = [
  '- With news context on, each news.headlines item also carries "ref" (h1–h8, stable within this packet) and "why" (what ties the headline to this position: one of its names, a related company, or a known price driver).',
  '- Layer "driver" holds news about a known price driver of this position (for example crude supply for an oil marketer); for a commodity, news about its own price drivers is listed as instrument news. Weigh driver headlines below instrument headlines and above sector headlines.',
].join('\n') + '\n';
/** v3 answer rule: before the "reason" rule when news context v3 renders. Ends with a newline. */
export const V3_NEWS_IGNORED_RULE =
  '- "newsIgnored" lists at most 3 headlines, by ref, that are about a different company or event or would mislead about this position — not ones that are merely unimportant — each as {"ref", "kind" (irrelevant, misleading, wrong_company or wrong_market), "why" in a few words}; give [] when there are none. This field never changes your verdict.\n';
```

  In `renderPrompt`, with `const n3 = !!o.news && !!o.newsV3;`: (a) the news block becomes `${o.news ? `${V9_NEWS_READING_LINES}${o.triggers ? V9_NEWS_EXIT_LINE_TRIGGERS : V9_NEWS_EXIT_LINE}\n${n3 ? V3_NEWS_READING_LINES : ''}` : ''}`; (b) the answer rules end `${o.triggers ? EXIT_TRIGGER_RULES : ''}${n3 ? V3_NEWS_IGNORED_RULE : ''}- Keep "reason" …`. `renderPrompt`'s `Pick<…>` gains `'newsV3'`. `sentinelPromptVersion`: `const base = …; return o.news && o.newsV3 ? \`${base}+n3\` : base;`.

  In `sentinel-agent.service.ts`:

```ts
export const NEWS_IGNORED_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      ref: { type: 'string' },
      kind: { type: 'string', enum: ['irrelevant', 'misleading', 'wrong_company', 'wrong_market'] },
      why: { type: 'string' },
    },
    required: ['ref', 'kind', 'why'],
    additionalProperties: false,
  },
} as const;

/** News context v3 (spec §8): the live schema + REQUIRED newsIgnored. VERDICT_SCHEMA itself never changes (golden + jobFor key on its identity). */
export const VERDICT_SCHEMA_N3 = {
  ...VERDICT_SCHEMA,
  properties: { ...VERDICT_SCHEMA.properties, newsIgnored: NEWS_IGNORED_SCHEMA },
  required: [...VERDICT_SCHEMA.required, 'newsIgnored'],
} as const;
```

  `promptOptions` adds `newsV3: parseNewsContextConfig({ NEWS_EVENTS_V2_ENABLED: …, NEWS_CONTEXT_V3: this.config?.get<string>('NEWS_CONTEXT_V3') ?? undefined }).rendering`; `judge` sends `schema: (opts.newsV3 ? VERDICT_SCHEMA_N3 : VERDICT_SCHEMA) as unknown as Record<string, unknown>` (compute `opts` once per call). `news-attribution.ts`: `export function undoN3(p: string): string { return p.replace(V3_NEWS_READING_LINES, '').replace(V3_NEWS_IGNORED_RULE, ''); }`. `jobFor`: `if (schema === (VERDICT_SCHEMA as unknown) || schema === (VERDICT_SCHEMA_N3 as unknown)) return 'sentinel.judge';`.

- [ ] **Step 5: Verify** — the Step 3 command + `src/modules/trade-sentinel/golden` → PASS with the golden snapshot file UNCHANGED (`git diff --stat -- apps/api/src/modules/trade-sentinel/golden/__snapshots__` prints nothing). tsc → 174.

- [ ] **Step 6: Commit** — `feat(trade-sentinel): +n3 prompt lines and stamp suffix, VERDICT_SCHEMA_N3 (news context v3 §8)`.

### Task S2: `newsIgnored` parsing — advisory, never costs the verdict

> ⚠ NEVER delete directories anywhere in the repo (no `Remove-Item -Recurse`, `rm -rf`, `rmdir /s`, `git clean -fdx`) — worktrees hold node_modules junctions into the shared install. Run ONLY the targeted tests named in this task.

**Files:**
- Create: `trade-sentinel/services/news-ignored.ts` (+spec)
- Modify: `trade-sentinel/services/sentinel-agent.service.ts` (+spec)

**Interfaces:**
- Consumes: `NewsIgnoredItem`, `NEWS_IGNORED_MAX`, `NEWS_IGNORED_WHY_MAX`.
- Produces: `parseNewsIgnored(raw: Record<string, unknown>, refs: ReadonlySet<string>): { kind: 'absent' } | { kind: 'malformed'; problem: string } | { kind: 'ok'; items: NewsIgnoredItem[]; dropped: number }`; `Verdict.newsIgnored?: NewsIgnoredItem[]` (set ONLY under n3); `SentinelAgentService.newsIgnoredMalformed: number` (counter).

- [ ] **Step 1: Write the failing tests** `news-ignored.spec.ts`:

```ts
import { parseNewsIgnored } from './news-ignored';
const refs = new Set(['h1', 'h2', 'h3', 'h4']);

it.each([
  [{}, { kind: 'absent' }],
  [{ newsIgnored: 'h1' }, { kind: 'malformed', problem: expect.stringMatching(/not an array/) }],
  [{ newsIgnored: null }, { kind: 'malformed', problem: expect.stringMatching(/not an array/) }],
  [{ newsIgnored: [] }, { kind: 'ok', items: [], dropped: 0 }],
  [{ newsIgnored: [{ ref: 'h1', kind: 'irrelevant', why: 'about Shah the analyst' }] },
    { kind: 'ok', items: [{ ref: 'h1', kind: 'irrelevant', why: 'about Shah the analyst' }], dropped: 0 }],
  [{ newsIgnored: [{ ref: 'h9', kind: 'irrelevant', why: 'x' }, { ref: 'h2', kind: 'nonsense', why: 'x' }, { ref: 'h3', kind: 'misleading' }, 7] },
    { kind: 'ok', items: [], dropped: 4 }],
])('%j', (raw, want) => expect(parseNewsIgnored(raw as never, refs)).toEqual(want));

it('max 3 items (P12): extras are dropped and counted; duplicates by ref collapse', () => {
  const four = ['h1', 'h2', 'h3', 'h4'].map((ref) => ({ ref, kind: 'irrelevant', why: 'x' }));
  expect(parseNewsIgnored({ newsIgnored: [...four, four[0]] }, refs)).toMatchObject({ kind: 'ok', dropped: 2 });
  expect((parseNewsIgnored({ newsIgnored: four }, refs) as { items: unknown[] }).items).toHaveLength(3);
});
it('why is trimmed and capped at 120 chars', () => {
  const r = parseNewsIgnored({ newsIgnored: [{ ref: 'h1', kind: 'misleading', why: `  ${'w'.repeat(200)}  ` }] }, refs) as { items: Array<{ why: string }> };
  expect(r.items[0].why).toHaveLength(120);
});
```

`sentinel-agent.service.spec.ts` (Review Focus 4):

```ts
it.each([
  ['missing', { ...validVerdict }],
  ['a string', { ...validVerdict, newsIgnored: 'h1' }],
  ['seven items with an unknown ref', { ...validVerdict, newsIgnored: Array.from({ length: 7 }, (_, i) => ({ ref: `h${i + 3}`, kind: 'irrelevant', why: 'x' })) }],
])('n3: a %s newsIgnored never costs the verdict', async (_, body) => {
  const env = { NEWS_EVENTS_V2_ENABLED: 'true', NEWS_CONTEXT_V3: 'true' };
  const c = jest.fn().mockResolvedValue(reply(body));
  const agent = new SentinelAgentService({ messages: { create: c } } as never, { get: (k: string) => (env as Record<string, string>)[k] } as never);
  const v = await agent.judge(packetWithRefs(['h1', 'h2']));   // headlines value items carry ref h1, h2
  expect(v.verdict).toBe('HOLD');
  expect(v.newsIgnored).toEqual([]);
});
it('n3 off: no newsIgnored key is added to the verdict (golden results unchanged)', async () => {
  const c = jest.fn().mockResolvedValue(reply(validVerdict));
  const v = await new SentinelAgentService({ messages: { create: c } } as never).judge(packet());
  expect('newsIgnored' in v).toBe(false);
});
```

(`packetWithRefs(refs)` = `packet()` with `news.headlines = present(refs.map((ref) => ({ ref, title: 't', why: 'name: X', layer: 'instrument' })), 'news', AT)`.)

- [ ] **Step 2: Run** `cd apps/api && npx jest src/modules/trade-sentinel/services/news-ignored.spec.ts src/modules/trade-sentinel/services/sentinel-agent.service.spec.ts --ci --maxWorkers=2` → FAIL.

- [ ] **Step 3: Implement.** `news-ignored.ts` — pure; items must be objects with `ref ∈ refs`, `kind` in the four values, non-empty string `why`; first occurrence per ref wins; cap `NEWS_IGNORED_MAX`. In `validate(raw, packet)` (only when this call is n3 — pass the flag in): `refs` = the `ref`s of `packet.news.headlines.value` when available; `absent`/`malformed` ⇒ `v.newsIgnored = []`, `this.newsIgnoredMalformed++`, warn `sentinel agent: newsIgnored ignored (<problem>) — verdict kept`; `ok` ⇒ `v.newsIgnored = items` (+ debug line when `dropped > 0`). No other check moves; the field is never consulted by any rule in `validate`.

- [ ] **Step 4: Verify** — same command → PASS; `src/modules/trade-sentinel/golden` unchanged. tsc → 174.

- [ ] **Step 5: Commit** — `feat(trade-sentinel): advisory newsIgnored parsing — malformed is [] and counted, never a rejection (§7.1, P12)`.

### Task S3: Ladder v3, `peekV3`, v3 news blocks with ref/why

> ⚠ NEVER delete directories anywhere in the repo (no `Remove-Item -Recurse`, `rm -rf`, `rmdir /s`, `git clean -fdx`) — worktrees hold node_modules junctions into the shared install. Run ONLY the targeted tests named in this task.

**Files:**
- Create: `news-events/index/ladder-v3.ts` (+spec), `trade-sentinel/services/news-blocks-v3.ts` (+spec)
- Modify: `news-events/index/news-index.service.ts` (+spec) (`peekV3`; factor `asOfFor(p, now)` out of `peek` without changing `peek`'s output), `trade-sentinel/ports/news-index.port.ts`

**Interfaces:**
- Consumes: `ladderFor`, `instrumentKeysOf`, `V3_LAYER_CAPS`, `V3_MAX_HEADLINES`, `WHY_MAX`, `NEWS_WINDOW_MS`, `FRESH_WINDOW_MS`, `PositionMatch`, `PositionMatchesPeek`, `NewsPeekV3`, `LayeredHeadlineV3`, `NewsIndex.get` (F2).
- Produces:

```ts
// ladder-v3.ts (pure)
export function layeredHeadlinesV3(
  ix: { list(key: string, sinceMs: number): readonly IndexedArticle[]; get(id: string): IndexedArticle | undefined },
  p: NewsPosition, sectors: SectorLookup, matches: readonly PositionMatch[], now: number,
): { headlines: LayeredHeadlineV3[]; refs: Record<string, string>; newestAt: string | null; dropped: Array<{ articleId: string; key: string }> };
export function freshV3(ix: { get(id: string): IndexedArticle | undefined }, matches: readonly PositionMatch[], now: number): { count: number; fresh: FreshItem[] };
// NewsIndexService
peekV3(p: NewsPosition, matches: PositionMatchesPeek, now: Date): NewsPeekV3;
// news-blocks-v3.ts (pure)
export const NEWS_V3_SOURCE: string; export const FRESH_V3_SOURCE: string;
export interface NewsV3Side { refs: Record<string, string>; dropped: Array<{ articleId: string; key: string }> }
export function newsBlocksV3(peek: NewsPeekV3 | null, at: string): { news: NewsBlocksV2; side: NewsV3Side };
export function attachNewsV3Side(packet: object, side: NewsV3Side): void;     // module-level WeakMap
export function newsV3SideOf(packet: object): NewsV3Side | undefined;
export function newsRefsOf(packet: object): Record<string, string> | undefined;
export function shadowSummaryV3(news: NewsBlocksV2, side: NewsV3Side): string;
```

- [ ] **Step 1: Write the failing tests** `ladder-v3.spec.ts` (build a real `NewsIndex` + `article()`):

```ts
it('own → driver → sector → index → market; refs h1… in output order; why on every headline', () => {
  // INFY STOCK, sector NIFTY IT. Index holds: a1 (I:INFY, matched own), a2 (D:INR_USD, matched driver), a3 (S:NIFTY IT), a4 (X:NIFTY), a5 (M:IN).
  const r = layeredHeadlinesV3(ix, INFY, sectors, [match({ articleId: 'a1', why: 'name: Infosys' }), match({ articleId: 'a2', layer: 'driver', via: 'driver', wakes: false, why: 'driver: INR_USD → revenue in USD' })], NOW);
  expect(r.headlines.map((h) => [h.ref, h.layer, h.why])).toEqual([
    ['h1', 'instrument', 'name: Infosys'], ['h2', 'driver', 'driver: INR_USD → revenue in USD'],
    ['h3', 'sector', 'sector: NIFTY IT'], ['h4', 'index', 'index: NIFTY'], ['h5', 'market', 'market: IN'],
  ]);
  expect(r.refs).toEqual({ h1: 'a1', h2: 'a2', h3: 'a3', h4: 'a4', h5: 'a5' });
});
it('P2: a v2 own-instrument article the profile did not confirm is dropped from EVERY rung and reported', () => {
  // a6 tagged I:INFY + S:NIFTY IT, no match ⇒ not in headlines, in dropped
  const r = layeredHeadlinesV3(ix, INFY, sectors, [], NOW);
  expect(r.headlines.some((h) => r.refs[h.ref] === 'a6')).toBe(false);
  expect(r.dropped).toEqual([{ articleId: 'a6', key: 'I:INFY' }]);
});
it('ceilings 8/2/3/2/2 and total 8; the 6 h window applies to matches too', () => {});
it('COMMODITY: own drivers sit in the instrument rung; there is no separate driver rung entry', () => {});
it('a match whose article left the index is skipped (no ref, no throw)', () => {});
it('freshV3: wakes-only, 30 min, inferred publish times excluded', () => {});
```

`news-blocks-v3.spec.ts`:

```ts
it('ok ⇒ headlines carry ref and why; freshCount and asOf as v2; side carries refs and dropped', () => {});
it('warming matches ⇒ every news block absent with the "cannot see" reason — never "no headlines" (Review Focus 2)', () => {
  const { news } = newsBlocksV3({ status: 'warming', reason: 'the position profile for INFY is still loading — this is a failure to look, NOT a finding that nothing was published' }, AT);
  expect(news.headlines).toEqual({ available: false, reason: expect.stringMatching(/NOT a finding/) });
  expect(news.freshCount.available).toBe(false);
});
it('the side map is reachable only through the WeakMap — JSON.stringify(packet) never contains an article id', () => {
  const packet = { news: {} };
  attachNewsV3Side(packet, { refs: { h1: 'cuid123' }, dropped: [] });
  expect(newsRefsOf(packet)).toEqual({ h1: 'cuid123' });
  expect(JSON.stringify(packet)).not.toContain('cuid123');
});
```

`news-index.service.spec.ts`: `peekV3` is synchronous, does no Prisma call (spy), mirrors `peek`'s `off/warming/failed` states, passes a matcher `warming`/`unavailable` through as its own status, and `peek`'s output is byte-identical to before (`sha` of a fixed peek).

- [ ] **Step 2: Run** `cd apps/api && npx jest src/modules/news-events/index src/modules/trade-sentinel/services/news-blocks-v3.spec.ts --ci --maxWorkers=2` → FAIL.

- [ ] **Step 3: Implement** per ruling K4. Instrument rung = matches with `layer ∈ {own, related}` (COMMODITY: every match is `own`/`related` by construction) whose article is in the index and in the window, newest first; driver rung = `layer === 'driver'`; then mark every unclaimed article on `instrumentKeysOf(p)` keys within the window as claimed + dropped; then the v2 `ladderFor(p, sectors)` rungs except `instrument`, skipping claimed. `why` truncated to `WHY_MAX`. `key` = `p.key` for instrument/driver rungs, the rung key without prefix otherwise. `NEWS_V3_SOURCE = 'news-index + position profile (own → driver → sector → index → market, published within 6h)'`; `FRESH_V3_SOURCE = 'position profile (own headlines in the last 30 minutes; inferred publish times excluded)'`. Port: add the optional `peekV3?` to `NewsIndexReader` with a doc line ("absent ⇒ v3 unavailable; synchronous, no I/O").

- [ ] **Step 4: Verify** — same command + `src/modules/trade-sentinel/services/context-packet.news-events.spec.ts src/modules/news-events/news-events.structure.spec.ts` → PASS. tsc → 174.

- [ ] **Step 5: Commit** — `feat(news-events): v3 ladder (own → driver → sector → index → market) with ref/why and dropped v2 tags (§4.5)`.

### Task S4: Packet, shadow, cycle, wake and tick source on v3

> ⚠ NEVER delete directories anywhere in the repo (no `Remove-Item -Recurse`, `rm -rf`, `rmdir /s`, `git clean -fdx`) — worktrees hold node_modules junctions into the shared install. Run ONLY the targeted tests named in this task.

**Files:**
- Create: `trade-sentinel/services/context-packet.news-v3.spec.ts`
- Modify: `trade-sentinel/services/context-packet.service.ts`, `trade-sentinel/services/news-watch-book.ts` (+spec), `trade-sentinel/services/news-wake.service.ts` (+spec), `trade-sentinel/adapters/tick-source.adapter.ts` (+spec), `trade-sentinel/services/sentinel-cycle.service.ts` (+spec)

**Interfaces:**
- Consumes: `NEWS_CONTEXT_CONFIG`/`NewsContextConfig`, `POSITION_NEWS`/`PositionNewsReader`, `NEWS_FEEDBACK`/`NewsFeedbackSink`/`JudgeFeedback`, `positionKeyOf`, S3's blocks and side map, `Verdict.newsIgnored` (S2).
- Produces: `ContextPacketService` constructor gains two trailing `@Optional()` params (`NEWS_CONTEXT_CONFIG`, `POSITION_NEWS`); `shadowNewsEvents(entry, tick, now, packet?)`; `NewsWatch.position?: NewsPosition`, `NewsWatch.positionKey?: string`; `NewsWatchBook.positions(): NewsPosition[]`, `NewsWatchBook.matchingPositionKeys(keys: Iterable<string>): NewsWatch[]`; `SentinelCycleService`, `NewsWakeService`, `SentinelTickSource` gain `@Optional()` `NEWS_CONTEXT_CONFIG` + `POSITION_NEWS` (+ cycle: `NEWS_FEEDBACK`).

- [ ] **Step 1: Record the v2-`true` packet hashes on the Foundation tip (before ANY edit).** In a scratch spec run once, build each of the four `FIXTURES` of `context-packet.news-events.spec.ts` with `make('true')` (OK_NEWS / OK_EVENTS) and print `sha(packet)`; paste them as `V2_TRUE_PACKET_SHA256` (comment "feature/news-context-v3 @ <sha>, news-context Task S4 Step 1, never re-recorded") at the top of the new `context-packet.news-v3.spec.ts`. Delete the scratch spec file (single file, `git rm` not needed — it was never added).

- [ ] **Step 2: Write the failing tests** `context-packet.news-v3.spec.ts`:

```ts
import { parseNewsContextConfig } from '../../news-events/news-context-config';
import { fakePositionNews, match } from '../../news-events/testing-v3';
import { newsRefsOf, newsV3SideOf } from './news-blocks-v3';
// FIXTURES, legacyRecentFor, sha, OK_NEWS/OK_EVENTS re-used from context-packet.news-events.spec (export them there if needed)

const makeV3 = (v3: string | undefined, peekV3 = jest.fn(() => OK_V3), positions = fakePositionNews({ 'STOCK:INFY': { status: 'ok', profileVersion: 2, builtBy: 'llm', matches: [match({ articleId: 'a1' })] } })) => {
  const index = { ...fakeNewsIndex(() => OK_NEWS), peekV3 };
  const svc = new ContextPacketService(
    { recentForTracker: jest.fn().mockResolvedValue([]) } as never, { levelsFor: jest.fn().mockResolvedValue(null) } as never, { recentFor: legacyRecentFor() } as never,
    undefined, parseNewsEventsConfig({ NEWS_EVENTS_V2_ENABLED: 'true' }), index as never, fakeEvents(() => OK_EVENTS) as never,
    v3 === undefined ? undefined : parseNewsContextConfig({ NEWS_EVENTS_V2_ENABLED: 'true', NEWS_CONTEXT_V3: v3 }), positions as never,
  );
  return { svc, peekV3, positions };
};

it.each([undefined, 'false', 'observe', 'ture'])('NEWS_CONTEXT_V3=%s builds exactly the v2-true packet and never peeks v3 in build (Review Focus 1)', async (v3) => {
  for (const [name, e, t] of FIXTURES) {
    const m = makeV3(v3);
    expect(sha(await m.svc.build(e as never, t, null))).toBe(V2_TRUE_PACKET_SHA256[name]);
    expect(m.peekV3).not.toHaveBeenCalled();
    expect(m.positions.peek).not.toHaveBeenCalled();
  }
});

it('true: headlines carry ref/why, events are the v2 events, the side map holds refs, no article id is serialised', async () => {
  const { svc } = makeV3('true');
  const pkt = await svc.build(FIXTURES[0][1] as never, FIXTURES[0][2], null);
  const h = (pkt.news.headlines as { value: Array<{ ref: string; why: string }> }).value;
  expect(h[0]).toMatchObject({ ref: 'h1', why: 'name: Infosys' });
  expect(pkt.events).toEqual(/* the v2 events block for OK_EVENTS */ expect.objectContaining({ upcoming: expect.objectContaining({ available: true }) }));
  expect(newsRefsOf(pkt)).toEqual({ h1: 'a1' });
  expect(JSON.stringify(pkt)).not.toContain('"a1"');
});

it('true + matcher warming ⇒ headlines absent with "failure to look" (never unconfirmed v2 tags)', async () => {});
it('true: the packet path is synchronous for news — no promise-returning call on the index or matcher', async () => {});
it('shadow: v2 observe + v3 false ⇒ exactly today\'s {news, events}; v3 observe ⇒ + v3 {news, refs, dropped}; v2 true + v3 observe ⇒ {v3} only; v3 true ⇒ {v3: {refs, dropped}} from the packet', async () => {});
```

`news-watch-book.spec.ts`: `positions()` returns one `NewsPosition` per distinct `positionKey`; `matchingPositionKeys` selects by key; `prune` removes them.
`news-wake.service.spec.ts`: v3 `true` ⇒ only `wakeHits(a)` positions wake (a related-only or driver-only article for a STOCK does not wake; a commodity primary-driver article does — P3); v3 `observe`/off ⇒ the v2 path exactly as today (existing tests unchanged) plus one `[news-wake] v3 observe: would wake …` line only when the v3 decision differs.
`tick-source.adapter.spec.ts`: v3 `true` ⇒ `freshNews`/`freshNewsCount` come from `peekV3(...).fresh/freshCount`; otherwise unchanged.
`sentinel-cycle.service.spec.ts`: (1) v3 computing ⇒ `positionNews.setWatched` receives the watched positions after each pass's upserts/prunes (and is never called when off); (2) v3 true + a verdict with `newsIgnored: [{ ref: 'h1', kind: 'wrong_company', why: 'analyst Shah' }, { ref: 'h7', … }]` ⇒ `recordJudge` gets ONE row `{ articleId: 'a1', tag: 'I:INFY', symbol: 'INFY', kind: 'wrong_company', reason: 'analyst Shah', verdictId: <row id>, trackerId }` (h7 not in the packet ⇒ no row), called AFTER the verdict write, and a throwing sink does not fail the cycle; (3) v3 off ⇒ `recordJudge` never called; (4) the reachability walk (`ENTRIES`/`FORBIDDEN`) stays green.

- [ ] **Step 3: Run** `cd apps/api && npx jest src/modules/trade-sentinel/services/context-packet.news-v3.spec.ts src/modules/trade-sentinel/services/news-watch-book.spec.ts src/modules/trade-sentinel/services/news-wake.service.spec.ts src/modules/trade-sentinel/adapters/tick-source.adapter.spec.ts src/modules/trade-sentinel/services/sentinel-cycle.service.spec.ts --ci --maxWorkers=2` → FAIL.

- [ ] **Step 4: Implement.**
  - `context-packet.service.ts`: new private `v3News(entry, tick, now, at)` → resolves `pos` exactly like `v2Blocks`; unresolved ⇒ `allNewsAbsent(pos.unresolved)`; `matches = this.positionNews?.peek(pos, now) ?? { status: 'unavailable', reason: 'the position matcher is not wired into this process' }`; `newsBlocksV3(this.newsIndex?.peekV3?.(pos, matches, now) ?? null, at)` (wrapped in the same `read()` try/catch). In `build`: `const v3 = v2 && this.ctxCfg?.rendering === true;` — when `v3`, the packet's `news` is the v3 blocks (events still from `v2b`), and after constructing the literal `attachNewsV3Side(packet, side)`; return the same object. `shadowNewsEvents(entry, tick, now, packet?)` per "differs" 15 — key order `news, events, v3`; returns `null` in every combination that returns `null` today.
  - `news-watch-book.ts`: `NewsWatch` gains optional `position`/`positionKey`; `positions()`; `matchingPositionKeys()`.
  - `sentinel-cycle.service.ts`: at the existing `newsWatch.upsert` add `position: p, positionKey: positionKeyOf(p)`; after the pass's upserts and after `prune` call `this.syncWatched()` (`if (this.ctxCfg?.computing && this.positionNews && this.newsWatch) this.positionNews.setWatched(this.newsWatch.positions())`, try/catch); in `judgeAndRecord` pass `packet` to `newsShadowFor` and capture `const row = await this.verdicts.record(…)`; then, only when `this.ctxCfg?.rendering`, `this.recordNewsIgnored(entry, packet, verdict, row?.id ?? null)` — maps refs through `newsRefsOf(packet)` and the packet headline's `layer/key` to a tag (`instrument` → `I:`/`X:` by position kind, `driver` → `D:`+driver from `why`, else `S:`/`X:`/`M:`), builds `JudgeFeedback` rows, calls `this.newsFeedback?.recordJudge(rows)` inside try/catch, never awaited.
  - `news-wake.service.ts`: under `ctxCfg?.rendering && positionNews` use `book.matchingPositionKeys(positionNews.wakeHits(a))`; otherwise today's code path.
  - `tick-source.adapter.ts::freshFromIndex`: under v3 rendering with `positionNews` and `newsIndex.peekV3`, use `peekV3(pos, positionNews.peek(pos, now), now)`.

- [ ] **Step 5: Verify** — the Step 3 command + `src/modules/trade-sentinel/services/context-packet.news-events.spec.ts src/modules/trade-sentinel/services/context-packet.service.spec.ts src/modules/trade-sentinel/trade-sentinel.module.spec.ts` → PASS. tsc → 174.

- [ ] **Step 6: Commit** — `feat(trade-sentinel): render v3 news (own → driver → …), v3 shadow, matcher watch sync, judge newsIgnored → feedback (§4.5/§7.1)`.

### Task S5: Golden scenarios for `+n3` (added, never rewritten)

> ⚠ NEVER delete directories anywhere in the repo (no `Remove-Item -Recurse`, `rm -rf`, `rmdir /s`, `git clean -fdx`) — worktrees hold node_modules junctions into the shared install. Run ONLY the targeted tests named in this task.

**Files:**
- Modify: `trade-sentinel/golden/golden-fixtures.ts`, `trade-sentinel/golden/sentinel-golden.spec.ts`, `trade-sentinel/golden/__snapshots__/sentinel-golden.spec.ts.snap` (ADDITIONS only)

**Interfaces:**
- Consumes: `undoN3`, `VERDICT_SCHEMA_N3`, `GOLDEN_PACKET_NEWS_DISCIPLINE`.
- Produces: `GOLDEN_PACKET_NEWS_V3_DISCIPLINE` (the news-discipline packet whose headlines carry `ref`/`why` and one `driver` item); scenarios `judge-fire-cues-on-news-discipline-n3`, `judge-heartbeat-cues-off-news-discipline-n3`, `judge-heartbeat-cues-off-news-discipline-n3-observe`.

- [ ] **Step 1: Write the failing tests** — add the three names to `SCENARIO_NAMES` and their runners (env `NEWS_EVENTS_V2_ENABLED=true`, `NEWS_CONTEXT_V3=true|observe`, discipline on, cues on/off; reply `{ ...VALID_VERDICT, newsIgnored: [{ ref: 'h2', kind: 'irrelevant', why: 'about a namesake' }] }` for the two `n3` ones and `VALID_VERDICT` for observe). In `sentinel-golden.spec.ts` add:

```ts
describe('news context v3 — every n3 scenario is attributable to the v3 edits alone', () => {
  it('n3 request = its news twin with the three v3 lines, the N3 schema and the v3 headlines — nothing else', async () => {
    const n3 = recordOf('judge-fire-cues-on-news-discipline-n3').request as TransportRequest;
    const twin = recordOf('judge-fire-cues-on-news-discipline').request as TransportRequest;
    expect(undoN3(n3.system[0].text)).toBe(twin.system[0].text);
    expect(n3.output_config.format.schema).toBe(VERDICT_SCHEMA_N3);
    const { news: n3News, ...n3Rest } = JSON.parse(n3.messages[0].content);
    const { news: twinNews, ...twinRest } = JSON.parse(twin.messages[0].content);
    expect(n3Rest).toEqual(twinRest);
    expect(n3News.asOf).toEqual(twinNews.asOf);
  });
  it('n3 observe is exactly news-on v2: same request, result and logs as judge-heartbeat-cues-off-news-discipline', () => {
    const a = recordOf('judge-heartbeat-cues-off-news-discipline-n3-observe');
    const b = recordOf('judge-heartbeat-cues-off-news-discipline');
    expect({ ...a, scenario: '' }).toEqual({ ...b, scenario: '' });
  });
});
```

- [ ] **Step 2: Run** `cd apps/api && npx jest src/modules/trade-sentinel/golden --ci --maxWorkers=2` → FAIL ("new snapshot not written in CI" for the three scenarios + the missing names).

- [ ] **Step 3: Write the new snapshots ONCE, then prove nothing old moved.**

```bash
cd apps/api && npx jest src/modules/trade-sentinel/golden --ci=false --maxWorkers=2
git diff -U0 -- src/modules/trade-sentinel/golden/__snapshots__/sentinel-golden.spec.ts.snap | grep -E '^-[^-]' ; echo "removed-lines-check-done"
```

The `grep` must print NOTHING before `removed-lines-check-done` (only `+` lines may appear). If any existing snapshot line changed, revert the snapshot file (`git checkout -- <snap>`), find the behaviour change, and fix the code — never accept a modified old snapshot.

- [ ] **Step 4: Verify** — `npx jest src/modules/trade-sentinel --ci --maxWorkers=2` (this module only) → PASS. tsc → 174.

- [ ] **Step 5: Commit** — `test(trade-sentinel): golden n3 scenarios (added), n3-observe equals v2 news-on`.

---

## Stream N — night jobs, feedback, statistics, audit, curator (worktree `nctx-n`, branch `feature/nctx-n`)

Goal: spec §7, §9, §11. New module `night-jobs/` plus `news-events/{feedback,audit,curator}/`. N codes against `RuleSetAdmin`, `CandidateTagger`, `CandidateRelevance`, `RetagRunner`, `IndexRebuilder`, `MatcherRebuilder`, `ProfilePrebuilder` (all `@Optional()` by token; fakes in tests) and E1's `evaluate()` signature (stub it locally in N7's spec until I1 — see N7).

### Task N1: `callWithMeta` and the bounded, breakered `NewsLlmClient`

> ⚠ NEVER delete directories anywhere in the repo (no `Remove-Item -Recurse`, `rm -rf`, `rmdir /s`, `git clean -fdx`) — worktrees hold node_modules junctions into the shared install. Run ONLY the targeted tests named in this task.

**Files:**
- Create: `night-jobs/news-llm.client.ts` (+spec), `night-jobs/news-llm.module.ts`
- Modify: `ai-gateway/ai-gateway.service.ts` (+spec)

**Interfaces:**
- Consumes: `AiGatewayService`, `NewsContextConfig`, `NewsLlm*` types, `SessionClock` (`market-hub/session-clock`) + `MARKET_HOLIDAYS`.
- Produces: `AiGatewayService.callWithMeta(job, request, ctx?): Promise<{ message: TransportMessage; meta: CallMeta }>`; `NewsLlmClient implements NewsLlm` with constructor `(deps: { gateway: Pick<AiGatewayService, 'callWithMeta'>; cfg: NewsContextConfig; now?: () => Date; sessionOpen?: (now: Date) => boolean; log?: (line: string) => void })`; `NewsLlmModule` providing `NEWS_LLM`.

- [ ] **Step 1: Write the failing tests.** `ai-gateway.service.spec.ts` — add:

```ts
it('callWithMeta: same routing, budget and audit as call; returns the provider message BY REFERENCE plus its meta', async () => {
  const message = { content: [{ type: 'text', text: '{}' }], stop_reason: 'end_turn' };
  const meta = { inputTokens: 1200, outputTokens: 80, cacheCreationInputTokens: null, cacheReadInputTokens: null, billed: false };
  const adapter = { name: 'claude-cli' as const, send: jest.fn().mockResolvedValue({ message, meta }) };
  const gw = gateway({ 'claude-cli': adapter });            // existing helper in this spec
  const r = await gw.callWithMeta('news.audit', request());
  expect(r.message).toBe(message);
  expect(r.meta).toEqual(meta);
  expect(await gw.call('news.audit', request())).toBe(message);   // call unchanged
});
```

`news-llm.client.spec.ts`:

```ts
import { NewsLlmClient } from './news-llm.client';
import { parseNewsContextConfig } from '../news-events/news-context-config';

const cfg = parseNewsContextConfig({ NEWS_EVENTS_V2_ENABLED: 'observe', NEWS_CONTEXT_V3: 'observe', NEWS_LLM_NIGHT_MAX_CALLS: '3', NEWS_LLM_NIGHT_MAX_INPUT_TOKENS: '10000', NEWS_PROFILE_MAX_BUILDS_PER_DAY: '1' });
const night = new Date('2026-10-16T19:30:00Z');                       // 01:00 IST Sat
const ok = (json: unknown, tin = 1000) => ({ message: { content: [{ type: 'text', text: JSON.stringify(json) }], stop_reason: 'end_turn' }, meta: { inputTokens: tin, outputTokens: 50, cacheCreationInputTokens: null, cacheReadInputTokens: null, billed: false } });
const req = (o = {}) => ({ job: 'news.audit' as const, scope: 'night' as const, system: 's', user: 'u'.repeat(350), schema: { type: 'object' }, maxOutputTokens: 500, ...o });
const make = (send: jest.Mock, extra = {}) => new NewsLlmClient({ gateway: { callWithMeta: send }, cfg, now: () => night, sessionOpen: () => false, ...extra });

it('ok: parses the JSON, records usage (actual tokens when reported)', async () => {
  const c = make(jest.fn().mockResolvedValue(ok({ labels: [] }, 1500)));
  await expect(c.call(req())).resolves.toEqual({ ok: true, json: { labels: [] }, tokensIn: 1500, tokensOut: 50 });
  expect(c.usage('night')).toMatchObject({ calls: 1, tokensIn: 1500, tokensOut: 50 });
});
it('cap-calls: the 4th night call makes no gateway call', async () => {
  const send = jest.fn().mockResolvedValue(ok({}));
  const c = make(send);
  for (let i = 0; i < 3; i++) await c.call(req());
  await expect(c.call(req())).resolves.toMatchObject({ ok: false, reason: 'cap-calls' });
  expect(send).toHaveBeenCalledTimes(3);
});
it('cap-tokens: the estimate (chars / 3.5) is checked BEFORE the call', async () => {
  const send = jest.fn().mockResolvedValue(ok({}, 9000));
  const c = make(send);
  await c.call(req());
  await expect(c.call(req({ user: 'x'.repeat(7000) }))).resolves.toMatchObject({ ok: false, reason: 'cap-tokens' });
  expect(send).toHaveBeenCalledTimes(1);
});
it('breaker (Review Focus 5): a 429 / usage-limit reply stops EVERY news.* job until the reset; no retry', async () => {
  const send = jest.fn().mockRejectedValue(new Error('claude CLI: the call failed (status 429): usage limit reached, resets at 2026-10-17T05:00:00Z'));
  const log = jest.fn();
  const c = make(send, { log });
  await expect(c.call(req())).resolves.toMatchObject({ ok: false, reason: 'error' });
  expect(c.breakerOpenUntil()?.toISOString()).toBe('2026-10-17T05:00:00.000Z');
  await expect(c.call(req({ job: 'news.profile', scope: 'intraday' }))).resolves.toMatchObject({ ok: false, reason: 'breaker-open' });
  expect(send).toHaveBeenCalledTimes(1);
  expect(log).toHaveBeenCalledWith(expect.stringMatching(/^\[news-llm\] breaker OPEN until 2026-10-17T05:00:00\.000Z/));
});
it('breaker without a parseable reset opens for 5 h', async () => {});
it('a non-limit error does not open the breaker', async () => {});
it('night scope refuses while any session is open (session-open); intraday profile builds are allowed', async () => {
  const c = make(jest.fn().mockResolvedValue(ok({})), { sessionOpen: () => true });
  await expect(c.call(req())).resolves.toMatchObject({ ok: false, reason: 'session-open' });
  await expect(c.call(req({ job: 'news.profile', scope: 'intraday' }))).resolves.toMatchObject({ ok: true });
});
it('intraday cap counts news.profile per IST day; the counter can be seeded', async () => {});
it('unparseable / refusal / max_tokens ⇒ ok:false, never throws', async () => {});
it('night counters roll over at the next night (keyed by nightOf)', async () => {});
```

- [ ] **Step 2: Run** `cd apps/api && npx jest src/modules/night-jobs/news-llm.client.spec.ts src/modules/ai-gateway/ai-gateway.service.spec.ts --ci --maxWorkers=2` → FAIL.

- [ ] **Step 3: Implement.**
  - `ai-gateway.service.ts`: move the body of `call` into `private async run(job, request, ctx): Promise<ProviderResult>` returning `result` where `call` returned `result.message`; `call = async (...) => (await this.run(...)).message`; `callWithMeta = async (...) => { const r = await this.run(...); return { message: r.message, meta: r.meta }; }`. No other line moves (the golden gateway suite proves it in I1).
  - `news-llm.client.ts`:

```ts
const LIMIT_RE = /\b429\b|rate.?limit|usage limit|limit (?:reached|exceeded)|quota|too many requests/i;
const RESET_RE = /resets?\s+(?:at\s+)?(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/i;
const DEFAULT_BREAKER_MS = 5 * 3_600_000;
export const nightOfFor = (now: Date): string => new Date(now.getTime() + 19_800_000 - 12 * 3_600_000).toISOString().slice(0, 10);
export const istDay = (now: Date): string => new Date(now.getTime() + 19_800_000).toISOString().slice(0, 10);
export const estimateTokens = (s: string): number => Math.ceil(s.length / 3.5);

export class NewsLlmClient implements NewsLlm {
  private open: Date | null = null;
  private night = { key: '', calls: 0, tokensIn: 0, tokensOut: 0 };
  private intraday = { day: '', builds: 0 };
  constructor(private readonly d: { gateway: { callWithMeta: AiGatewayService['callWithMeta'] }; cfg: NewsContextConfig;
    now?: () => Date; sessionOpen?: (now: Date) => boolean; log?: (line: string) => void }) {}
  seedIntraday(builds: number, now = this.now()): void { this.intraday = { day: istDay(now), builds }; }
  breakerOpenUntil(): Date | null { return this.open && this.open > this.now() ? this.open : null; }
  usage(scope: NewsLlmScope): NightBudgetSnapshot { /* night counters, or { calls: intraday.builds, … } */ }
  async call(req: NewsLlmRequest): Promise<NewsLlmResult> {
    const now = this.now();
    const until = this.breakerOpenUntil();
    if (until) return { ok: false, reason: 'breaker-open', detail: `news.* paused until ${until.toISOString()}` };
    const est = estimateTokens(req.system + req.user);
    if (req.scope === 'night') {
      this.rollNight(now);
      if (this.d.sessionOpen?.(now)) return { ok: false, reason: 'session-open', detail: 'a market session is open' };
      if (this.night.calls >= this.d.cfg.nightMaxCalls) return { ok: false, reason: 'cap-calls', detail: `${this.night.calls}/${this.d.cfg.nightMaxCalls} calls tonight` };
      if (this.night.tokensIn + est > this.d.cfg.nightMaxInputTokens) return { ok: false, reason: 'cap-tokens', detail: `${this.night.tokensIn}+${est} > ${this.d.cfg.nightMaxInputTokens}` };
      this.night.calls++;
    } else {
      this.rollDay(now);
      if (req.job === 'news.profile' && this.intraday.builds >= this.d.cfg.profileMaxBuildsPerDay) return { ok: false, reason: 'cap-intraday', detail: `${this.intraday.builds}/${this.d.cfg.profileMaxBuildsPerDay} builds today` };
      if (req.job === 'news.profile') this.intraday.builds++;
    }
    try {
      const { message, meta } = await this.d.gateway.callWithMeta(req.job, {
        model: 'claude-sonnet-5', max_tokens: req.maxOutputTokens,
        output_config: { effort: 'medium', format: { type: 'json_schema', schema: req.schema } },
        system: [{ type: 'text', text: req.system }], messages: [{ role: 'user', content: req.user }],
      });
      const tin = meta.inputTokens ?? est;
      if (req.scope === 'night') { this.night.tokensIn += tin; this.night.tokensOut += meta.outputTokens ?? 0; }
      if (message.stop_reason === 'refusal' || message.stop_reason === 'max_tokens') return { ok: false, reason: 'error', detail: `stop_reason ${message.stop_reason}` };
      const text = message.content.find((b) => b.type === 'text')?.text ?? '';
      try { return { ok: true, json: JSON.parse(text), tokensIn: meta.inputTokens, tokensOut: meta.outputTokens }; }
      catch { return { ok: false, reason: 'unparseable', detail: text.slice(0, 200) }; }
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      if (LIMIT_RE.test(m)) {
        const at = RESET_RE.exec(m)?.[1];
        this.open = at && !Number.isNaN(Date.parse(at)) ? new Date(at) : new Date(now.getTime() + DEFAULT_BREAKER_MS);
        this.log(`[news-llm] breaker OPEN until ${this.open.toISOString()} — every news.* job paused (${req.job}: ${m.slice(0, 160)})`);
      }
      return { ok: false, reason: 'error', detail: m.slice(0, 300) };
    }
  }
  // now(), log(), rollNight(now) (reset when nightOfFor(now) changes), rollDay(now) (reset when istDay changes)
}
```

  The route's model (`claude-sonnet-5`) overrides the request model; the gateway ledger records each call under its `news.*` job.
  - `news-llm.module.ts`: imports `AiGatewayModule`, `NewsEventsCoreModule`, `PrismaModule`; provides `NEWS_LLM` via factory `(gw, cfg, prisma) => { const c = new NewsLlmClient({ gateway: gw, cfg, sessionOpen: (now) => clock.isOpen('NSE', now) || clock.isOpen('MCX', now), log: (l) => logger.log(l) }); void prisma.aiCall.count({ where: { job: 'news.profile', createdAt: { gte: istMidnight(new Date()) } } }).then((n) => c.seedIntraday(n)).catch(() => undefined); return c; }` (`clock = new SessionClock({ holidays: MARKET_HOLIDAYS })`, `istMidnight` from `ai-gateway.module`); exports `NEWS_LLM`.

- [ ] **Step 4: Verify** — the Step 2 command + `src/modules/ai-gateway` + `src/modules/trade-sentinel/golden` (gateway golden suite unchanged) → PASS. tsc → 174.

- [ ] **Step 5: Commit** — `feat(night-jobs): bounded, breakered NewsLlmClient over the gateway's additive callWithMeta (§11)`.

### Task N2: NightJobRunner, run repository, crons, module

> ⚠ NEVER delete directories anywhere in the repo (no `Remove-Item -Recurse`, `rm -rf`, `rmdir /s`, `git clean -fdx`) — worktrees hold node_modules junctions into the shared install. Run ONLY the targeted tests named in this task.

**Files:**
- Create: `night-jobs/night-job-run.repository.ts` (+spec), `night-jobs/night-job-runner.ts` (+spec), `night-jobs/night-jobs.cron.ts` (+spec), `night-jobs/night-jobs.module.ts`

**Interfaces:**
- Consumes: `NEWS_LLM`, `NEWS_CONTEXT_CONFIG`, `NightJobContext`, `NightJobOutcome`, `PROFILE_PREBUILDER`, `PREBUILD_MAX_PER_NIGHT`, `NIGHT_DEADLINE_IST`, `nightOfFor` (N1).
- Produces:

```ts
export type RunResult = { status: 'done' | 'failed' | 'skipped' | 'locked' | 'already-done' | 'running-elsewhere'; summary?: Record<string, unknown>; error?: string };
export class NightJobRunner {
  constructor(repo: NightJobRunRepository, llm: NewsLlm, log: (line: string) => void, now?: () => Date);
  run(job: NightJobName, fn: (ctx: NightJobContext) => Promise<NightJobOutcome>, opts?: { nightOf?: string }): Promise<RunResult>;
}
export function deadlineFor(nightOf: string): Date;   // (nightOf + 1 day) 07:30 IST
export class NightJobRunRepository {
  claim(job: string, nightOf: string, now: Date, deadline: Date): Promise<'claimed' | 'locked' | 'already-done' | 'running-elsewhere'>;
  finish(job: string, nightOf: string, r: { status: 'done' | 'failed' | 'skipped'; budget: NightBudgetSnapshot; summary: Record<string, unknown>; error?: string }): Promise<void>;
  recent(job: string, n: number): Promise<Array<{ nightOf: string; status: string; summary: Record<string, unknown> }>>;
}
// NightJobsCron: audit() @ '0 30 0 * * 2-6', curate() @ '0 15 1 * * 2-6', prebuild() @ '0 30 2 * * 2-6' (Asia/Kolkata)
```

- [ ] **Step 1: Write the failing tests** `night-job-runner.spec.ts` (fake repo + `fakeNewsLlm`):

```ts
it('claims, runs, finishes done with the budget delta and summary; logs one line', async () => {});
it('idempotent per (job, nightOf): a second run the same night returns already-done and does not call fn', async () => {});
it('advisory lock held by another process ⇒ locked; fn not called', async () => {});
it('a running row older than the deadline is taken over; a fresh running row ⇒ running-elsewhere', async () => {});
it('breaker open at start ⇒ skipped row with { reason: "breaker-open", until } (Review Focus 5)', async () => {
  const llm = fakeNewsLlm(); llm.openBreakerUntil(new Date('2026-10-17T05:00:00Z'));
  const r = await runner(llm).run('news.curate', jest.fn());
  expect(r).toEqual({ status: 'skipped', summary: { reason: 'breaker-open', until: '2026-10-17T05:00:00.000Z' } });
});
it('fn throws ⇒ failed with the message; never rethrows', async () => {});
it('the deadline is enforced: fn still running at 07:30 IST ⇒ failed "deadline" (fn sees ctx.deadline)', async () => {});
it('deadlineFor("2026-10-16") is 2026-10-17 07:30 IST', () => expect(deadlineFor('2026-10-16').toISOString()).toBe('2026-10-17T02:00:00.000Z'));
```

`night-job-run.repository.spec.ts`: `claim` runs `pg_try_advisory_xact_lock(hashtextextended('night:<job>:<nightOf>', 0))` inside `$transaction`; inserts `status: 'running'`; on unique conflict reads the row and returns the right state; takeover updates the row to `running` with a new `startedAt` and `error: 'abandoned'` recorded in the previous summary.
`night-jobs.cron.spec.ts`: each cron method is a no-op when `cfg.computing` is false; `curate()` is a no-op when `cfg.curator === 'off'`; the three cron expressions are exactly the strings above (read with `Reflect.getMetadata` like `overnight-calendar.spec.ts` does, or assert the exported constants `NIGHT_CRON_AUDIT/CURATE/PREBUILD`); `prebuild()` calls `PROFILE_PREBUILDER.prebuild(ctx, PREBUILD_MAX_PER_NIGHT)` inside `runner.run('news.prebuild', …)` and is a no-op when the token is unbound; `audit()` runs the stats job then the audit job inside ONE `runner.run('news.audit', …)` (stats summary nested under `summary.stats`).

- [ ] **Step 2: Run** `cd apps/api && npx jest src/modules/night-jobs --ci --maxWorkers=2` → FAIL.

- [ ] **Step 3: Implement.** Runner: `nightOf = opts.nightOf ?? nightOfFor(now)`; breaker check first (skipped row via `repo.finish` after a `claim`); `claim`; `const before = llm.usage('night')`; `Promise.race([fn(ctx), timeout(deadline − now)])`; `finish` with `budget = usage − before`; log `[night-job] news.audit 2026-10-16 done in 312s calls 9 in 81234 out 4120`. `NightJobsModule` imports `PrismaModule`, `NewsEventsCoreModule`, `NewsLlmModule`, `NewsModule`, `NewsIndexModule`; providers `NightJobRunRepository`, `NightJobRunner` (factory), `NightJobsCron`, and (N3–N7) the feedback/stats/audit/curator classes; it does NOT import `NewsProfilesModule` (I1 adds it) — `PROFILE_PREBUILDER`, `MATCHER_REBUILDER`, `CANDIDATE_RELEVANCE`, `INDEX_REBUILDER` are `@Optional()` injections.

- [ ] **Step 4: Verify** — same command → PASS. tsc → 174.

- [ ] **Step 5: Commit** — `feat(night-jobs): idempotent, locked, deadline-bound night job runner and the three news crons (§9.1)`.

### Task N3: Feedback store, judge sink, owner endpoints (feedback + rollback)

> ⚠ NEVER delete directories anywhere in the repo (no `Remove-Item -Recurse`, `rm -rf`, `rmdir /s`, `git clean -fdx`) — worktrees hold node_modules junctions into the shared install. Run ONLY the targeted tests named in this task.

**Files:**
- Create: `news-events/feedback/news-feedback.repository.ts` (+spec), `news-events/feedback/news-feedback.service.ts` (+spec), `news-events/feedback/news-feedback.controller.ts` (+spec), `news-events/feedback/dto/news-feedback.dto.ts`, `news-events/feedback/news-rules-ops.ts` (+spec), `news-events/feedback/news-feedback.module.ts`

**Interfaces:**
- Consumes: `FeedbackInput`, `FEEDBACK_KINDS`, `FEEDBACK_REASON_MAX`, `JudgeFeedback`/`NewsFeedbackSink` (port), `RuleSetAdmin`, `RetagRunner`, `IndexRebuilder`, `MatcherRebuilder`, `AdminOnly`, `CurrentUser`.
- Produces:

```ts
export class NewsFeedbackRepository {
  insertMany(rows: readonly FeedbackInput[]): Promise<number>;           // reason capped at 300
  openSince(since: Date): Promise<Array<FeedbackInput & { id: string; createdAt: Date }>>;
  resolve(ids: readonly string[], ruleId: string | null): Promise<void>;
  articleVersions(ids: readonly string[]): Promise<Map<string, { tagVersion: number; ruleSetVersion: number }>>;
}
export class NewsFeedbackService implements NewsFeedbackSink {
  recordJudge(rows: readonly JudgeFeedback[]): void;                       // fire-and-forget
  record(rows: readonly FeedbackInput[]): Promise<number>;
}
export class NewsRulesOps {
  /** After a set change: re-tag 48 h, rebuild the index and the matcher. Every step caught + logged. */
  refreshAfterRuleChange(reason: string): Promise<{ retagged: number }>;
  rollback(actor: string): Promise<{ from: number; to: number } | null>;
}
// POST /api/admin/news-tag-feedback   (AdminOnly) body { articleId, tag, symbol?, kind, reason } → { recorded: 1 }
// POST /api/admin/news-tag-rules/rollback (AdminOnly) → { from, to, retagged } | 409 { message: 'no parent rule set' }
```

- [ ] **Step 1: Write the failing tests.** Service: `recordJudge` returns synchronously, looks up each article's `tagVersion`/`ruleSetVersion`, inserts `signal: 'judge'` rows; a DB failure is caught and logged `[news-feedback] judge rows failed: …` and never rethrown (assert with an unhandled-rejection guard). Controller (Nest testing module with the global guards stubbed): `@AdminOnly()` metadata present on the class; invalid `kind` ⇒ 400; a valid owner row is stored with `signal: 'owner'`; rollback calls `RuleSetAdmin.rollback` then `refreshAfterRuleChange('rollback by <userId>')` and returns `{ from, to, retagged }`; rollback with no parent ⇒ 409. `news-rules-ops.spec.ts`: missing optional tokens are skipped (logged), a throwing re-tag does not stop the index/matcher rebuild.

- [ ] **Step 2: Run** `cd apps/api && npx jest src/modules/news-events/feedback --ci --maxWorkers=2` → FAIL.

- [ ] **Step 3: Implement** (DTO with `class-validator`: `@IsString() articleId`, `@Matches(/^[ISXMD]:[A-Z0-9&_. -]{1,40}$/) tag`, `@IsIn(FEEDBACK_KINDS) kind`, `@IsString() @MaxLength(300) reason`, `@IsOptional() @IsString() symbol`). Put the repository, service and `NewsRulesOps` in their own small `news-events/feedback/news-feedback.module.ts` (imports `PrismaModule`; providers + `{ provide: NEWS_FEEDBACK, useExisting: NewsFeedbackService }`; exports all) so the sentinel can import it in I1 without pulling in the night jobs; the controller is registered in `NightJobsModule` (N2), which imports `NewsFeedbackModule`. `NewsRulesOps` injects `RULE_SET_ADMIN`, `RETAG_RUNNER`, `INDEX_REBUILDER`, `MATCHER_REBUILDER` all `@Optional()`.

- [ ] **Step 4: Verify** — same command → PASS. tsc → 174.

- [ ] **Step 5: Commit** — `feat(news-events): tag feedback store, judge sink, owner feedback + one-step rollback endpoints (§7, §9.4)`.

### Task N4: Statistics and source hygiene (no LLM)

> ⚠ NEVER delete directories anywhere in the repo (no `Remove-Item -Recurse`, `rm -rf`, `rmdir /s`, `git clean -fdx`) — worktrees hold node_modules junctions into the shared install. Run ONLY the targeted tests named in this task.

**Files:**
- Create: `news-events/audit/news-stats.ts` (+spec), `news-events/audit/news-stats.job.ts` (+spec)

**Interfaces:**
- Consumes: `WordPolicy` (`WORD_POLICY`, `@Optional`), `SourceHealthBook`, `NightJobRunRepository.recent`, `NewsFeedbackService.record`, `SOURCE_DROP_NIGHTS`, `SOURCE_DOWN_AFTER`.
- Produces:

```ts
export function aliasAnomalies(daily: ReadonlyMap<string, readonly number[]>, today: ReadonlyMap<string, number>): Array<{ symbol: string; today: number; median30: number }>;
export function personContextShare(titles: readonly string[], words: readonly string[], policy: WordPolicy): number;
export function candidateAliases(untaggedTitles: readonly string[], officialNames: ReadonlyMap<string, string>): Array<{ phrase: string; symbol: string; titles: string[] }>;
export function sourcesToDrop(tonight: readonly SourceHealth[], previous: ReadonlyArray<readonly SourceHealth[]>, nights?: number): string[];
export class NewsStatsJob { run(ctx: NightJobContext): Promise<NightJobOutcome> }   // summary: { anomalies, candidates, sources: SourceHealth[], sourceDrops: string[], feedbackRows }
```

- [ ] **Step 1: Write the failing tests** `news-stats.spec.ts`:

```ts
it('alias anomaly: today ≥ 10 and ≥ 5× the 30-day median', () => {
  const daily = new Map([['SHAH', Array(30).fill(1)], ['INFY', Array(30).fill(8)]]);
  expect(aliasAnomalies(daily, new Map([['SHAH', 12], ['INFY', 30]]))).toEqual([{ symbol: 'SHAH', today: 12, median30: 1 }]);
  expect(aliasAnomalies(daily, new Map([['SHAH', 9]]))).toEqual([]);
});
it('person-context share flags a symbol living in bylines and quotes', () => {
  expect(personContextShare(['Nifty may rise, says Rajesh Shah', 'Shah, analyst at X, sees upside', 'Shah Metacorp shares jump'], ['Shah'], stubWordPolicy())).toBeCloseTo(2 / 3);
});
it('candidate aliases: Title-Case 1–4-grams in ≥ 3 untagged titles that prefix exactly one EQUITY_L name', () => {
  const names = new Map([['HDFCLIFE', 'HDFC Life Insurance Company Limited'], ['HDFCBANK', 'HDFC Bank Limited']]);
  const titles = ['HDFC Life slips', 'HDFC Life new plan', 'HDFC Life Q2', 'HDFC shares mixed', 'HDFC up', 'HDFC down'];
  expect(candidateAliases(titles, names)).toEqual([{ phrase: 'HDFC Life', symbol: 'HDFCLIFE', titles: titles.slice(0, 3) }]);
});
it('source hygiene (P10): DOWN tonight and on the 2 previous nights ⇒ drop; a recovery resets', () => {
  const down = (source: string) => ({ source, lastOkAt: null, lastError: '403', consecutiveFailures: 6, itemsLastFetch: 0 });
  const up = (source: string) => ({ ...down(source), consecutiveFailures: 0, lastError: null });
  expect(sourcesToDrop([down('ET Auto'), down('X')], [[down('ET Auto'), up('X')], [down('ET Auto'), down('X')]])).toEqual(['ET Auto']);
  expect(sourcesToDrop([down('ET Auto')], [[down('ET Auto')]])).toEqual([]);            // only 2 nights of history
});
```

`news-stats.job.spec.ts`: reads 30 days of `I:` counts with ONE grouped SQL (`unnest(instruments)` by IST day), writes `stats` feedback rows (anomaly ⇒ `irrelevant` on the symbol's newest article, reason `"24 h hits 12 vs 30-day median 1"`; person-share ≥ 0.6 ⇒ `irrelevant`; candidate ⇒ `missed` with tag `I:<SYMBOL>` on up to 3 articles), snapshots `health.all()` into `summary.sources`, computes `sourceDrops` from the two previous `news.audit` rows' `summary.stats.sources`, and makes ZERO LLM calls (assert on `fakeNewsLlm().calls`).

- [ ] **Step 2: Run** `cd apps/api && npx jest src/modules/news-events/audit/news-stats --ci --maxWorkers=2` → FAIL.

- [ ] **Step 3: Implement** (pure functions + a job class that only reads `news_articles`, `instrument_name_aliases`, `night_job_runs` and writes `news_tag_feedback`).

- [ ] **Step 4: Verify** — same command → PASS. tsc → 174.

- [ ] **Step 5: Commit** — `feat(news-events): nightly tag statistics and source hygiene — no LLM (§9.3)`.

### Task N5: Nightly audit (LLM, positions of the day)

> ⚠ NEVER delete directories anywhere in the repo (no `Remove-Item -Recurse`, `rm -rf`, `rmdir /s`, `git clean -fdx`) — worktrees hold node_modules junctions into the shared install. Run ONLY the targeted tests named in this task.

**Files:**
- Create: `news-events/audit/news-audit.job.ts` (+spec)

**Interfaces:**
- Consumes: `NightJobContext`, `NewsLlm`, `newsPositionOf`, `positionKeyOf`, `AUDIT_MAX_CALLS`, `AUDIT_MAX_HEADLINES`, `AUDIT_MARKET_SAMPLE`, `NewsFeedbackService.record`, `ProfileRepository`-free (reads `news_entity_profiles` rows directly via Prisma, read-only), `sentinel_verdicts.newsShadow.v3` (read-only).
- Produces: `export const AUDIT_SCHEMA`, `export const AUDIT_MARKET_SCHEMA`, `auditSystemPrompt()`, `marketSystemPrompt()`, `class NewsAuditJob { run(ctx: NightJobContext): Promise<NightJobOutcome> }` — summary `{ positions, calls, labelled, feedbackRows, skipped: Array<{ key, reason }> }`.

- [ ] **Step 1: Write the failing tests** `news-audit.job.spec.ts` (fake Prisma rows for one IST day, `fakeNewsLlm` scripted replies):

```ts
it('positions of the day = trade_trackers open at any time that day ∪ core_positions open at any time that day, by underlying', async () => {});
it('per position ≤ 40 headlines: v3-attached (from newsShadow.v3.refs), v2 headlines v3 dropped, untagged titles containing a profile token (case-insensitive)', async () => {});
it('one call per position + one market call; ≤ 15 calls; positions with the most headlines first', async () => {});
it('labels other than relevant become audit feedback rows with the model reason (≤ 300 chars)', async () => {
  // reply: { labels: [{ id: 'a1', label: 'wrong_company', reason: 'Shah is the analyst' }, { id: 'a2', label: 'relevant', reason: '' }] }
  // ⇒ one row { articleId: 'a1', tag: 'I:SHAH', kind: 'wrong_company', signal: 'audit', … }
});
it('market call on a 60-headline sample: wrong market tags ⇒ wrong_market rows', async () => {});
it('an id the model invents (not in the batch) is ignored; a malformed reply is skipped and counted', async () => {});
it('stops at the first ok:false from the LLM (breaker/caps/deadline) and records why', async () => {});
```

- [ ] **Step 2: Run** `cd apps/api && npx jest src/modules/news-events/audit/news-audit.job.spec.ts --ci --maxWorkers=2` → FAIL.

- [ ] **Step 3: Implement.** Underlying of a `trade_trackers` row: `instruments.name` by `(token, exchange)` (read-only), else `baseSymbol(symbol)` for cash; `core_positions.underlying` directly. System prompt:

```
You audit news tags for open trading positions in the Indian market. For each headline decide whether it is about THIS position's underlying.
Labels: relevant (about it, or a real price driver of it); irrelevant (about something else); misleading (sounds related but would mislead a trader about it);
wrong_company (names a different company, a namesake, or a person with the same name); missed (a headline that IS about it but was not tagged).
Return one label per id with a short reason. Do not invent ids. JSON only.
```

  User payload: `{ position: { key, kind, profile: { names, drivers } }, headlines: [{ id, title, summary, tags, attached: bool, dropped: bool }] }`. `AUDIT_SCHEMA` = `{ labels: [{ id, label (enum 5), reason }] }`; market schema `{ markets: [{ id, markets: ('IN'|'GLOBAL')[] }] }` — a disagreement with the stored `markets` ⇒ `wrong_market` on each extra tag. Calls use `scope: 'night'`, `job: 'news.audit'`, `maxOutputTokens: 4000`.

- [ ] **Step 4: Verify** — same command → PASS. tsc → 174.

- [ ] **Step 5: Commit** — `feat(news-events): nightly LLM audit of the day's position headlines and market tags (§9.2)`.

### Task N6: Curator part 1 — clustering and LLM proposals

> ⚠ NEVER delete directories anywhere in the repo (no `Remove-Item -Recurse`, `rm -rf`, `rmdir /s`, `git clean -fdx`) — worktrees hold node_modules junctions into the shared install. Run ONLY the targeted tests named in this task.

**Files:**
- Create: `news-events/curator/cluster.ts` (+spec), `news-events/curator/proposals.ts` (+spec)

**Interfaces:**
- Consumes: feedback rows (`NewsFeedbackRepository.openSince`), `RULE_KINDS`, `isDriverKey`, `CURATOR_MAX_PROPOSALS`, `CURATOR_MIN_SUPPORT`, `NewsLlm`.
- Produces:

```ts
export interface FeedbackCluster { id: string; family: 'tag' | 'market' | 'missed'; tag: string; kinds: FeedbackKind[]; feedbackIds: string[]; articleIds: string[]; support: number; samples: Array<{ articleId: string; title: string; reason: string }> }
export function clusterFeedback(rows: ReadonlyArray<{ id: string; articleId: string; tag: string; kind: FeedbackKind; reason: string }>, titles: ReadonlyMap<string, string>): FeedbackCluster[];
export interface Proposal { clusterId: string; rule: TagRuleInput; rationale: string }
export const PROPOSAL_SCHEMA: Record<string, unknown>;
export function curatorSystemPrompt(): string;
export function validateProposals(raw: unknown, clusters: readonly FeedbackCluster[], listed: ReadonlySet<string>): { proposals: Proposal[]; problems: string[] };
export async function proposeRules(llm: NewsLlm, clusters: readonly FeedbackCluster[], listed: ReadonlySet<string>): Promise<{ proposals: Proposal[]; problems: string[]; llm: NewsLlmResult['ok'] }>;
```

- [ ] **Step 1: Write the failing tests.** `cluster.spec.ts`: rows group deterministically by `(family, tag)` (`wrong_market` ⇒ family `market`; `missed` ⇒ `missed`; others `tag`); support = distinct articles; order = support desc, then tag asc; samples ≤ 5; same input in a different order ⇒ identical output (ids are `sha1(family|tag)` prefixes). `proposals.spec.ts`:

```ts
it('only §6 kinds; literal patterns 2–80 chars; grounded in a cluster sample; systematic kinds preferred in order', () => {
  const clusters = [cluster({ id: 'c1', tag: 'I:SHAH', samples: [{ articleId: 'a1', title: 'Nifty may rise, says Rajesh Shah', reason: 'analyst' }], support: 3 })];
  const raw = { proposals: [
    { clusterId: 'c1', kind: 'alias_block', symbol: 'SHAH', pattern: 'Shah', params: {}, rationale: 'surname' },
    { clusterId: 'c1', kind: 'needs_context_word', symbol: null, pattern: 'Shah', params: {}, rationale: 'common surname' },
    { clusterId: 'c1', kind: 'regex', symbol: null, pattern: 'Sh.*', params: {}, rationale: 'x' },
    { clusterId: 'c1', kind: 'generic_word', symbol: null, pattern: 'Zebra', params: {}, rationale: 'not in any sample' },
    { clusterId: 'c9', kind: 'generic_word', symbol: null, pattern: 'Shah', params: {}, rationale: 'unknown cluster' },
  ] };
  const r = validateProposals(raw, clusters, new Set(['SHAH']));
  expect(r.proposals.map((p) => p.rule.kind)).toEqual(['needs_context_word', 'alias_block']);
  expect(r.problems).toHaveLength(3);
});
it('≤ 10 proposals; clusters with support < 2 are never sent', async () => {});
it('one LLM call (job news.curate, scope night); ok:false ⇒ no proposals, reason returned', async () => {});
```

- [ ] **Step 2: Run** `cd apps/api && npx jest src/modules/news-events/curator/cluster.spec.ts src/modules/news-events/curator/proposals.spec.ts --ci --maxWorkers=2` → FAIL.

- [ ] **Step 3: Implement.** System prompt:

```
You maintain the rules of a news tagger for the Indian market. Each cluster lists headlines the tagger got wrong and why.
Propose rules ONLY of these kinds: needs_context_word, generic_word, market_entity (params.market IN|GLOBAL), driver_phrase (params.driver one of the
listed keys), alias_add (symbol + pattern), alias_block (symbol + pattern), profile_flag (symbol). Every pattern is a LITERAL phrase copied from the
headlines — never a regular expression, never a wildcard. Prefer rules that fix the cause for EVERY symbol (needs_context_word, generic_word,
market_entity, driver_phrase) over a rule for one symbol. At most 10 proposals. JSON only.
```

  Grounding: `pattern` must occur (case-insensitive, token boundaries) in at least one sample title of its cluster for every kind except `profile_flag`. Sort accepted proposals: systematic kinds first, then by cluster support desc.

- [ ] **Step 4: Verify** — same command → PASS. tsc → 174.

- [ ] **Step 5: Commit** — `feat(news-events): curator clustering and grounded, literal rule proposals (§9.4 1–2)`.

### Task N7: Curator part 2 — evaluation bar, propose/auto, apply, summary

> ⚠ NEVER delete directories anywhere in the repo (no `Remove-Item -Recurse`, `rm -rf`, `rmdir /s`, `git clean -fdx`) — worktrees hold node_modules junctions into the shared install. Run ONLY the targeted tests named in this task.

**Files:**
- Create: `news-events/curator/evaluate-proposal.ts` (+spec), `news-events/curator/news-curator.job.ts` (+spec)

**Interfaces:**
- Consumes: `evaluate(set, tag, relevant?) → EvalReport` from `news-events/eval/metrics.ts` (E1). **Until I1 merges E**, N7's specs import a local test double `news-events/curator/__test__/fake-evaluate.ts` exporting the same signature; `evaluate-proposal.ts` takes the evaluator as a constructor/function ARGUMENT (`EvaluateFn`), so it never imports E's file directly — I1 wires the real one. Also `RuleSetAdmin`, `CandidateTagger`, `CandidateRelevance`, `NewsRulesOps`, `NightJobRunRepository.recent`, `LabelledHeadline`, P9 constants.
- Produces:

```ts
export type EvaluateFn = (set: readonly LabelledHeadline[], tag: TagFn, relevant?: RelevanceFn) => EvalReport;
export interface ProposalVerdict { proposal: Proposal; decision: 'apply' | 'owner-review' | 'reject'; reasons: string[]; before: EvalReport; after: EvalReport; resolves: string[]; blastShare: number }
export function judgeProposal(o: {
  base: readonly TagRuleInput[]; proposal: Proposal; labelled: readonly LabelledHeadline[];
  linked: ReadonlyArray<{ feedbackId: string; article: Pick<LabelledHeadline, 'id' | 'title' | 'summary' | 'source' | 'category'>; tag: string; kind: FeedbackKind; symbol: string | null }>;
  recent7d: ReadonlyArray<Pick<LabelledHeadline, 'title' | 'summary' | 'source' | 'category'>>;
  tagger: CandidateTagger; relevance?: CandidateRelevance; evaluate: EvaluateFn;
}): ProposalVerdict;
export function greedyAccept(o: Omit<Parameters<typeof judgeProposal>[0], 'proposal'> & { proposals: readonly Proposal[] }): ProposalVerdict[];  // ≤ 5 applied
export function effectiveMode(configured: CuratorMode, history: ReadonlyArray<{ status: string; summary: Record<string, unknown> }>, hasLabelledSet: boolean): { mode: 'off' | 'propose' | 'auto'; why: string };
export class NewsCuratorJob { run(ctx: NightJobContext): Promise<NightJobOutcome> }
```

- [ ] **Step 1: Write the failing tests** `evaluate-proposal.spec.ts` (P9 — every branch):

```ts
it('a proposal that lowers precision for ANY kind on the labelled set is rejected (spec §15)', () => {
  // fake evaluate: before.company.precision 0.95, after 0.94 ⇒ reject with reason 'precision company 0.950 → 0.940'
});
it('company recall may drop at most 0.5 pp', () => { /* 0.900 → 0.894 ok; 0.900 → 0.894999… boundary; 0.900 → 0.890 reject */ });
it('must resolve ≥ 2 linked feedback rows (wrong_company/irrelevant: tag gone; missed: tag present; wrong_market: market gone)', () => {});
it('changes tags on > 2 % of the last 7 days ⇒ owner-review, never applied', () => {});
it('position-relevance precision is a kind too: a drop rejects', () => {});
it('greedy: re-evaluates each next proposal against the base INCLUDING the ones accepted; ≤ 5 applied', () => {});
it('a source_drop skips the bar (it changes no tag) but still counts toward the 5', () => {});
```

`news-curator.job.spec.ts`:

```ts
it('effectiveMode: auto acts as propose until 2 completed propose nights exist (P7) and only with a labelled set', () => {
  const night = (mode: string) => ({ status: 'done', summary: { mode } });
  expect(effectiveMode('auto', [], true)).toEqual({ mode: 'propose', why: expect.stringMatching(/0\/2 propose nights/) });
  expect(effectiveMode('auto', [night('propose'), night('propose')], true).mode).toBe('auto');
  expect(effectiveMode('auto', [night('propose'), night('propose')], false)).toEqual({ mode: 'propose', why: expect.stringMatching(/no labelled set/) });
  expect(effectiveMode('off', [], true).mode).toBe('off');
});
it('propose: writes proposed rows only; the active set, tags and index are untouched', async () => {});
it('auto: creates set N+1 (parent N) with the accepted rules, resolves their feedback, re-tags 48 h, rebuilds index + matcher', async () => {});
it('morning summary + ONE [news-curator] line with each change, feedback ids, before → after, and the rollback command', async () => {
  // expect(log).toHaveBeenCalledWith(expect.stringMatching(/^\[news-curator\] 2026-10-16 auto: applied 1\/3 \(v4 ← v3\).*rollback: POST \/api\/admin\/news-tag-rules\/rollback/));
});
it('never writes the labelled set file (fs spy: no write to __fixtures__/eval)', async () => {});
it('breaker/caps during proposals ⇒ the night ends as propose-only with the reason; nothing applied', async () => {});
it('a stale parent (another run applied first) ⇒ nothing applied, logged', async () => {});
```

- [ ] **Step 2: Run** `cd apps/api && npx jest src/modules/news-events/curator --ci --maxWorkers=2` → FAIL.

- [ ] **Step 3: Implement.** Labelled set: `NEWS_EVAL_SET_PATH` or walk up from `__dirname` for `apps/api/src/modules/news-events/__fixtures__/eval/headlines-2026-10.jsonl` (read-only; parse with E1's reader — pass it in like `evaluate`, `ReadSetFn`). `recent7d` = titles/summaries of the last 7 days (one query). `linked` = articles of the cluster feedback rows. Apply (auto): `admin.createRuleSet({ parentVersion: active, added: accepted, metrics: { before, after, perProposal }, summary, activate: true })`, `feedbackRepo.resolve(ids, ruleSetVersionAsString)`, `ops.refreshAfterRuleChange('curator v<N>')`. Summary JSON (stored by the runner): `{ mode, effectiveMode, why, clusters, proposals: [{ kind, symbol, pattern, decision, reasons, feedbackIds, before: {company, commodity, index, market, driver, relevance}, after: {…} }], applied, ruleSetVersion, rollback: 'POST /api/admin/news-tag-rules/rollback — or SQL: UPDATE news_tag_rule_sets SET active = (version = <parent>)' }`.

- [ ] **Step 4: Verify** — same command + `src/modules/night-jobs` → PASS. tsc → 174.

- [ ] **Step 5: Commit** — `feat(news-events): curator evaluation bar (P9), propose→auto (P7), apply + re-tag + rebuild, morning summary (§9.4)`.

---

## Stream E — labelled evaluation set (worktree `nctx-e`, branch `feature/nctx-e`)

Goal: spec §10 + M0. E delivers the format, the metrics runner (used by the curator and the go-live bar), the read-only export, the dev-CLI labeller and the report. The real data (`headlines-2026-10.jsonl`, `baseline-v2.json`) is produced by the OWNER in Gate M0 — agents have no prod access.

### Task E1: JSONL format, reader/validator, metrics runner

> ⚠ NEVER delete directories anywhere in the repo (no `Remove-Item -Recurse`, `rm -rf`, `rmdir /s`, `git clean -fdx`) — worktrees hold node_modules junctions into the shared install. Run ONLY the targeted tests named in this task.

**Files:**
- Create: `news-events/eval/labelled-set.ts` (+spec), `news-events/eval/metrics.ts` (+spec), `news-events/__fixtures__/eval/synthetic.jsonl` (12 hand-written lines)

**Interfaces:**
- Consumes: `LabelledHeadline`, `EvalKind`, `KindScore`, `EvalReport`, `TagFn`, `RelevanceFn`, `MCX_GROUP` + `MCX_COMPOSITES` (keys.ts — commodity vs company split; `MCX_COMPOSITES` arrives with R4, so use `Object.keys(MCX_GROUP)` only and add composites in I1 if R4 merged first).
- Produces: `validateLabelledLine(raw: unknown, line: number): { ok: true; value: LabelledHeadline } | { ok: false; problem: string }`; `readLabelledSet(path: string): { set: LabelledHeadline[]; problems: string[] }`; `evaluate(set, tag, relevant?) → EvalReport`; `compareReports(before, after): Record<EvalKind | 'relevance', { precisionDelta: number | null; recallDeltaPp: number | null }>`; `formatReport(r: EvalReport, title: string): string` (fixed-width table).

- [ ] **Step 1: Write the failing tests** `metrics.spec.ts`:

```ts
import { compareReports, evaluate, formatReport } from './metrics';
const h = (id: string, labels: Partial<LabelledHeadline['labels']>, relevance: LabelledHeadline['relevance'] = []): LabelledHeadline => ({
  id, title: id, summary: '', source: id.startsWith('n') ? 'NSE Announcements' : 'ET', category: 'company', publishedAt: '2026-10-15T05:00:00Z',
  labels: { companies: [], commodities: [], indices: [], markets: [], drivers: [], ...labels }, relevance,
  meta: { passA: 'a', passB: 'b', adjudicated: false, ownerChecked: false },
});
const tags = (o: Partial<ArticleTags>) => ({ instruments: [], sectors: [], indices: [], markets: [], ...o });

it('per kind tp/fp/fn, precision, recall; MCX benchmarks count as commodities, not companies', () => {
  const set = [h('a', { companies: ['INFY'], commodities: ['CRUDEOIL'] }), h('b', { companies: ['TCS'] }), h('c', {})];
  const pred: Record<string, ArticleTags> = { a: tags({ instruments: ['INFY', 'CRUDEOIL'] }), b: tags({ instruments: ['SHAH'] }), c: tags({ instruments: ['WIPRO'] }) };
  const r = evaluate(set, (x) => pred[(x as { title: string }).title]);
  expect(r.byKind.company).toEqual({ tp: 1, fp: 2, fn: 1, precision: 1 / 3, recall: 0.5 });
  expect(r.byKind.commodity).toEqual({ tp: 1, fp: 0, fn: 0, precision: 1, recall: 1 });
  expect(r.byKind.index).toEqual({ tp: 0, fp: 0, fn: 0, precision: null, recall: null });
});
it('market accuracy = exact set match share', () => {});
it('position relevance: predicted-relevant pairs vs labels (misleading counts as not relevant)', () => {
  const set = [h('a', {}, [{ symbol: 'INFY', label: 'relevant' }, { symbol: 'SHAH', label: 'irrelevant' }]), h('b', {}, [{ symbol: 'INFY', label: 'misleading' }])];
  const r = evaluate(set, () => tags({}), (x, s) => s === 'INFY');
  expect(r.relevance).toEqual({ n: 3, tp: 1, fp: 1, precision: 0.5 });
});
it('bySource splits the same counts', () => {});
it('compareReports: precision delta and recall delta in percentage points; null when undefined', () => {});
it('formatReport is a stable fixed-width table (snapshot-free: assert line count and a header)', () => {});
```

`labelled-set.spec.ts`: the synthetic fixture loads with 0 problems; a line with an unknown market, a missing `labels`, or bad JSON yields a problem naming the line number; duplicate ids are a problem.

- [ ] **Step 2: Run** `cd apps/api && npx jest src/modules/news-events/eval --ci --maxWorkers=2` → FAIL.

- [ ] **Step 3: Implement** (pure; `evaluate` splits `tags.instruments` into commodities = members of `MCX_GROUP` keys, companies = the rest; `drivers` = `tags.drivers ?? []`).

- [ ] **Step 4: Verify** — same command → PASS. tsc → 174.

- [ ] **Step 5: Commit** — `feat(news-events): labelled evaluation set format and metrics runner (§10)`.

### Task E2: Read-only export of ~1,000 headlines + traded symbols

> ⚠ NEVER delete directories anywhere in the repo (no `Remove-Item -Recurse`, `rm -rf`, `rmdir /s`, `git clean -fdx`) — worktrees hold node_modules junctions into the shared install. Run ONLY the targeted tests named in this task.

**Files:**
- Create: `apps/api/scripts/news-eval-export.ts`, `apps/api/scripts/sql/news-eval-export.sql`, `news-events/eval/export-plan.ts` (+spec)

**Interfaces:**
- Produces: `stratifiedQuota(counts: Record<string, number>, total = 1000, floor = 10): Record<string, number>` (pure); the script writes `headlines-unlabelled-<date>.jsonl` (`{ id, title, summary, source, category, publishedAt }` per line) and `traded-symbols-<date>.json` (distinct underlyings of `trade_trackers` + `core_positions`, last 90 days). No user ids, no P&L, no tokens.

- [ ] **Step 1: Write the failing test** `export-plan.spec.ts`: quotas sum to `min(total, Σcounts)`; every source with ≥ 1 row gets ≥ `min(floor, count)`; proportional otherwise; deterministic rounding (largest remainder, ties by source name).

- [ ] **Step 2: Run** `cd apps/api && npx jest src/modules/news-events/eval/export-plan.spec.ts --ci --maxWorkers=2` → FAIL.

- [ ] **Step 3: Implement.** Script header: "READ-ONLY. Run by the owner with a read-only role: `READONLY_DATABASE_URL=… npx tsx scripts/news-eval-export.ts --days 7 --total 1000 --out <dir>`". It (1) `SELECT source, count(*) FROM news_articles WHERE "publishedAt" >= now() - interval '7 days' GROUP BY 1`; (2) per source `SELECT id, title, summary, source, category, "publishedAt" FROM news_articles WHERE source = $1 AND "publishedAt" >= … ORDER BY md5(id) LIMIT $quota` (deterministic sample); (3) the traded-symbol query; refuses to run if `READONLY_DATABASE_URL` is unset (never falls back to `DATABASE_URL`). The `.sql` file is the psql `\copy` equivalent for the same three queries.

- [ ] **Step 4: Verify** — same command → PASS; `npx tsc --noEmit -p tsconfig.json` count 174 (scripts are type-checked by the API tsconfig only if included; if not, run `npx tsx --check scripts/news-eval-export.ts` is not available — instead `npx tsc --noEmit --module commonjs --target es2022 --esModuleInterop --skipLibCheck scripts/news-eval-export.ts`).

- [ ] **Step 5: Commit** — `feat(news-events): read-only, stratified export for the labelled set (§10)`.

### Task E3: Dev-CLI labeller — two passes + adjudication + position relevance

> ⚠ NEVER delete directories anywhere in the repo (no `Remove-Item -Recurse`, `rm -rf`, `rmdir /s`, `git clean -fdx`) — worktrees hold node_modules junctions into the shared install. Run ONLY the targeted tests named in this task.

**Files:**
- Create: `news-events/eval/label-prompts.ts` (+spec), `news-events/eval/label-merge.ts` (+spec), `apps/api/scripts/news-eval-label.ts`

**Interfaces:**
- Consumes: `ClaudeCliTransport` (dev machine CLI, P6 — the ONE allowed direct-transport use; never the prod account), `validateLabelledLine` (E1).
- Produces: `PASS_A_SYSTEM`, `PASS_B_SYSTEM`, `ADJUDICATE_SYSTEM`, `RELEVANCE_SYSTEM`, `LABEL_SCHEMA`, `RELEVANCE_SCHEMA`; `mergePasses(a: Labels[], b: Labels[]): { agreed: Labels[]; disputed: Array<{ id: string; a: Labels; b: Labels }> }`; `pickRelevancePairs(set, traded: string[], n = 200, seed = 1): Array<{ id: string; symbol: string }>` (half from headlines either pass tagged with a traded symbol, half random traded-symbol negatives; deterministic).

- [ ] **Step 1: Write the failing tests.** `label-merge.spec.ts`: identical label sets agree; any difference in any of the five arrays (order-insensitive) is disputed; `pickRelevancePairs` is deterministic for a seed and returns ≤ n pairs with ≥ 40 % positives when available. `label-prompts.spec.ts`: the two pass prompts differ (A: entity-first "list every company, commodity, index, market, driver"; B: question-by-question "is this about a listed company? which? …"), both name the same label vocabulary, schemas have full `required` and `additionalProperties: false`.

- [ ] **Step 2: Run** `cd apps/api && npx jest src/modules/news-events/eval/label-merge.spec.ts src/modules/news-events/eval/label-prompts.spec.ts --ci --maxWorkers=2` → FAIL.

- [ ] **Step 3: Implement.** Script (`npx tsx scripts/news-eval-label.ts --in headlines-unlabelled-<date>.jsonl --traded traded-symbols-<date>.json --out src/modules/news-events/__fixtures__/eval/headlines-2026-10.jsonl`): batches of 20 headlines per call, `claude-sonnet-5`, resumable (`<out>.passA.jsonl`, `<out>.passB.jsonl`, `<out>.adjudicated.jsonl`, skips ids already present), stops on the first limit/429 error and prints how to resume, then relevance pairs (batches of 20), then writes the final JSONL validated line-by-line with `validateLabelledLine` and prints 50 random lines to `<out>.spot-check.txt` for the owner (P6/§10 owner spot-check; the owner edits lines in place and sets `meta.ownerChecked: true`). The script never runs in CI (no spec imports it).

- [ ] **Step 4: Verify** — same command → PASS. tsc → 174.

- [ ] **Step 5: Commit** — `feat(news-events): dev-CLI labeller — two independent passes, adjudication, position relevance (§10, P6)`.

### Task E4: Baseline report + CI metric table (no thresholds)

> ⚠ NEVER delete directories anywhere in the repo (no `Remove-Item -Recurse`, `rm -rf`, `rmdir /s`, `git clean -fdx`) — worktrees hold node_modules junctions into the shared install. Run ONLY the targeted tests named in this task.

**Files:**
- Create: `apps/api/scripts/news-eval-report.ts`, `news-events/eval/eval-report.spec.ts`, `news-events/eval/build-tagger.ts` (+spec)

**Interfaces:**
- Consumes: `tagArticle`, `NameMatcher`, `deriveAliases`, `parseEquityL` (as they exist on the branch — on E's branch that is v2 AS DEPLOYED, which is exactly the M0 baseline), `evaluate`, `formatReport`.
- Produces: `buildFixtureTagger(equityLCsv: string, opts?: { policy?: WordPolicy; rules?: unknown }): TagFn` (pure, from the EQUITY_L fixture; after I1 it automatically includes R's rules since it calls the merged `tagArticle`); script flags `--write-baseline` (writes `__fixtures__/eval/baseline-v2.json` = `EvalReport` + git sha + date) and `--compare` (prints `compareReports(baseline, now)`).

- [ ] **Step 1: Write the failing test** `eval-report.spec.ts`:

```ts
it('prints the metric table for the synthetic set (always) and the real set when present — no thresholds (spec §15)', () => {
  const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  runEvalReportForCi();                                   // exported from build-tagger.ts
  expect(log.mock.calls.flat().join('\n')).toMatch(/company\s+precision/);
  log.mockRestore();
});
```

  (`runEvalReportForCi` reads `synthetic.jsonl` and, if it exists, `headlines-2026-10.jsonl`, prints `formatReport` for each, and prints `no labelled set yet (Gate M0)` otherwise. It asserts nothing about values.)

- [ ] **Step 2: Run** `cd apps/api && npx jest src/modules/news-events/eval/eval-report.spec.ts --ci --maxWorkers=2` → FAIL.

- [ ] **Step 3: Implement** `build-tagger.ts` (`listed` = EQUITY_L symbols; `sectors` = `{ sectorOf: () => null }` — sector tags are not evaluated) and the script.

- [ ] **Step 4: Verify** — same command → PASS. tsc → 174.

- [ ] **Step 5: Commit** — `feat(news-events): eval report and v2 baseline writer; CI prints the table without thresholds (§10, §15)`.

---

## Integration (on `feature/news-context-v3`, after all five streams are done)

### Task I1: Merge streams, wire DI, full suite

> ⚠ NEVER delete directories anywhere in the repo (no `Remove-Item -Recurse`, `rm -rf`, `rmdir /s`, `git clean -fdx`) — worktrees hold node_modules junctions into the shared install. This is the ONLY task that runs the full suite, and only with `--maxWorkers=2`.

**Files:**
- Modify: `apps/api/src/app.module.ts`, `trade-sentinel/trade-sentinel.module.ts` (+ `trade-sentinel.module.spec.ts`), `news-events/profiles/news-profiles.module.ts` (import `NewsLlmModule`), `night-jobs/night-jobs.module.ts` (import `NewsProfilesModule`, bind `INDEX_REBUILDER`), `news-events/curator/news-curator.job.ts` (real `evaluate` + `readLabelledSet`), `news/news.module.ts` (bind `INDEX_REBUILDER`/`MATCHER_REBUILDER` for the rules service) — resolve conflicts only; no new behaviour.

**Interfaces:**
- Consumes: every token in Interfaces.
- Produces: one branch where every port is bound: `POSITION_NEWS → PositionNewsMatcherService`, `NEWS_FEEDBACK → NewsFeedbackService`, `WORD_POLICY`/`CANDIDATE_TAGGER`/`RETAG_RUNNER`/`RULE_SET_ADMIN` (NewsModule), `NEWS_LLM` (NewsLlmModule), `PROFILE_PREBUILDER`/`PROFILE_FLAGGER`/`MATCHER_REBUILDER`/`CANDIDATE_RELEVANCE` (NewsProfilesModule), `INDEX_REBUILDER → NewsIndexService`.

- [ ] **Step 1: Merge in order R → E → P → N → S** (`git merge --no-ff feature/nctx-<x>`), resolving conflicts by keeping both sides' additions; after EACH merge run that stream's module tests only (e.g. `npx jest src/modules/news-events/tagging src/modules/news-events/rules --ci --maxWorkers=2` after R) and tsc (174).
- [ ] **Step 2: Wire DI.** `app.module.ts`: import `NewsProfilesModule`, `NewsFeedbackModule`, `NightJobsModule` (after `NewsModule`). `trade-sentinel.module.ts`: import `NewsProfilesModule` and `NewsFeedbackModule`; add `{ provide: POSITION_NEWS, useExisting: PositionNewsMatcherService }`, `{ provide: NEWS_FEEDBACK, useExisting: NewsFeedbackService }` next to the `NEWS_INDEX` binding (composition root — the cycle still sees only the ports). `NewsModule`/`NightJobsModule`: `{ provide: INDEX_REBUILDER, useExisting: NewsIndexService }` (import `NewsIndexModule`); `{ provide: MATCHER_REBUILDER, useExisting: PositionNewsMatcherService }` reaches `NewsTagRulesService` through `NewsProfilesModule`'s export — if that creates a module cycle (`NewsProfilesModule` → `NewsIndexModule` ✓, `NewsModule` → `NewsProfilesModule` ✗ because profiles need `WORD_POLICY` from `NewsModule`), use `forwardRef(() => NewsProfilesModule)` in `NewsModule` and `@Inject(forwardRef(() => MATCHER_REBUILDER))` — or simpler: have `NewsRulesOps` (N3) be the only caller of the matcher/index rebuild and let `NewsTagRulesService.poll` call `NewsRulesOps.refreshAfterRuleChange` through an `@Optional()` setter registered at `NightJobsModule` init. Pick the variant that boots; prove it with `trade-sentinel.module.spec.ts` + a new `news-context.wiring.spec.ts` that compiles `AppModule`-like test modules for `NewsModule`, `NewsProfilesModule`, `NightJobsModule`, `TradeSentinelModule` with Prisma mocked and asserts each token resolves.
- [ ] **Step 3: Curator real evaluator.** Replace N7's injected test evaluator with `evaluate` / `readLabelledSet` from E1 in the job's factory; keep the function-argument seam.
- [ ] **Step 4: Full suite.** `cd apps/api && npx jest --ci --maxWorkers=2` → all green (expected: only the pre-existing skipped/env-gated suites skipped). tsc → 174. `npx prisma validate` + the migration drift check from F3 (shadow DB) if available. Commit with message `chore(news-context): integrate streams R, E, P, N, S and bind the v3 ports`.
- [ ] **Step 5: Flag-off end-to-end proof.** In one spec (`news-context.flag-off.e2e.spec.ts`), boot the sentinel's packet + agent with env `NEWS_EVENTS_V2_ENABLED=true`, `NEWS_CONTEXT_V3` unset and assert: the four `V2_TRUE_PACKET_SHA256` hashes (S4), the 16 prompt pins (S1), `VERDICT_SCHEMA` identity on the request, the golden suite unchanged (`git diff --stat` on the snapshot = only S5's additions vs the Foundation tip). Commit `test(news-context): flag-off identity end to end`.

### Task I2: Whole-branch review

> ⚠ NEVER delete directories anywhere in the repo (no `Remove-Item -Recurse`, `rm -rf`, `rmdir /s`, `git clean -fdx`) — worktrees hold node_modules junctions into the shared install.

- [ ] **Step 1:** Dispatch a fresh reviewer (opus) with the spec, this plan and `git diff main...feature/news-context-v3`. Checklist: (1) no file under `sentinel-executor/`, `exit-discipline/`, `trade-engine/`, `trade-core/`, `auto-trade/` changed (`git diff --stat main... -- <those dirs>` empty); (2) the safety spec and the cycle reachability walk are green and not weakened; (3) every `news.*` LLM call goes through `NewsLlmClient` (grep for `callWithMeta(`/`messages.create(` under `news-events/` and `night-jobs/`: only `news-llm.client.ts`; the dev labeller script is outside `src/`); (4) no `RegExp(` built from a rule pattern or LLM text (grep `new RegExp(` in `news-events/rules`, `curator`, `profiles`); (5) packet path: no `await` on the v3 news path in `context-packet.service.ts`, `tick-source.adapter.ts`; (6) `newsIgnored` is read nowhere except `sentinel-cycle.service.ts::recordNewsIgnored` and the feedback service; (7) golden snapshot diff vs the Foundation tip is additions-only; (8) Review Focus 1–5 tests exist and pass; (9) logs follow the Global Constraints prefixes; (10) Open Questions answered or defaulted.
- [ ] **Step 2:** Fix findings in place (targeted tests per fix, full suite once at the end, `--maxWorkers=2`), commit `fix(news-context): review findings`.

---

## Production Gate

Nothing here is done by an agent; the coordinator prepares, the owner runs.

**Env (`api.env` on the VPS) — staged by milestone:**

| Milestone | `NEWS_EVENTS_V2_ENABLED` | `NEWS_CONTEXT_V3` | `NEWS_CURATOR_MODE` | Notes |
|---|---|---|---|---|
| M1 deploy | `observe` (as today) | `false` | `off` | §5 rules + TAG_VERSION 2 improve v2 observe; nothing else moves |
| M2 | `observe` | `observe` | `off` | profiles + matcher, shadow in `newsShadow.v3` |
| M3 | `observe` | `observe` | `propose` | audit + stats + curator proposals (2 nights, P7) |
| M4 | `observe` | `observe` | `auto` | auto with morning summary (code still enforces the 2 propose nights) |
| M5 (owner, P11 met) | `true` | `true` | `auto` | owner's shadow sentinel only; stamp `v9+n3/t1` (cues on) |

Caps stay at their defaults (`NEWS_LLM_NIGHT_MAX_CALLS=40`, `NEWS_LLM_NIGHT_MAX_INPUT_TOKENS=400000`, `NEWS_PROFILE_MAX_BUILDS_PER_DAY=20`, `NEWS_PROFILE_REFRESH_DAYS=90`). `AI_CLI_CONCURRENCY ≥ 3` (gateway note) before M2. `NEWS_EVAL_SET_PATH` only if the image does not carry `apps/api/src/…/__fixtures__/eval/`.

**M0 (owner, before M1):**
1. `READONLY_DATABASE_URL=… npx tsx apps/api/scripts/news-eval-export.ts --days 7 --total 1000 --out <dir>` (read-only role).
2. On the developer machine: `npx tsx apps/api/scripts/news-eval-label.ts …` (dev CLI, not the prod account — P6); spot-check 50 lines; commit `headlines-2026-10.jsonl`.
3. On the Foundation-tip build (v2 as deployed): `npx tsx apps/api/scripts/news-eval-report.ts --write-baseline`; commit `baseline-v2.json`.
4. `npx tsx apps/api/scripts/mcx-master-snapshot.ts` against prod (read-only) → commit the refreshed `mcx-master-names.json`; the completeness spec must stay green (if a new name appears, add its mapping before M1).

**Migration checks (M1 deploy):** `npx prisma migrate deploy` applies only `20261017120000_news_context_v3`; then `\d news_articles` shows `ruleSetVersion integer not null default 0` and `drivers text[]`; the five new tables exist and are empty; `SELECT count(*) FROM news_articles WHERE "ruleSetVersion" <> 0` = 0 before boot.

**Logs to watch:**
- M1: `[news-ctx] v3=false (idle) curator=off caps=…`; `[news-rules] active rule set v0 (0 rules)`; `[news-tag] re-tagged N article(s) from the last 48 h to v2`; NO `[news-tag] MCX underlying without keyword set` line; `[news-source] … DOWN` as before.
- M2: `[news-ctx] v3=observe (computing)`; `[news-match] watched=… profiles llm a/baseline b …`; `[news-profile] built …` (≤ 20/day); `[news-shadow] … v3 headlines=… dropped=…`; zero `newsIgnored` lines (the judge sees nothing new).
- M3/M4: `[night-job] news.audit <date> done …` (≤ 15 calls), `[night-job] news.curate …`, one `[news-curator] <date> propose|auto: …` line per night, `[news-llm] breaker OPEN …` must be rare (if it opens, the judge's account hit its limit — check the runbook §3 before anything else).
- M5: stamp `v9+n3/t1` on new verdicts; `[news-feedback] judge rows …`; `sentinel agent: newsIgnored ignored (…)` count stays low.

**Flip criteria (P11, M4 → M5):** on the labelled set with the current tagger + profiles (`news-eval-report.ts`): open-position relevance precision ≥ 95 % AND company recall ≥ 85 %; plus ≥ 2 auto nights with no rollback; no breaker opened by `news.*` in the last 3 nights; the M2 shadow shows `dropped` > 0 on at least one real position (P2 is doing work) and no packet-time error lines.

**Rollback (fastest first):**
1. Judge-visible v3: `NEWS_CONTEXT_V3=false` (or `observe`) + restart — packets/prompt/stamp return to v2-true byte-for-byte.
2. Night jobs: `NEWS_CURATOR_MODE=off` (curator), or `NEWS_CONTEXT_V3=false` (all night jobs and the matcher).
3. A bad rule set: `POST /api/admin/news-tag-rules/rollback` (owner) — or SQL `UPDATE news_tag_rule_sets SET active = (version = <parent>);` (`<parent>` from `SELECT "parentVersion" FROM news_tag_rule_sets WHERE active`); the rules service notices within 5 min, reloads and re-tags 48 h.
4. TAG_VERSION 2 tagging itself (code): redeploy the previous image; rows keep their v2 tags until the old code's boot re-tag (it only re-tags `tagVersion < 1`, so v2-stamped rows stay as they are — acceptable, the v2 packet is not live).
5. The migration is expand-only: never roll it back.

---

## Open Questions (each has a default; the plan builds the default)

1. **Live matching on titles only** (the bus carries no summary). *Default: title only;* revisit if the audit's "dropped/missed" rows show > 5 % summary-only mentions.
2. **Night schedule days.** *Default: Tue–Sat 00:30/01:15/02:30 IST (Mon–Fri trading nights), `nightOf` = the evening's IST date;* alternative: also Sunday 00:30 for Saturday's MCX-less news.
3. **Breaker default when the limit reply carries no reset time.** *Default: 5 h;* alternative: until the next 07:30 IST.
4. **Word-list licences.** *Default: only PD/CC0/MIT/Apache-2.0/CC-BY-4.0 lists (GeoNames CC-BY-4.0 for places);* if an English or Indian-names list exists only under share-alike, the agent stops and asks.
5. **`newsShadow.v3` refs also in `true` mode** (needed by the audit). *Default: yes (`{v3: {refs, dropped}}`).*
6. **Index constituents refresh.** *Default: monthly by hand, boot warning after 45 days.*
7. **ALL-CAPS tickers exempt from needs-context.** *Default: yes.*
8. **`source_drop` and the curator mode.** *Default: follows the mode (proposed in `propose`, applied in `auto`).*

---

## Self-Review (planner)

- **Spec coverage:** §1 cases → R1 (HDFC Life), R2 (SHAH), R3 (BoE), R4 (Houthi, 9 MCX gaps), N4 (ET Auto); §2 goals → S3/S4 (live, ~1 ms), N3–N5 (logging), N6/N7 (curator), S1/S4/S5 + I1 Step 5 (flag-off identity); §4 → P1–P5, S3/S4; §5 → R1–R4; §6 → R5/R6; §7 → S2/S4 + N3; §8 → S1/S2/S5; §9 → N1–N7 (+ P3 prebuild); §10 → E1–E4 + Gate M0; §11 → N1 (caps/breaker/estimate), Global Constraints; §12 → F3; §13 → F2 safety spec + I2; §14 → F1; §15 → tests named in each task; §16 → Production Gate; §17 → Owner Decisions; §18 → R3 (market), R2 (word lists), Gate (P11), S3 (profile-confirmed rung), "differs" 15.
- **Placeholders:** service-level specs list their cases by name with the exact assertion in the title where the setup is mechanical (fake Prisma rows); every Review Focus case has full test code.
- **Type consistency:** names in the Interfaces table are the ones the tasks use (`layeredHeadlinesV3`, `newsBlocksV3`, `newsRefsOf`, `compileProfiles`, `createCandidateRelevance`, `NewsLlmClient`, `NightJobRunner`, `RuleSetAdmin.createRuleSet/propose/rollback`, `RetagService.retagWindow`).
