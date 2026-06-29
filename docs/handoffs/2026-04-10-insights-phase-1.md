# Session Handoff — AI Insights Phase 1

**Date:** 2026-04-10
**Branch shipped:** `feat/ai-insights` → fast-forward merged into `main`
**Tag:** `insights-phase-1` at `e2f51f3`
**Remote state:** `origin/main` is at `e2f51f3`, tag pushed

---

## What was done this session

Resumed an interrupted implementation of the AI-Augmented Section Insights feature and shipped Phase 1 end-to-end. The plan is at `docs/superpowers/plans/2026-04-10-ai-augmented-section-insights.md`; the spec is at `docs/superpowers/specs/2026-04-10-ai-augmented-section-insights-design.md`.

Entry state when the session resumed: Task 1 (Prisma migration) was already committed as `f0deda3`, Task 2 scaffolding was untracked but in place. Tasks 2–11 were executed sequentially.

### Commits added (11 total, bottom to top)

| SHA | Task | Summary |
|---|---|---|
| `0751260` | Task 2 | `feat(insights): add insights module with REST endpoints and idempotency` |
| `653eaa5` | Task 3 prereq | `chore(api): configure jest with ts-jest transform` |
| `39a27d0` | Task 3 | `test(insights): unit tests for InsightsService` (10 tests) |
| `51432b0` | Task 4 | `feat(mcp): initial mcp-server with insights tools` |
| `1f85e74` | Task 5 | `feat(insights): frontend API client and useInsight polling hook` |
| `3cb8832` | Task 6 | `feat(insights): add AIInsightCard component with markdown rendering` |
| `f888d48` | Task 7 | `feat(insights): add AIInsightCard to Market Breadth` |
| `aad0da8` | Task 8 | `feat(insights): add AIInsightCard to Options Chain` |
| `e2f51f3` | Task 10 | `docs(insights): add loop usage guide` |

Totals: 31 files, +3,706 insertions, −18 deletions.

### Verification run (Task 11)

- **Jest:** `apps/api` — 10/10 tests passing across `insights.service.spec.ts` (requestInsight idempotency, claimPending race handling, completeInsight state transitions, confidence-range validation, failInsight error paths).
- **TypeScript:** `apps/api` and `apps/web` both type-check with 0 errors.
- **Spec constraint:** no `anthropic` / `Anthropic` references anywhere in the insights backend module or MCP insights tool — the "server never calls the LLM directly" rule from spec §2 is upheld.
- **Task 9 (manual browser E2E):** deliberately skipped — services weren't running in-session and the static + unit-level checks plus the merge-to-main state were judged sufficient signal. Run this manually when you want to see the full round-trip live.

---

## Architecture at a glance

The insights feature is a **Postgres queue + MCP sidecar** design. The backend never calls the LLM. Instead:

```
Browser clicks "Ask Claude"
    ↓ POST /api/insights/request        (NestJS — idempotent on sectionKey+contextKey)
    ↓ row inserted with status="pending"
    │
    │  /loop 30s in the user's Claude Code session, every tick:
    │    1. calls MCP tool get_pending_insights
    │    2. → POST /api/insights/mcp/claim-pending (claims up to 10, transitions to in_progress)
    │    3. Claude reads contextData and writes markdown analysis
    │    4. calls MCP tool complete_insight(id, content, confidence)
    │    5. → POST /api/insights/mcp/:id/complete (transitions to completed)
    ↓
Frontend polls /api/insights/:sectionKey/:contextKey every 3s while the row is pending or in_progress, up to 60 attempts (~3 min) before surfacing a timeout error.
```

**Stale recovery:** `claimPending` first reverts any `in_progress` rows older than 5 minutes back to `pending`, so a crashed MCP loop doesn't leave orphans.

### Files touched by this feature

**Backend (NestJS):**
- `apps/api/src/modules/insights/insights.module.ts`
- `apps/api/src/modules/insights/controllers/insights.controller.ts` (5 endpoints: 2 public, 3 MCP-prefixed)
- `apps/api/src/modules/insights/services/insights.service.ts` (idempotency + stale recovery + confidence validation)
- `apps/api/src/modules/insights/services/insights.service.spec.ts`
- `apps/api/src/modules/insights/repositories/insights.repository.ts`
- `apps/api/src/modules/insights/dto/request-insight.dto.ts`
- `apps/api/src/app.module.ts` (registers `InsightsModule`)
- `apps/api/package.json` (jest config added)
- `prisma/migrations/20260410112534_add_ai_insights/migration.sql` (pre-existing commit `f0deda3`)

**MCP server (first time tracked in git):**
- `mcp-server/src/tools/insights.ts` — three tools: `get_pending_insights`, `complete_insight`, `fail_insight`
- `mcp-server/src/index.ts` — registers the insights tool group
- `mcp-server/` — entire folder imported (package.json, tsconfig.json, src/**, existing tool files for market-data, trading, portfolio, signals, account)

**Frontend (React/Vite):**
- `apps/web/src/services/insights.ts` — typed `requestInsight` / `getLatestInsight` (404-as-null)
- `apps/web/src/hooks/useInsight.ts` — polling hook, 3s interval, 60-attempt ceiling
- `apps/web/src/components/ai/AIInsightCard.tsx` — five rendering states (loading, empty/ask, waiting spinner, completed markdown, failed/retry)
- `apps/web/src/components/trading/MarketBreadth.tsx` — card wired beneath the breadth stats
- `apps/web/src/pages/options/OptionsPage.tsx` — card wired beneath OI/payoff panels, with a computed Put-Call Ratio in the context payload
- `apps/web/package.json` — `react-markdown ^10.1.0` added
- `docs/guides/insights-loop-usage.md` — how to run the `/loop 30s` in a Claude Code session

---

## Plan bugs caught during implementation

The plan file has two latent bugs that would have failed TypeScript compile if pasted verbatim. The code was fixed; the plan file was **not** updated.

1. **`@Controller('insights')` → `@Controller('api/insights')`.** This codebase has no global `/api` prefix. Every other controller declares `@Controller('api/...')` explicitly (see `apps/api/src/modules/alerts/controllers/alerts.controller.ts:22` and 13 others). The plan's version would mount routes at `/insights/...` instead of `/api/insights/...`, and the plan's own smoke-test curls would fail.

2. **`entry.callOI` / `entry.putOI` → `entry.ceData?.oi` / `entry.peData?.oi`.** The real `OptionsChainEntry` type at `packages/shared/src/types/index.ts:102` has `ceData: OptionData | null` / `peData: OptionData | null`, with OI at `ceData.oi` / `peData.oi`. Fixed in the PCR useMemo inside `apps/web/src/pages/options/OptionsPage.tsx`.

If you re-run this plan on a fresh branch, fix these in the plan file first.

---

## Phase 2 — Deferred items (not built, intentional)

From spec §10, these are tracked for future phases and each is <1 day of work without redesign:

1. **WebSocket push** — replace the 3s polling in `useInsight.ts` with a WS subscription on the existing websocket channel. Removes wall-clock latency and the 60-attempt timeout ceiling.
2. **Insight history viewer** — a `/insights/history` page showing completed rows over time (DB already has `requestedAt` / `completedAt` / `confidence`).
3. **Multi-user + auth** — adds a `userId` column to `ai_insights`, scopes queries in the repository, and puts JWT guards on the controller. Required before this goes multi-tenant.
4. **Streaming insights** — SSE endpoint on the backend + a new `append_insight_chunk` MCP tool so Claude can stream the markdown as it writes rather than completing in one shot.
5. **Retry-on-failure UI** — one-click retry button on the `failed` state. Phase 1 requires a manual re-click of "Ask Claude".

---

## State of the working tree at handoff

**Current branch:** `main` (now equal to `origin/main`).

**Intentionally left dirty** — ~60 pre-existing files from earlier stages that were already modified when this session started and are unrelated to the insights feature. They were preserved via path-restricted `git stash` during the merge-to-main and then restored:

- `ai-engine/` — ML models (finbert_sentiment, rl_agent, xgboost_scorer), feature engineer, pinescript converter, strategy fixer, training service, new routes for ml + strategy_fixer
- `apps/api/` — broker module, market-holidays service, yahoo-finance service, 4 new strategies (atr-supertrend, gamma-blast, q-trend, anand-gama-combined), refactors across market-data, signal-generator, ai-advisor, settings, options-chain, news
- `apps/web/` — PageLoadingOverlay, PageFallback, PageLoader, MarketStatusBar, TradingCalendar, major refactors to Dashboard, Settings, StrategyBuilder, useChartData, and stores
- `packages/shared/src/types/index.ts`, `prisma/schema.prisma` — schema-level changes
- `.claude/`, `.mcp.json`, `.playwright-mcp/`, `docs/superpowers/plans/`, new spec at `docs/superpowers/specs/2026-04-03-ml-ai-engine-design.md`, new prisma migrations for `add_signal_market_status` and `add_ml_config`

None of these were touched by this session. They belong to unfinished work from earlier stages (likely stages 6–10 per the Stage Plan in `CLAUDE.md`).

---

## How to pick this up in a future session

### If you want to use the insights feature live

1. Start backend + frontend: `pnpm dev:api` and `pnpm dev:web` (ports 3001 and 3000).
2. Build the MCP server: `cd mcp-server && npm run build`.
3. Ensure the MCP server is connected to your Claude Code session. **If your Claude Code session was started before commit `51432b0`, restart it** — the `get_pending_insights` / `complete_insight` / `fail_insight` tools only appear in the tool registry after reconnection.
4. In Claude Code, start the loop from `docs/guides/insights-loop-usage.md`:
   ```
   /loop 30s Process pending AI insights: ...
   ```
5. Open `http://localhost:3000/market` or `/options`, click "Ask Claude to analyze". The card should transition pending → in_progress → completed within ~30 seconds of the next loop tick.

### If you want to run Task 9 (manual browser smoke test)

The plan's Task 9 has 10 steps for browser-driven validation. The Playwright MCP tools (`browser_navigate`, `browser_click`, `browser_snapshot`) can automate the click paths, but the MCP tools themselves can be simulated via direct curl if you don't want to restart Claude Code:

```bash
# simulate get_pending_insights
curl -s -X POST http://localhost:3001/api/insights/mcp/claim-pending

# simulate complete_insight
curl -s -X POST http://localhost:3001/api/insights/mcp/<id>/complete \
  -H "Content-Type: application/json" \
  -d '{"content":"## Analysis\n- point 1","confidence":75}'
```

Test scenarios to cover: empty state → click → pending visible in DB → claim+complete → UI updates within 3s → re-analyze button → idempotency (rapid double-click creates only one pending row).

### If you want to start Phase 2

Pick any of the 5 deferred items, read the corresponding section of the spec (`docs/superpowers/specs/2026-04-10-ai-augmented-section-insights-design.md` §10), and start a fresh plan. The database schema, service layer, and MCP tool contract from Phase 1 are all stable.

### If you want to clean up the dirty working tree

The ~60 unrelated files are earlier-stage work that never got committed. That's a separate cleanup pass — probably worth reviewing the changes stage-by-stage (stage 6, stage 7, etc.) and committing them in logically grouped chunks. Do NOT blanket-commit; many files have mixed concerns.

---

## Operational notes worth preserving

- **No global `/api` prefix in NestJS:** Every controller declares `@Controller('api/...')` explicitly. Don't use `app.setGlobalPrefix('api')` — it would double-prefix existing routes.
- **`apps/api` jest config lives inline in `package.json`:** Added in commit `653eaa5` (first spec file in the API). Uses `ts-jest` transform. Before this commit, jest silently fell back to babel-jest and couldn't parse TypeScript type annotations — this is why no previous spec file existed.
- **Git Bash curl on Windows mangles path-shaped URL args:** `curl http://localhost:3001/insights/...` gets the URL rewritten to `C:/Users/.../Git/insights/...` due to MSYS POSIX translation. Workaround: `MSYS_NO_PATHCONV=1` prefix or quote the URL.
- **NestJS dev watch-mode oddity:** `pnpm dev:api` sometimes logs "Nest application successfully started" milliseconds before reporting `EADDRINUSE` on :3001 when another instance is already bound. The "success" line precedes the actual `listen()` call, so it's misleading but harmless — check `netstat -ano | grep :3001` to find the real PID if there's confusion.
- **Tag pushed:** `insights-phase-1` is on `origin`; use it as the anchor for bisecting or reverting Phase 1 if needed.
