# TDA-006 — IP / Provenance Boundary — Design Spec

**Doc ID:** TDA-006
**Date:** 2026-06-28 (rev. 2026-06-29 after code mapping)
**Sprint:** S3 (IP Boundary & Product Surface) — MVP
**Depends on:** TDA-001 (data model), TDA-003 (RBAC `@AdminOnly`, `@CurrentUser`, `req.user.role`)
**Blocks:** TDA-007 (user surface), TDA-010 (fan-out)
**Owner:** development@panamoure.com

---

## 1. Goal

Make it **structurally impossible** for a non-ADMIN user to receive signal
provenance — the **scanner name, the score breakdown, lead counts, and
trailing/exit-reason logic** that constitute the product's IP/moat. The product
surface (Intraday/Swing) goes through one outbound serializer that allowlists
public fields; CI fails if provenance ever appears in a USER payload.

This is the security wall. TDA-007 (nav/route hiding + UI) is UX on top of it —
hiding a column is not protection; this spec is the protection.

## 2. Background — where provenance actually lives (corrected after code map)

The user-facing **Intraday** and **Swing** sections are **not** fed by the
generic `Signal` table. They are the **anand-dual-track** entries:

- `IntradayPage` → `useIntradayEntries` → `GET /api/anand/intraday/entries` +
  `/api/anand/intraday/pnl-summary`
- `SwingPage` → `useSwingEntries`/`useSwingExits`/`useSwingOpenBook`/… →
  `GET /api/anand/swing/*`

Both return `AnandEntry` (frontend `apps/web/src/services/anand.ts`), whose
fields split into public vs IP:

| `AnandEntry` field | Class | Public DTO? |
|---|---|---|
| `id`, `symbol`, `token`, `entryPrice`, `enteredAt`, `targetPct`, `stopPct`, `status`, `exitPrice`, `exitedAt`, `currentPrice`, `pnlPct`, `targetLeftPct`, `priceStale` | public product data | ✅ |
| `scannerName` | **IP** — which Chartink scanner fired it | ❌ forbidden |
| `scoreBreakdown` (`{name,points,pointsPossible,passed}[]`) | **IP** — the scoring model | ❌ forbidden |
| `leadCount`, `leadDates` | **IP** — repeat-signal intelligence | ❌ forbidden |
| `trailing`, `exitReason` (`TRAIL_ST`/`TRAIL_GB`) | **IP** — exit/trailing strategy | ❌ forbidden |

The backend source rows are `IntradayEntry`/`SwingEntry`
(`prisma`, via `apps/api/src/modules/anand-dual-track/`); the controller resolves
`scannerName` from `alertId` and attaches `scoreBreakdown`. Today the anand
controller returns these **raw to every authenticated user** (no role check, no
DTO).

Separately, the generic `Signal` machinery is **ADMIN territory** (the "Signals",
"Rejections", "Chartink" cockpit pages) and has its own leaks:
- REST `@Controller('api/signals')` returns the **raw Prisma `Signal`** (incl.
  `strategy`, `reason`, `setupContext`, `confidence*`) to any authenticated user;
  `enrichWithChartinkSource` even adds a `chartinkSource` field.
- `signal.gateway.ts` is a **WebSocket with no handshake auth** that
  `this.server.emit('new-signal', signal)` — broadcasts the **entire raw signal**
  to **every** connected socket. (CORS `origin:'*'`; the HTTP `JwtAuthGuard` does
  not apply to WS.)

## 3. The boundary — `toPublicEntry()` (USER product feed)

A single pure serializer is the **only** sanctioned way to emit an anand entry
to a non-ADMIN consumer.

**Location:** `apps/api/src/modules/anand-dual-track/dto/public-entry.dto.ts`

**Allowlist (exact output shape):**
```ts
export interface PublicAnandEntry {
  id: string;
  symbol: string;
  segment: 'INTRADAY' | 'SWING';   // stamped by which controller/track served it
  entryPrice: number;
  enteredAt: string;               // ISO
  targetPct: number;               // 5 (intraday) / 10 (swing) — product param, public
  stopPct: number;
  status: string;                  // OPEN/TRADED/TARGET_HIT/STOPPED/EXPIRED etc.
  exitPrice: number | null;
  exitedAt: string | null;
  currentPrice: number | null;
  pnlPct: number | null;
  targetLeftPct: number | null;
  priceStale: boolean;
}
export function toPublicEntry(row: AnandEntryLike, segment: 'INTRADAY'|'SWING'): PublicAnandEntry
```
- **Allowlist-by-construction:** builds a fresh object literal from named fields.
  Never spreads (`...row`), never returns the source object. A new column on
  `IntradayEntry`/`SwingEntry` cannot leak.
- It is the only outbound path that may read `scannerName`/`scoreBreakdown`/
  `leadDates`/`exitReason` — and it reads them **only to drop them**.
- `segment` is set by the serving endpoint (`/anand/intraday/*` → `INTRADAY`,
  `/anand/swing/*` → `SWING`); not derived/guessed.

### 3.1 Where it is applied
- The anand controller’s USER-reachable list/pnl endpoints return
  `PublicAnandEntry[]` when `req.user.role !== 'ADMIN'`, and the raw rows
  (current behavior) when `role === 'ADMIN'`. ADMIN sees provenance; USER never
  does. (Same controller, role-branched serialization — not a forked endpoint.)

## 4. Route gating — provenance is ADMIN-only

Using the existing `@AdminOnly()` + `RolesGuard` (TDA-003):
- `@Controller('api/signals')` (entire controller — `listSignals`, `getActiveSignals`,
  `getSignalById`, `strategies`, scan/analyze/indicators, `strategies/:name/performance`,
  delete) → `@AdminOnly()` at the class level.
- Chartink + Rejections controllers (the scanner provenance) → `@AdminOnly()`.
- The anand controller stays reachable by USERs (it serves the product) but
  serializes via §3; its raw-provenance shape is ADMIN-only.
- A USER hitting any ADMIN-only provenance route gets **403** (RolesGuard), not a
  body.

### 4.1 WebSocket (`signal.gateway.ts`)
- Authenticate the handshake: read the JWT from `client.handshake.auth.token`
  (or `Authorization` header), verify with the same `JWT_SECRET`/`HS256`/
  audience `td-access` as `JwtStrategy`, attach `{ userId, role }` to the socket.
- On connect, **reject (disconnect) non-ADMIN sockets** — the generic signal
  stream is ADMIN-only (USER Intraday/Swing pages poll `/api/anand/*`, they do
  not consume this WS). Unauthenticated sockets are disconnected.
- This closes the "raw signal broadcast to everyone" hole without needing a
  public signal DTO. (If a USER live-feed is wanted later it gets `toPublicEntry`
  + rooms — out of scope here.)

## 5. Log redaction

- A `redactProvenance(obj)` helper strips `scannerName`, `scoreBreakdown`,
  `leadCount`, `leadDates`, `trailing`, `exitReason` (anand) and `strategy`,
  `reason`, `setupContext`, `confidence`, `confidenceScore` (signal) before any
  request/response log that includes entry/signal data in a USER-context path.
- Engine-internal ADMIN logs may retain provenance (the engine needs it).
  Tamper-evident audit redaction is TDA-008.

## 6. The CI guard (regression lock)

A test that **fails the build** if provenance escapes the USER path:
- Build an `AnandEntry`-like fixture whose IP fields hold sentinels
  (`scannerName:'__LEAK_scanner__'`, a `scoreBreakdown`, `exitReason:'TRAIL_ST'`,
  `leadDates:[…]`).
- Assert `JSON.stringify(toPublicEntry(fixture,'INTRADAY'))` contains **none** of
  the forbidden keys or sentinel values.
- Assert the output key set **equals** the allowlist exactly (catches a new field
  being added to the DTO).
- Endpoint test: USER token → `GET /api/signals` returns 403; USER token →
  `GET /api/anand/intraday/entries` payload contains no forbidden key; ADMIN →
  full data.

## 7. Out of scope (deferred)

- ADMIN provenance *viewer* UI — only gating here.
- Tamper-evident audit redaction — TDA-008.
- Subscription/plan gating of the anand endpoints — **TDA-007** (this spec only
  sanitizes shape + gates provenance routes; TDA-007 adds the plan gate).
- A sanitized USER live WS feed — not needed (USER pages poll).

## 8. Acceptance criteria

1. `toPublicEntry()` exists, is allowlist-by-construction, and is the only
   outbound anand-entry serializer for non-ADMIN responses.
2. USER → `/api/signals/*`, `/api/chartink/*`, rejections routes all 403;
   ADMIN → 200 with full data.
3. USER anand payloads (intraday + swing list/pnl) contain none of:
   `scannerName`, `scoreBreakdown`, `leadCount`, `leadDates`, `trailing`,
   `exitReason`.
4. `signal.gateway` rejects unauthenticated and non-ADMIN sockets; no raw signal
   is emitted to a non-ADMIN socket.
5. CI test fails if any forbidden key/sentinel appears in a USER payload or the
   `PublicAnandEntry` key set drifts from the allowlist.

## 9. Test plan

- **Unit:** `toPublicEntry` allowlist + sentinel-leak + exact-keyset tests.
- **Integration (`apps/api/test/tda006/`):** class-level `@AdminOnly` on the
  signals controller (USER 403 / ADMIN 200); anand endpoints role-branch
  (USER→`PublicAnandEntry`, ADMIN→raw); WS handshake auth (no token → disconnect,
  USER token → disconnect, ADMIN token → connected). Reuse the tda003 Style-A
  HTTP harness (boot a focused module, mint JWTs with `audience:'td-access'`).
- **Regression:** the CI guard test in §6.
