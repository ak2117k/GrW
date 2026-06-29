# AI-Augmented Section Insights — Design Spec

> Status: Draft — pending user review
> Date: 2026-04-10
> Author: Aryan Kumar (with Claude Code)
> Phase: 1 of 3

## 1. Goal

Add per-section AI analysis to the TD Automation web app. Users click an "Ask Claude" button on a section card (e.g. Market Breadth on `/market`), and within ~30 seconds the section displays a Claude-authored interpretation of the underlying data (sector rotation, A/D implications, best option strikes by Greeks, etc.).

**Phase 1 scope (this spec):**
- `Market Breadth` card on `/market`
- `Options Chain` table on `/options`

**Non-goals for Phase 1:** see §10.

## 2. Hard Constraint — No External LLM API Calls

The backend must not import the Anthropic SDK, must not hold an Anthropic API key, and must not make any HTTP request to `api.anthropic.com` or any other LLM provider. **All Claude work happens inside the user's existing Claude Code session via MCP tool calls.** Token cost comes out of the user's Claude Code subscription, not metered API usage.

This is a non-negotiable architectural constraint. Any future PR that introduces a server-side LLM call must be rejected at review.

## 3. Architecture

```
┌──────────┐  click "Ask Claude"   ┌──────────────┐  insert pending row  ┌────────────┐
│  Browser │ ────────────────────► │  NestJS API  │ ───────────────────► │  Postgres  │
│          │ ◄──────────── poll ── │              │ ◄── update insight ──│ ai_insights│
└──────────┘   GET latest insight  └──────────────┘                      └────────────┘
                                          ▲                                     ▲
                                          │ MCP                            MCP  │
                                          │                                     │
                                  ┌───────┴─────────────────────────────────────┴────┐
                                  │  Claude Code session running /loop 30s            │
                                  │  (no daemon, no external API)                     │
                                  └───────────────────────────────────────────────────┘
```

**The bridge between the web button and Claude is a Postgres queue plus a `/loop` command in Claude Code.** When the user starts a trading session, they run `/loop 30s process pending insights` once. Every 30 seconds, the loop wakes Claude, who calls `get_pending_insights()` via MCP, processes any pending rows, and writes results back via `complete_insight()`. When the user closes Claude Code, the loop stops and pending requests sit in the queue until the next session.

## 4. Data Model

One new Prisma model. No changes to existing tables.

```prisma
model AIInsight {
  id            String    @id @default(cuid())
  sectionKey    String    // "market-breadth" | "options-chain"
  contextKey    String    // disambiguator within a section
                          //   - market-breadth: "default"
                          //   - options-chain: "{underlying}:{expiry}" e.g. "NIFTY:2026-04-24"
  status        String    // "pending" | "in_progress" | "completed" | "failed"
  contextData   Json      // Snapshot of inputs at request time (see §6 for shape)
  insight       String?   // Claude's analysis as markdown
  confidence    Int?      // 1-100
  errorMessage  String?
  requestedAt   DateTime  @default(now())
  startedAt     DateTime?
  completedAt   DateTime?

  @@index([sectionKey, contextKey, status])
  @@index([status, requestedAt])
  @@map("ai_insights")
}
```

**Lifecycle:** `pending` → `in_progress` (claimed by `get_pending_insights`) → `completed` or `failed`.

**Stale recovery:** Any row in `in_progress` for more than 5 minutes is automatically reverted to `pending` by the loop on its next iteration. This handles the case where Claude crashes or the session is killed mid-analysis.

## 5. Backend — `insights` Module

New NestJS module at `apps/api/src/modules/insights/`. Standard module shape:

```
insights/
├── controllers/
│   └── insights.controller.ts    # REST endpoints
├── services/
│   └── insights.service.ts       # Business logic + queue ops
├── repositories/
│   └── insights.repository.ts    # Prisma data access
├── dto/
│   ├── request-insight.dto.ts
│   └── insight-response.dto.ts
└── insights.module.ts
```

### REST Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/insights/request` | Browser creates a new insight request. Body: `{ sectionKey, contextKey, contextData }`. **Idempotent**: if a row with the same `(sectionKey, contextKey)` already exists in `pending` or `in_progress`, returns that row instead of creating a new one. Returns the row id. |
| `GET` | `/api/insights/:sectionKey/:contextKey` | Browser polls this. Returns the latest row (any status) for that key, or 404 if none exists. |
| `POST` | `/api/insights/:id/retry` | Phase 2. Not built in Phase 1. |

### MCP Tools (new — added to mcp-server)

| Tool | Behavior |
|---|---|
| `get_pending_insights()` | Returns up to 10 rows where `status='pending'`, ordered by `requestedAt ASC`. Atomically transitions each returned row to `in_progress` and stamps `startedAt = now()`. Also reverts any stale `in_progress` rows (>5 min old) back to `pending` before the read. |
| `complete_insight(id, content, confidence)` | Sets `status='completed'`, `insight=content`, `confidence=confidence`, `completedAt=now()`. Errors if the row is not in `in_progress` (prevents writing to a stale row). |
| `fail_insight(id, errorMessage)` | Sets `status='failed'`, `errorMessage=errorMessage`, `completedAt=now()`. |

### Service Logic — Idempotency

`requestInsight(sectionKey, contextKey, contextData)`:
1. Look for existing row with same `(sectionKey, contextKey)` in `pending` OR `in_progress`.
2. If found: return it (do not create a new row, do not update contextData).
3. If not found: insert new row with `status='pending'`, return it.

This means rapid double-clicks on "Ask Claude" never create duplicate work.

## 6. Context Data Shapes

The `contextData` JSON column shape is per-section. Phase 1 defines two shapes; Phase 2 sections will add more.

### `sectionKey: "market-breadth"`

```typescript
{
  breadth: {
    advances: number;
    declines: number;
    unchanged: number;
    adRatio: number;
  };
  sectorPerformance: Array<{
    sector: string;        // "NIFTY IT", "NIFTY BANK", etc.
    changePercent: number;
    ltp: number;
  }>;
  indexSnapshot: {
    nifty: { ltp: number; changePercent: number };
    bankNifty: { ltp: number; changePercent: number };
  };
  marketStatus: "open" | "closed" | "pre-market";
  capturedAt: string;      // ISO timestamp
}
```

### `sectionKey: "options-chain"`

```typescript
{
  underlying: string;      // "NIFTY" | "BANKNIFTY" | "FINNIFTY"
  expiry: string;          // "2026-04-24"
  spotPrice: number;
  atmStrike: number;
  chain: Array<{
    strike: number;
    callOI: number;
    callIV: number;
    callDelta: number;
    callGamma: number;
    callTheta: number;
    callVega: number;
    callLtp: number;
    putOI: number;
    putIV: number;
    putDelta: number;
    putGamma: number;
    putTheta: number;
    putVega: number;
    putLtp: number;
  }>;
  pcr: number;             // Put-Call Ratio
  maxPainStrike: number;
  capturedAt: string;
}
```

## 7. Frontend — `<AIInsightCard />`

One new component at `apps/web/src/components/ai/AIInsightCard.tsx`. Reused across Phase 1 and Phase 2 sections.

### Props

```typescript
interface AIInsightCardProps {
  sectionKey: string;             // "market-breadth" | "options-chain" | ...
  contextKey: string;             // "default" | "NIFTY:2026-04-24" | ...
  contextData: Record<string, unknown>;  // Snapshot to send when user clicks Ask
  title?: string;                 // Card header, defaults to "AI Analysis"
}
```

### States

| State | UI |
|---|---|
| **No insight yet** | Empty card with "Ask Claude to analyze" button |
| **Pending / in_progress** | Pulsing spinner + "Claude is analyzing..." text. Polls `GET /api/insights/:sectionKey/:contextKey` every 3s |
| **Completed** | Markdown-rendered insight + "Last analyzed: 2 min ago" + "Re-analyze" button |
| **Failed** | Error message + "Try again" button (Phase 1 = manual re-click of Ask Claude) |

### Behavior

1. On mount: `GET /api/insights/:sectionKey/:contextKey` once. If a completed row exists, render it. Otherwise show empty state.
2. On "Ask Claude" click: `POST /api/insights/request` with current `contextData`. Switch to pending state. Start 3s polling.
3. While polling: stop polling immediately when `status` is `completed` or `failed`. Hard cap polling at 3 minutes (60 attempts) — after that, show "Taking longer than usual, please retry" and stop.
4. Markdown rendering: use existing markdown renderer if one is present in the codebase; otherwise add `react-markdown` as a dependency.

### Integrations in Phase 1

| Page | File | Placement |
|---|---|---|
| `/market` | `apps/web/src/pages/market/MarketPage.tsx` | Below the existing Market Breadth stats card. `contextKey="default"`. |
| `/options` | `apps/web/src/pages/options/OptionsPage.tsx` | Below the chain table, inside the per-expiry section. `contextKey="${underlying}:${expiry}"`. |

## 8. The Loop

User runs this once per Claude Code session:

```
/loop 30s process pending insights
```

Each loop iteration is a self-contained workflow Claude executes:

1. Call `get_pending_insights()` (which also reverts stale rows).
2. If empty list: do nothing, wait for next tick. (Cost: ~one MCP tool result, ~200 tokens.)
3. For each pending row, in order:
   - Read `sectionKey` and `contextData`.
   - Branch on `sectionKey`:
     - **`market-breadth`**: Analyze advances/declines, sector rotation, A/D ratio implications. Output 3-6 bullet points: market direction read, sector leadership, what to watch, contradicting signals if any.
     - **`options-chain`**: Analyze the chain — recommend 2-3 best strikes for the current setup, citing gamma exposure, theta cost, IV skew, OI buildup vs spot, ATM/OTM tradeoffs. Note risk caveats.
   - Call `complete_insight(id, markdown, confidence)`.
4. If a step throws: call `fail_insight(id, errorMessage)` and continue with the next row.

**Stop condition:** loop runs until the user closes Claude Code or runs `/cancel-loop` (handled by the loop skill, not by us).

## 9. Phase 1 Deliverables — Build Order

These are the units of work the implementation plan will dispatch in parallel:

1. **Prisma migration** — Add `AIInsight` model + indexes. Generate client. Run migration locally.
2. **Backend `insights` module** — Module + controller + service + repository + DTOs. Wire into `app.module.ts`.
3. **MCP tools** — Add `get_pending_insights`, `complete_insight`, `fail_insight` to `mcp-server/`. Wire into the existing tool registry.
4. **Frontend `<AIInsightCard />`** — Component + markdown rendering + polling hook + states. No section integration yet.
5. **Section integration** — Drop card into MarketPage and OptionsPage with the correct contextData wiring.
6. **End-to-end smoke test** — Manual check: click Ask on /market, run `/loop 30s`, see insight appear within 60s.

## 10. Phase 2 — Committed Backlog

These are intentionally deferred from Phase 1, not abandoned. Each is small and slots cleanly into the architecture above.

| Feature | Slot-in approach |
|---|---|
| **WebSocket push** | Replace 3s polling in `<AIInsightCard>` with subscription to existing market-data gateway. Backend emits `insight:completed` event in `complete_insight` MCP tool handler. |
| **Insight history viewer** | New page `/insights/history` querying `ai_insights` ordered by `completedAt DESC`. Filter by section. Phase 1 already stores every row, so no migration needed. |
| **Multi-user + auth** | Add `userId` column to `AIInsight`, JWT guards on `/api/insights/*` endpoints. App is single-user today, so this is non-blocking until multi-user lands elsewhere. |
| **Streaming insights** | Add SSE endpoint `GET /api/insights/:id/stream`. Frontend subscribes. New MCP tool `append_insight_chunk(id, text)` lets Claude stream output for long-form sections (e.g. Phase 3 dashboard daily narrative). |
| **Retry-on-failure UI** | Add a "Retry" button on the failed state that POSTs to `/api/insights/:id/retry`, which clones the failed row back to `pending` with the same contextData. |

## 11. Phase 3 — Future Sections

After Phase 2 plumbing is in place, these sections each take ~30 minutes to add (just drop in `<AIInsightCard>` with a new sectionKey + add a branch in the loop's switch):

- Signals page — explain why a strategy fired
- Dashboard — daily P&L narrative
- News page — sentiment summary
- Backtest page — strategy critique across regimes
- AI Advisor page — unified ask-anything interface using the same plumbing

## 12. Open Questions

None at design time. All design decisions resolved during brainstorming.

## 13. Risks and Mitigations

| Risk | Mitigation |
|---|---|
| User forgets to start `/loop` and pending requests pile up | Phase 1: visible "pending" state in the card tells them. Phase 2: dashboard widget showing pending count. |
| Loop runs but Claude session is busy with another long task | The loop pauses naturally. Pending rows wait. Stale-row recovery handles `in_progress` rows orphaned >5 min. |
| Claude writes a wrong/dangerous trading recommendation | Insights are advisory only. They never trigger orders. Auto-trade approval flow already requires explicit user confirmation. Insight markdown should always include a disclaimer footer. |
| Polling at 3s creates DB load | Single user, 1-2 cards open at a time = ~1 query/sec. Trivial. Phase 2 WebSocket push removes even this. |
| `contextData` snapshot drifts from live data by the time Claude reads it | By design — Claude analyzes the snapshot as captured at request time. The card shows "Last analyzed: 2 min ago" so the user knows the analysis age. Re-clicking Ask refreshes the snapshot. |

---

*End of spec. Awaiting user review before implementation plan.*
