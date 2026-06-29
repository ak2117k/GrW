# TDA-006 Provenance Boundary — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make it structurally impossible for a non-ADMIN user to receive signal provenance (scanner name, score breakdown, lead counts, trailing/exit-reason), via one allowlist serializer for the Intraday/Swing product feed + ADMIN-gating of the raw signal/chartink/rejections routes + authenticating the signal WebSocket.

**Architecture:** A pure `toPublicEntry()` serializer is the only outbound path for anand entries to a USER; the anand controller role-branches (USER→sanitized, ADMIN→raw). Raw signal/chartink/rejection HTTP routes get `@AdminOnly()`. `signal.gateway` authenticates its WS handshake and drops non-ADMIN sockets. A CI test locks the allowlist.

**Tech Stack:** NestJS 11, Prisma 6 (Postgres `td_saas`), socket.io, Jest + ts-jest. RBAC from TDA-003 (`@AdminOnly`, `RolesGuard`, `@CurrentUser`, `req.user={userId,role,email}`).

## Global Constraints

- **DB:** dev `td_saas`, tests `td_saas_test` (`DATABASE_URL_TEST`). `docker exec td-postgres psql -U postgres`. Never `prisma migrate reset`. **No schema change in this spec.**
- **Commit prefix:** `TDA-006:`. No `.env`. Stage only changed files (no `git add -A`).
- **Forbidden provenance keys (anand):** `scannerName`, `scoreBreakdown`, `leadCount`, `leadDates`, `trailing`, `exitReason`. **(signal):** `strategy`, `reason`, `setupContext`, `confidence`, `confidenceScore`, `chartinkSource`.
- **`PublicAnandEntry` allowlist (exact):** `id, symbol, segment, entryPrice, enteredAt, targetPct, stopPct, status, exitPrice, exitedAt, currentPrice, pnlPct, targetLeftPct, priceStale`.
- **Role rule:** branch on `req.user.role`; `'ADMIN'` → raw (current behavior), anything else → sanitized. Absent/`undefined` role → treat as non-ADMIN (fail closed).
- **Test harness:** reuse the TDA-003 patterns. Run API tests **from `apps/api`**. New tests live in `apps/api/test/tda006/` with a `jest.config.js` mirroring `apps/api/test/tda003/jest.config.js` (roots → `test/tda006`, otplib stub mapped). Run: `npx jest --config test/tda006/jest.config.js -v` (prefix `DATABASE_URL_TEST=...` for DB-backed specs).

---

## File Structure

- `apps/api/src/modules/anand-dual-track/dto/public-entry.dto.ts` — **create.** `PublicAnandEntry` type + `toPublicEntry(row, segment)` + the forbidden-key list constant.
- `apps/api/src/modules/anand-dual-track/controllers/anand-dual-track.controller.ts` — **modify.** Inject `@CurrentUser()`; role-branch `listIntraday`/`listSwing`/`listSwingExits`.
- `apps/api/src/modules/signal-generator/controllers/signal-generator.controller.ts` — **modify.** Add class-level `@AdminOnly()`.
- `apps/api/src/modules/chartink/controllers/*.controller.ts` + rejections controller — **modify.** Class-level `@AdminOnly()` (keep the public webhook `@Public()` — see Task 3).
- `apps/api/src/modules/signal-generator/gateways/signal.gateway.ts` — **modify.** Authenticate handshake, drop non-ADMIN.
- `apps/api/src/common/log/redact-provenance.ts` — **create.** `redactProvenance(obj)` helper.
- `apps/api/test/tda006/` — **create.** `jest.config.js`, `otplib.stub.js` (copy from tda003), `public-entry.spec.ts`, `provenance-routes.spec.ts`, `signal-gateway-auth.spec.ts`.

---

### Task 1: `toPublicEntry()` serializer + allowlist CI guard

**Files:**
- Create: `apps/api/src/modules/anand-dual-track/dto/public-entry.dto.ts`
- Create: `apps/api/test/tda006/public-entry.spec.ts`
- Create: `apps/api/test/tda006/jest.config.js` (copy of `apps/api/test/tda003/jest.config.js` with `roots` → `<rootDir>/test/tda006`); copy `apps/api/test/tda003/otplib.stub.js` → `apps/api/test/tda006/otplib.stub.js`.

**Interfaces — Produces:**
- `interface PublicAnandEntry { … }` (the 14-key allowlist).
- `function toPublicEntry(row: AnandEntryLike, segment: 'INTRADAY' | 'SWING'): PublicAnandEntry`
- `const ANAND_PROVENANCE_KEYS: readonly string[]` (the forbidden list, exported for the redactor + tests).

- [ ] **Step 1: Write the failing test** — `apps/api/test/tda006/public-entry.spec.ts`:

```ts
import { toPublicEntry, PublicAnandEntry, ANAND_PROVENANCE_KEYS } from '../../src/modules/anand-dual-track/dto/public-entry.dto';

const ALLOWED_KEYS = [
  'id','symbol','segment','entryPrice','enteredAt','targetPct','stopPct',
  'status','exitPrice','exitedAt','currentPrice','pnlPct','targetLeftPct','priceStale',
].sort();

// A raw enriched row as the anand controller would have it: public fields PLUS provenance sentinels.
const rawRow = {
  id: 'e1', symbol: 'TCS', token: '11536', entryPrice: 100, enteredAt: '2026-06-29T04:00:00.000Z',
  targetPct: 5, stopPct: 5, status: 'TRADED', exitPrice: null, exitedAt: null,
  currentPrice: 110, pnlPct: 10, targetLeftPct: 0, priceStale: false,
  // provenance / IP — must NOT appear in output:
  scannerName: '__LEAK_scanner__',
  scoreBreakdown: [{ name: '__LEAK_check__', points: 3, pointsPossible: 5, passed: true }],
  leadCount: 4, leadDates: ['2026-06-01'], trailing: true, exitReason: 'TRAIL_ST',
  alertId: 'al_123',
};

describe('toPublicEntry', () => {
  it('emits exactly the allowlist keys and nothing else', () => {
    const out = toPublicEntry(rawRow, 'INTRADAY');
    expect(Object.keys(out).sort()).toEqual(ALLOWED_KEYS);
  });

  it('stamps the segment from the argument, not the row', () => {
    expect(toPublicEntry(rawRow, 'SWING').segment).toBe('SWING');
  });

  it('contains no provenance key or sentinel value (CI guard)', () => {
    const json = JSON.stringify(toPublicEntry(rawRow, 'INTRADAY'));
    for (const k of ANAND_PROVENANCE_KEYS) expect(json).not.toContain(k);
    expect(json).not.toContain('__LEAK_scanner__');
    expect(json).not.toContain('__LEAK_check__');
    expect(json).not.toContain('TRAIL_ST');
  });

  it('passes through public values', () => {
    const out = toPublicEntry(rawRow, 'INTRADAY');
    expect(out).toMatchObject({ id: 'e1', symbol: 'TCS', entryPrice: 100, targetPct: 5, status: 'TRADED', currentPrice: 110, pnlPct: 10 });
  });

  it('defaults missing optional numerics to null and priceStale to false', () => {
    const out = toPublicEntry({ id: 'x', symbol: 'Y', entryPrice: 1, enteredAt: 't', targetPct: 5, stopPct: 5, status: 'OPEN' } as any, 'INTRADAY');
    expect(out.exitPrice).toBeNull();
    expect(out.currentPrice).toBeNull();
    expect(out.priceStale).toBe(false);
  });
});
```

- [ ] **Step 2: Run → FAIL** (module not found).
Run (from `apps/api`): `npx jest --config test/tda006/jest.config.js public-entry -v`
Expected: FAIL — cannot find `public-entry.dto`.

- [ ] **Step 3: Implement** `apps/api/src/modules/anand-dual-track/dto/public-entry.dto.ts`:

```ts
// The only sanctioned serializer for emitting an anand (Intraday/Swing) entry
// to a non-ADMIN user. Allowlist-by-construction: it builds a fresh object from
// named fields and never spreads the source, so a new column on
// IntradayEntry/SwingEntry can never leak. See TDA-006 spec §3.

export const ANAND_PROVENANCE_KEYS = [
  'scannerName', 'scoreBreakdown', 'leadCount', 'leadDates', 'trailing', 'exitReason',
] as const;

export interface PublicAnandEntry {
  id: string;
  symbol: string;
  segment: 'INTRADAY' | 'SWING';
  entryPrice: number;
  enteredAt: string;
  targetPct: number;
  stopPct: number;
  status: string;
  exitPrice: number | null;
  exitedAt: string | null;
  currentPrice: number | null;
  pnlPct: number | null;
  targetLeftPct: number | null;
  priceStale: boolean;
}

// Loose input — accepts the raw/enriched row shape the controller already builds.
export interface AnandEntryLike {
  id: string; symbol: string; entryPrice: number; enteredAt: string | Date;
  targetPct: number; stopPct: number; status: string;
  exitPrice?: number | null; exitedAt?: string | Date | null;
  currentPrice?: number | null; pnlPct?: number | null; targetLeftPct?: number | null;
  priceStale?: boolean;
  [extra: string]: unknown; // provenance fields may be present — deliberately ignored
}

const iso = (v: string | Date | null | undefined): string | null =>
  v == null ? null : v instanceof Date ? v.toISOString() : v;

export function toPublicEntry(row: AnandEntryLike, segment: 'INTRADAY' | 'SWING'): PublicAnandEntry {
  return {
    id: row.id,
    symbol: row.symbol,
    segment,
    entryPrice: row.entryPrice,
    enteredAt: iso(row.enteredAt) as string,
    targetPct: row.targetPct,
    stopPct: row.stopPct,
    status: row.status,
    exitPrice: row.exitPrice ?? null,
    exitedAt: iso(row.exitedAt),
    currentPrice: row.currentPrice ?? null,
    pnlPct: row.pnlPct ?? null,
    targetLeftPct: row.targetLeftPct ?? null,
    priceStale: row.priceStale ?? false,
  };
}
```

- [ ] **Step 4: Run → PASS.** `npx jest --config test/tda006/jest.config.js public-entry -v`
- [ ] **Step 5: Commit** `TDA-006: toPublicEntry allowlist serializer + CI guard`.

---

### Task 2: Role-branch the anand controller (USER → sanitized)

**Files:**
- Modify: `apps/api/src/modules/anand-dual-track/controllers/anand-dual-track.controller.ts` (handlers `listIntraday` @ `intraday/entries`, `listSwing` @ `swing/entries`, `listSwingExits` @ `swing/exits`).
- Test: `apps/api/test/tda006/provenance-routes.spec.ts` (anand portion).

**Interfaces — Consumes:** `toPublicEntry` (Task 1), `@CurrentUser` + `AuthenticatedUser` from `apps/api/src/common/decorators`.

**Context:** `@Controller('api/anand')`. `listIntraday` returns `enrichWithScannerName(enriched)`; `listSwing`/`listSwingExits` return `enrichWithLeadStat(withScanner)`. These enrichments attach `scannerName`/`leadCount`/`leadDates`. The `pnl-summary` handlers are aggregates with no provenance — leave them.

- [ ] **Step 1: Write the failing test** — `apps/api/test/tda006/provenance-routes.spec.ts` (boot a focused module importing the real `AnandDualTrackModule` + Auth/Tenant; mint JWTs). Use the tda003 Style-A harness (copy `boot`, `tokenFor`, `getter` helpers; `tokenFor` must sign `{sub,role,email}` with `audience:'td-access'`). Add a JSON-body getter:

```ts
const getJson = (baseUrl: string) => async (path: string, token?: string) => {
  const res = await fetch(`${baseUrl}${path}`, token ? { headers: { authorization: `Bearer ${token}` } } : {});
  return { status: res.status, body: res.status === 200 ? await res.json() : null };
};
```

Assertions (seed at least one intraday entry via the `raw` PrismaClient with a non-null `alertId` whose scanner resolves, OR assert purely on key-absence which holds even for an empty array — prefer seeding one row):

```ts
it('USER intraday entries contain no provenance keys', async () => {
  const { status, body } = await getJson(baseUrl)('/api/anand/intraday/entries', tokenFor('USER'));
  expect(status).toBe(200);
  for (const row of body) {
    for (const k of ['scannerName','scoreBreakdown','leadCount','leadDates','trailing','exitReason']) {
      expect(row).not.toHaveProperty(k);
    }
    expect(row).toHaveProperty('segment', 'INTRADAY');
  }
});

it('ADMIN intraday entries retain scannerName (raw)', async () => {
  const { body } = await getJson(baseUrl)('/api/anand/intraday/entries', tokenFor('ADMIN'));
  // at least the property exists on raw rows (value may be null)
  if (body.length) expect(body[0]).toHaveProperty('scannerName');
});
```

- [ ] **Step 2: Run → FAIL** (USER rows still carry `scannerName`).

- [ ] **Step 3: Implement** — inject the current user and branch. Add the import and `@CurrentUser()` param, then map when non-ADMIN. Example for `listIntraday` (apply the same pattern to `listSwing` and `listSwingExits`, passing `'SWING'` for the swing handlers):

```ts
import { CurrentUser, AuthenticatedUser } from '../../../common/decorators';
import { toPublicEntry } from '../dto/public-entry.dto';

@Get('intraday/entries')
async listIntraday(
  @CurrentUser() user: AuthenticatedUser,
  @Query('status') status?: string,
  @Query('from') from?: string,
  @Query('to') to?: string,
) {
  // ... existing fetch + enrich → `const enrichedRows = this.enrichWithScannerName(enriched);`
  const rows = await this.enrichWithScannerName(enriched);
  if (user?.role === 'ADMIN') return rows;
  return rows.map((r) => toPublicEntry(r, 'INTRADAY'));
}
```

For `listSwing` and `listSwingExits`: after their existing `enrichWithLeadStat(withScanner)` result, `return user?.role === 'ADMIN' ? rows : rows.map((r) => toPublicEntry(r, 'SWING'));`.

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `TDA-006: anand controller serves sanitized entries to USERs`.

---

### Task 3: `@AdminOnly()` on signal / chartink / rejections routes

**Files:**
- Modify: `apps/api/src/modules/signal-generator/controllers/signal-generator.controller.ts` (class-level `@AdminOnly()`).
- Modify: the chartink controller(s) under `apps/api/src/modules/chartink/controllers/` and the rejections controller. **Keep** the Chartink inbound **webhook** route `@Public()` (it is hit by Chartink's servers, not users) — if the webhook shares the controller being locked, move/annotate it so the webhook stays `@Public()` while the read endpoints are `@AdminOnly()`. Verify by grepping for `@Public()` in the chartink module first.
- Test: `apps/api/test/tda006/provenance-routes.spec.ts` (signals/chartink portion).

**Interfaces — Consumes:** `@AdminOnly` from `apps/api/src/common/decorators`.

- [ ] **Step 1: Write the failing test** (same spec/harness as Task 2):

```ts
it('USER is forbidden on /api/signals', async () =>
  expect((await getJson(baseUrl)('/api/signals', tokenFor('USER'))).status).toBe(403));
it('ADMIN is allowed on /api/signals', async () =>
  expect((await getJson(baseUrl)('/api/signals', tokenFor('ADMIN'))).status).toBe(200));
it('USER is forbidden on /api/signals/active', async () =>
  expect((await getJson(baseUrl)('/api/signals/active', tokenFor('USER'))).status).toBe(403));
```
(Import the real `SignalGeneratorModule` in the test root module.)

- [ ] **Step 2: Run → FAIL** (USER currently gets 200).

- [ ] **Step 3: Implement** — add the class decorator:

```ts
import { AdminOnly } from '../../../common/decorators';

@AdminOnly()
@Controller('api/signals')
export class SignalGeneratorController { /* unchanged */ }
```
Apply the same class-level `@AdminOnly()` to the chartink **read** controller and the rejections controller. Before editing chartink, run: `grep -rn "@Public()" apps/api/src/modules/chartink` — ensure the webhook handler keeps `@Public()` (handler-level `@Public()` overrides nothing here because RolesGuard checks `IS_PUBLIC_KEY` first and returns true, so a `@Public()` handler inside an `@AdminOnly()` class is still public; confirm with a test if the webhook is in that controller).

- [ ] **Step 4: Run → PASS.** Also add, if the webhook is in the locked controller, a test: webhook route with no token → not 403 (still reachable).
- [ ] **Step 5: Commit** `TDA-006: ADMIN-gate raw signal/chartink/rejections routes`.

---

### Task 4: Authenticate the signal WebSocket handshake

**Files:**
- Modify: `apps/api/src/modules/signal-generator/gateways/signal.gateway.ts`.
- Test: `apps/api/test/tda006/signal-gateway-auth.spec.ts`.

**Interfaces — Produces:** the gateway now disconnects unauthenticated and non-ADMIN sockets in `handleConnection`.

**Context:** current gateway has `handleConnection(client)` that logs and accepts everyone; emits `new-signal` (raw entity) + `signal-expired` via `this.server.emit`. Socket.io handshake carries `client.handshake.auth?.token` (set by the client) or an `authorization` header.

- [ ] **Step 1: Write the failing test** — boot the gateway in a Nest app on a random port, connect with `socket.io-client`:

```ts
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { io, Socket } from 'socket.io-client';
import { JwtService } from '@nestjs/jwt';
import { AddressInfo } from 'net';
import { WS_NAMESPACE } from '@td/shared/constants';
import { SignalGateway } from '../../src/modules/signal-generator/gateways/signal.gateway';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-jwt-secret-tda006';
const jwt = new JwtService();
const tok = (role: 'USER'|'ADMIN') => jwt.sign({ sub:`u-${role}`, role, email:`${role}@t.local` },
  { secret: process.env.JWT_SECRET, algorithm:'HS256', audience:'td-access', expiresIn:'15m' });

function connect(url: string, token?: string): Promise<{ ok: boolean; sock: Socket }> {
  return new Promise((resolve) => {
    const sock = io(`${url}${WS_NAMESPACE}`, { transports:['websocket'], forceNew:true,
      auth: token ? { token } : {}, reconnection:false });
    sock.on('connect', () => resolve({ ok:true, sock }));
    sock.on('connect_error', () => resolve({ ok:false, sock }));
    sock.on('disconnect', () => resolve({ ok:false, sock }));
    setTimeout(() => resolve({ ok: sock.connected, sock }), 1500);
  });
}

let app: INestApplication; let url: string;
beforeAll(async () => {
  const mod = await Test.createTestingModule({ providers: [SignalGateway] }).compile();
  app = mod.createNestApplication(); await app.init(); await app.listen(0);
  url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
});
afterAll(async () => { await app?.close(); });

it('rejects a socket with no token', async () => expect((await connect(url)).ok).toBe(false));
it('rejects a USER socket', async () => expect((await connect(url, tok('USER'))).ok).toBe(false));
it('accepts an ADMIN socket', async () => { const r = await connect(url, tok('ADMIN')); expect(r.ok).toBe(true); r.sock.close(); });
```
(`apps/api/test/tda006/jest.config.js` maps otplib stub; this spec needs no DB. Add `socket.io-client` to `apps/api` devDeps if absent: `pnpm --filter @td/api add -D socket.io-client`.)

- [ ] **Step 2: Run → FAIL** (all three connect).

- [ ] **Step 3: Implement** — verify the JWT in `handleConnection`:

```ts
import * as jwt from 'jsonwebtoken';
import { ACCESS_TOKEN_AUDIENCE } from '../../auth/services/token.service';

handleConnection(client: Socket): void {
  const raw = (client.handshake.auth?.token as string | undefined)
    ?? (client.handshake.headers.authorization?.replace(/^Bearer\s+/i, ''));
  try {
    const payload = jwt.verify(raw ?? '', process.env.JWT_SECRET as string, {
      algorithms: ['HS256'], audience: ACCESS_TOKEN_AUDIENCE,
    }) as { role?: string; sub?: string };
    if (payload.role !== 'ADMIN') { client.disconnect(true); return; }
    this.logger.debug(`Signal ADMIN socket connected: ${client.id}`);
  } catch {
    client.disconnect(true);
  }
}
```
(`jsonwebtoken` is already a transitive dep via `@nestjs/jwt`; if the import fails, use `new JwtService().verify(...)`.)

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `TDA-006: authenticate signal WS, ADMIN-only sockets`.

---

### Task 5: Provenance log redactor

**Files:**
- Create: `apps/api/src/common/log/redact-provenance.ts`
- Test: `apps/api/test/tda006/public-entry.spec.ts` (append a `describe('redactProvenance')`) — or a new `redact.spec.ts`.

**Interfaces — Produces:** `redactProvenance<T>(obj: T): T` — returns a shallow clone with provenance keys removed (anand + signal sets).

- [ ] **Step 1: Write the failing test:**

```ts
import { redactProvenance } from '../../src/common/log/redact-provenance';
it('strips anand + signal provenance keys, keeps the rest', () => {
  const out: any = redactProvenance({ id:'1', symbol:'X', scannerName:'s', scoreBreakdown:[], strategy:'st', reason:'r', confidenceScore:9, keep:true });
  expect(out).toEqual({ id:'1', symbol:'X', keep:true });
});
it('is null/undefined safe', () => { expect(redactProvenance(null as any)).toBeNull(); });
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement:**

```ts
import { ANAND_PROVENANCE_KEYS } from '../../modules/anand-dual-track/dto/public-entry.dto';

const SIGNAL_PROVENANCE_KEYS = ['strategy','reason','setupContext','confidence','confidenceScore','chartinkSource'] as const;
const ALL = new Set<string>([...ANAND_PROVENANCE_KEYS, ...SIGNAL_PROVENANCE_KEYS]);

export function redactProvenance<T>(obj: T): T {
  if (obj == null || typeof obj !== 'object') return obj;
  const clone: Record<string, unknown> = Array.isArray(obj) ? [...(obj as any)] as any : { ...(obj as any) };
  for (const k of Object.keys(clone)) if (ALL.has(k)) delete clone[k];
  return clone as T;
}
```

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `TDA-006: provenance log redactor`.

---

## Self-Review

- Spec §3 (serializer + allowlist) → T1; §3.1 (apply in controller) → T2; §4 (ADMIN-gate routes) → T3; §4.1 (WS auth) → T4; §5 (log redaction) → T5; §6 (CI guard) → T1; §8 acceptance: AC1→T1/T2, AC2→T3, AC3→T2, AC4→T4, AC5→T1. ✅
- No DB migration (no new columns) — confirm `prisma migrate status` clean before/after.
- **Cross-task type consistency:** `toPublicEntry(row, segment)` signature + `PublicAnandEntry` 14-key shape used identically in T1/T2; `ANAND_PROVENANCE_KEYS` exported once (T1) and reused (T5). ✅
- **Risk — chartink webhook lockout:** Task 3 explicitly preserves the `@Public()` webhook inside the `@AdminOnly()` class (RolesGuard short-circuits on `IS_PUBLIC_KEY`). Must be verified by grep + test, else Chartink alerts break (this exact bug happened pre-TDA-003). ✅
- **Risk — empty-array false pass:** Task 2 seeds a real row so the no-provenance assertion is meaningful, not vacuously true on `[]`. ✅
- Deferred: subscription gate (TDA-007), sanitized USER WS feed, audit redaction (TDA-008). ✅
