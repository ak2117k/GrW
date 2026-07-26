# Per-User Real-Time Market Feed — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stream each user's actively-viewed symbols from their own Angel One account over a dedicated, authenticated, per-user WebSocket so the chart matches the Angel One terminal in real time, reliably.

**Architecture:** A per-user registry (`UserFeedManager`) lazily opens one Angel `WebSocketV2` per user (`UserFeedSession`), subscribes the tokens that user is viewing (SNAP_QUOTE), and routes ticks only to that user's JWT-authenticated socket.io room (`user:{userId}`). On-demand connect + idle teardown + reconnect/resubscribe/gap-fill. No shared feed account for chart symbols. Single instance, in-memory (target < 30 concurrent).

**Tech Stack:** NestJS + `@nestjs/websockets` (socket.io), `smartapi-javascript` (`WebSocketV2`), Prisma, React + Vite, `socket.io-client`, jest (api), vitest (web).

## Global Constraints

- Feature-flagged: `PER_USER_FEED_ENABLED` (default `true`); when off, behavior falls back to the legacy shared feed (no per-user sessions created).
- Config defaults (copy verbatim): `USER_FEED_IDLE_TEARDOWN_MS = 120000`, `USER_FEED_MAX_SESSIONS = 40`.
- Angel WS subscription mode is **SNAP_QUOTE (mode 3)** — mirror `WsFeedMode.SNAP_QUOTE` (`apps/api/src/modules/market-data/services/angel-one-websocket.service.ts:15`).
- Security: raw creds (`password`/`totpSecret`/`apiSecret`) may exist in memory ONLY inside the vault decrypt-lease callback used to call `generateSession`. After login, retain only `jwtToken`/`feedToken`. Never log plaintext creds/tokens; mask client id like `per-user-broker-session.factory.ts:100-104`.
- Naming: files kebab-case, classes PascalCase, DB untouched (no schema change).
- Every backend task ends green under `cd apps/api && npx jest <path>`; every web task under `cd apps/web && npx vitest run <path>`.
- Commit after each task with a Conventional Commit message. Do all work on branch `feature/per-user-realtime-market-feed`. Use explicit pathspecs in `git add` (never `git add -A`) — the working tree holds unrelated changes.

---

## File Structure

**Backend (new)**
- `apps/api/src/modules/market-data/services/user-feed-session.ts` — one Angel `WebSocketV2` per user; connect/subscribe/unsubscribe/reconnect/dispose; emits `tick` + `state`.
- `apps/api/src/modules/market-data/services/user-feed-session.spec.ts`
- `apps/api/src/modules/market-data/services/user-feed-manager.service.ts` — registry, ref-counting, idle teardown, session cap.
- `apps/api/src/modules/market-data/services/user-feed-manager.service.spec.ts`
- `apps/api/src/modules/market-data/services/user-feed.types.ts` — `TokenRef`, `FeedState`, `UserFeedSessionLike`, factory token.

**Backend (new, shared)**
- `apps/api/src/common/ws/authenticate-user-socket.ts` — pure `getUserIdFromSocket(client): string | null` mirroring `authenticate-admin-socket.ts` (verifies the handshake JWT with `JWT_SECRET`, audience `td-access`, returns `payload.sub`).
- `apps/api/src/common/ws/authenticate-user-socket.spec.ts`

**Backend (modified)**
- `apps/api/src/modules/market-data/gateways/market-data.gateway.ts` — socket JWT auth, `user:{userId}` rooms, per-user subscribe/unsubscribe + emit.
- `apps/api/src/modules/market-data/gateways/market-data.gateway.spec.ts` (create if absent)
- `apps/api/src/modules/market-data/market-data.module.ts` — provide the two new services + factory.
- `apps/api/src/modules/market-data/services/angel-one-adapter.service.ts` — historical cache key includes `[from,to]`.

**Frontend (modified)**
- `apps/web/src/services/websocket.ts` — auth handshake, `emitSubscribe/emitUnsubscribe`, transport logging, prefer websocket.
- `apps/web/src/hooks/useChartData.ts` — emit subscribe/unsubscribe, gap-fill on reconnect, feed-state.
- `apps/web/src/pages/charts/ChartsPage.tsx` — connection-state badge.
- `apps/web/src/pages/charts/feedState.ts` (new, pure) + `feedState.spec.ts` — map raw signals → badge state (unit-tested).

---

## Task 1: Fix historical cache to key on the requested window

**Files:**
- Modify: `apps/api/src/modules/market-data/services/angel-one-adapter.service.ts` (the `historicalCache` key, ~line 917; see also the intentional-omission comment ~360-364)
- Test: `apps/api/src/modules/market-data/services/angel-one-adapter.service.spec.ts` (existing — add a case)

**Interfaces:**
- Consumes: existing `getHistoricalData(token, exchange, timeframe, from, to, priority)`.
- Produces: nothing new; behavior change only (distinct `[from,to]` no longer collide).

- [ ] **Step 1: Read the current cache-key construction** in `getHistoricalData` and the `historicalCache` map declaration. Confirm the key is `${token}:${exchange}:${timeframe}` and that `from`/`to` are omitted.

- [ ] **Step 2: Write the failing test.** Add to the existing spec (mirror its harness). The test drives two calls with the SAME token/exchange/timeframe but DIFFERENT `[from,to]` windows and asserts the second call does NOT return the first window's cached array.

```ts
it('does not serve a different [from,to] window from cache', async () => {
  // Arrange: fake broker returns window-specific candles (echo the `fromdate`).
  const calls: Array<{ from: string; to: string }> = [];
  const fakeSmartApi = {
    getCandleData: async (p: any) => {
      calls.push({ from: p.fromdate, to: p.todate });
      return { data: [[p.fromdate, 1, 2, 0.5, 1.5, 100]] };
    },
  };
  const adapter = makeAdapterWithFakeSmartApi(fakeSmartApi); // mirror existing spec factory
  const t0 = '2026-07-20 09:15';
  const t1 = '2026-07-24 09:15';
  await adapter.getHistoricalData('99926000', 'NSE', 'ONE_DAY', new Date(t0), new Date(t0), 'background');
  await adapter.getHistoricalData('99926000', 'NSE', 'ONE_DAY', new Date(t1), new Date(t1), 'background');
  expect(calls.length).toBe(2); // second window must NOT be served from cache
});
```

- [ ] **Step 3: Run it — expect FAIL.** `cd apps/api && npx jest angel-one-adapter.service.spec -t "different \[from,to\] window"` → FAIL (only 1 call recorded because the second was cache-served).

- [ ] **Step 4: Implement.** Add the window to the cache key. Use a coarse bucket so identical windows still coalesce but different windows don't collide:

```ts
// Include the requested window in the key (was: `${token}:${exchange}:${timeframe}`).
// Round to whole seconds so byte-identical windows still share a cache entry.
const fromKey = Math.floor(from.getTime() / 1000);
const toKey = Math.floor(to.getTime() / 1000);
const cacheKey = `${token}:${exchange}:${timeframe}:${fromKey}:${toKey}`;
```

Apply the same key at every read AND write of `historicalCache` in this method. Remove/adjust the now-inaccurate "we deliberately omit [from,to]" comment (~360-364) to reflect that the window is now part of the key.

- [ ] **Step 5: Run tests — expect PASS.** `cd apps/api && npx jest angel-one-adapter.service.spec` → all green (including pre-existing cases).

- [ ] **Step 6: Commit.**

```bash
git add apps/api/src/modules/market-data/services/angel-one-adapter.service.ts apps/api/src/modules/market-data/services/angel-one-adapter.service.spec.ts
git commit -m "fix(market-data): key historical cache on [from,to] window"
```

---

## Task 2: Shared feed types

**Files:**
- Create: `apps/api/src/modules/market-data/services/user-feed.types.ts`
- Test: none (types only; exercised by Tasks 3-5).

**Interfaces:**
- Produces: `TokenRef`, `FeedState`, `UserFeedSessionLike`, `USER_FEED_SESSION_FACTORY`, `UserFeedSessionFactory`, `TickListener`, `StateListener`.

- [ ] **Step 1: Create the file with the shared contracts.**

```ts
import type { TickData } from '../../../common/interfaces/broker-adapter.interface';

/** A single instrument to subscribe on the broker feed. */
export interface TokenRef {
  token: string;
  /** Angel exchange code, e.g. 'NSE' | 'BSE' | 'MCX' (mapped to ExchangeType by the session). */
  exchange: string;
}

/** Lifecycle state of one user's broker feed, surfaced to the client badge. */
export type FeedState =
  | 'connecting'
  | 'live'
  | 'reconnecting'
  | 'closed'
  | 'error';

export type TickListener = (tick: TickData) => void;
export type StateListener = (state: FeedState) => void;

/** The per-user session surface the manager depends on (structural, for fakes). */
export interface UserFeedSessionLike {
  ensureConnected(): Promise<void>;
  subscribe(tokens: TokenRef[]): Promise<void>;
  unsubscribe(tokens: TokenRef[]): Promise<void>;
  activeTokenCount(): number;
  onTick(listener: TickListener): void;
  onState(listener: StateListener): void;
  dispose(): Promise<void>;
}

/** Builds a session for one user. Overridable in tests via the DI token below. */
export type UserFeedSessionFactory = (userId: string) => UserFeedSessionLike;
export const USER_FEED_SESSION_FACTORY = Symbol('USER_FEED_SESSION_FACTORY');
```

- [ ] **Step 2: Typecheck.** `cd apps/api && npx tsc --noEmit -p tsconfig.json 2>&1 | grep user-feed.types || echo "clean"` → `clean`.

- [ ] **Step 3: Commit.**

```bash
git add apps/api/src/modules/market-data/services/user-feed.types.ts
git commit -m "feat(market-data): shared per-user feed types"
```

---

## Task 3: `UserFeedSession` — one Angel WebSocket per user

**Files:**
- Create: `apps/api/src/modules/market-data/services/user-feed-session.ts`
- Test: `apps/api/src/modules/market-data/services/user-feed-session.spec.ts`

**Interfaces:**
- Consumes: `TokenRef`, `FeedState`, `UserFeedSessionLike` (Task 2); `generateTOTP(base32Secret): string` (`utils/angel-one-totp.ts:11`); Angel `WebSocketV2` connect shape `{ jwttoken, clientcode, feedtype, apikey }` (`angel-one-websocket.service.ts:122-127`); the subscribe shape from `AngelOneWebSocketService.subscribe` — `ws.fetchData({ correlationID, action: 1 /* 0=unsub */, mode: WsFeedMode.SNAP_QUOTE, exchangeType, tokens })` (`angel-one-websocket.service.ts:210-217`), with `ExchangeType` mapping (`:21-29`, NSE_CM=1/BSE_CM=3/MCX_FO=5); tick normalization mirrors `mapSingleTick` incl. **prices arrive in paise → divide by 100** (`:338-348`).
- The **vault lease** is passed in via `deps.withDecryptedCreds(userId, cb)` — a 2-arg adapter the module (Task 6) wires to `CredentialDecryptor.withDecryptedCredentials(userId, { reason: 'FEED' }, cb)` (`credential-decryptor.ts:47`; token `CREDENTIAL_DECRYPTOR`). The callback's cred shape is `DecryptedBrokerCredentials { apiKey, apiSecret, clientId, password, totpSecret }` (`credential-decryptor.ts:10-16`).
- Produces: class `UserFeedSession implements UserFeedSessionLike`; constructor `(userId, deps: UserFeedSessionDeps)` (all deps injectable so tests use fakes).

**Design note for the implementer:** DO NOT reuse the singleton `AngelOneWebSocketService` (it is bound to the shared feed auth). This class owns its OWN `WebSocketV2`. Obtain per-user `jwtToken`+`feedToken` by: (1) calling `deps.withDecryptedCreds(userId, cb)`, (2) inside `cb`, `generateTOTP(creds.totpSecret)` + `smartApi.generateSession(creds.clientId, creds.password, totp)`, (3) reading `session.data.jwtToken` and `session.data.feedToken` (exact fields per `angel-one-auth.service.ts:110-113`). Keep only those two tokens after the lease returns.

- [ ] **Step 1: Write failing tests** with fully faked deps (no real broker).

```ts
import { UserFeedSession } from './user-feed-session';
import type { FeedState } from './user-feed.types';

function makeDeps() {
  const ws = {
    connect: jest.fn().mockResolvedValue(undefined),
    close: jest.fn(),
    fetchData: jest.fn(),
    on: jest.fn(),
  };
  const wsFactory = jest.fn().mockReturnValue(ws);
  const smartApi = {
    generateSession: jest.fn().mockResolvedValue({
      data: { jwtToken: 'jwt', feedToken: 'feed' },
    }),
    logout: jest.fn().mockResolvedValue(undefined),
  };
  // Vault lease that just hands fake decrypted creds to the callback.
  const withCreds = jest.fn(async (_userId: string, cb: (c: any) => Promise<any>) =>
    cb({ apiKey: 'k', apiSecret: 's', clientId: 'C1', password: 'p', totpSecret: 'AAAA' }),
  );
  return { ws, wsFactory, smartApi, withCreds };
}

it('connects using per-user feedToken and marks state live', async () => {
  const d = makeDeps();
  const states: FeedState[] = [];
  const s = new UserFeedSession('u1', {
    withDecryptedCreds: d.withCreds,
    smartApiFactory: () => d.smartApi as any,
    wsFactory: d.wsFactory as any,
  });
  s.onState((st) => states.push(st));
  await s.ensureConnected();
  expect(d.wsFactory).toHaveBeenCalledWith(
    expect.objectContaining({ jwttoken: 'jwt', feedtype: 'feed', clientcode: 'C1', apikey: 'k' }),
  );
  expect(states).toContain('live');
});

it('ensureConnected is idempotent (single login/socket)', async () => {
  const d = makeDeps();
  const s = new UserFeedSession('u1', {
    withDecryptedCreds: d.withCreds,
    smartApiFactory: () => d.smartApi as any,
    wsFactory: d.wsFactory as any,
  });
  await s.ensureConnected();
  await s.ensureConnected();
  expect(d.smartApi.generateSession).toHaveBeenCalledTimes(1);
  expect(d.wsFactory).toHaveBeenCalledTimes(1);
});

it('tracks active token count across subscribe/unsubscribe', async () => {
  const d = makeDeps();
  const s = new UserFeedSession('u1', {
    withDecryptedCreds: d.withCreds,
    smartApiFactory: () => d.smartApi as any,
    wsFactory: d.wsFactory as any,
  });
  await s.ensureConnected();
  await s.subscribe([{ token: '111', exchange: 'NSE' }, { token: '222', exchange: 'NSE' }]);
  expect(s.activeTokenCount()).toBe(2);
  await s.unsubscribe([{ token: '111', exchange: 'NSE' }]);
  expect(s.activeTokenCount()).toBe(1);
  expect(d.ws.fetchData).toHaveBeenCalled(); // subscribe issued a fetchData
});

it('dispose closes the socket and logs out', async () => {
  const d = makeDeps();
  const s = new UserFeedSession('u1', {
    withDecryptedCreds: d.withCreds,
    smartApiFactory: () => d.smartApi as any,
    wsFactory: d.wsFactory as any,
  });
  await s.ensureConnected();
  await s.dispose();
  expect(d.ws.close).toHaveBeenCalled();
  expect(d.smartApi.logout).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run — expect FAIL.** `cd apps/api && npx jest user-feed-session.spec` → module not found / fail.

- [ ] **Step 3: Implement `UserFeedSession`.** Key points: hold `activeTokens: Map<string, TokenRef>`; `ensureConnected` guarded by a `connectPromise` so concurrent calls share one login; subscribe/unsubscribe build the SNAP_QUOTE `fetchData` payload **exactly like `AngelOneWebSocketService.subscribe`** (open that method, copy the `{ correlationID, action, mode: WsFeedMode.SNAP_QUOTE, tokenList: [{ exchangeType, tokens }] }` shape and the `ExchangeType` mapping); register `ws.on('tick', ...)` → normalize to `TickData` (mirror `angel-one-websocket.service.ts` tick handling ~278) → fan to `tick` listeners; emit `state` transitions (`connecting`→`live`; on socket error/close → `reconnecting` then reconnect with capped backoff, resubscribing `activeTokens`; terminal → `error`/`closed`). `dispose()` sets a disposed guard, clears timers, `ws.close()`, best-effort `smartApi.logout(clientId)`, and drops token strings. Include the benign-heartbeat guard note (reconnect path must `close()` the old socket first — see `angel-one-websocket.service.ts:109-120`).

  Constructor deps type:

```ts
import type { DecryptedBrokerCredentials } from '../../credential-vault/execution/credential-decryptor';

export interface UserFeedSessionDeps {
  withDecryptedCreds: <T>(userId: string, cb: (creds: DecryptedBrokerCredentials) => Promise<T>) => Promise<T>;
  smartApiFactory: (apiKey: string) => { generateSession: Function; logout: Function };
  wsFactory: (opts: { jwttoken: string; clientcode: string; feedtype: string; apikey: string }) => any;
}
```

  (`DecryptedBrokerCredentials` = `{ apiKey, apiSecret, clientId, password, totpSecret }`, `credential-decryptor.ts:10-16`.)

- [ ] **Step 4: Run — expect PASS.** `cd apps/api && npx jest user-feed-session.spec` → green.

- [ ] **Step 5: Commit.**

```bash
git add apps/api/src/modules/market-data/services/user-feed-session.ts apps/api/src/modules/market-data/services/user-feed-session.spec.ts
git commit -m "feat(market-data): per-user Angel WebSocket session"
```

---

## Task 4: `UserFeedManager` — registry, ref-counting, idle teardown

**Files:**
- Create: `apps/api/src/modules/market-data/services/user-feed-manager.service.ts`
- Test: `apps/api/src/modules/market-data/services/user-feed-manager.service.spec.ts`

**Interfaces:**
- Consumes: `UserFeedSessionLike`, `UserFeedSessionFactory`, `USER_FEED_SESSION_FACTORY`, `TokenRef` (Task 2).
- Produces: `@Injectable() UserFeedManager` with:
  - `subscribe(userId: string, tokens: TokenRef[]): Promise<void>`
  - `unsubscribe(userId: string, tokens: TokenRef[]): Promise<void>`
  - `releaseUser(userId: string): void` (called on socket disconnect)
  - `onTick(userId: string, listener: (t: TickData) => void)` / `onState(userId, listener)` — OR a single global callback `setTickHandler((userId, tick) => ...)`. Use the global-handler form (the gateway registers one handler and routes by userId).
  - `setHandlers(onTick: (userId, tick) => void, onState: (userId, state) => void): void`

- [ ] **Step 1: Write failing tests** with a fake session factory + fake timers.

```ts
import { UserFeedManager } from './user-feed-manager.service';

function fakeSession() {
  const listeners: any = {};
  let count = 0;
  return {
    ensureConnected: jest.fn().mockResolvedValue(undefined),
    subscribe: jest.fn(async (t: any[]) => { count += t.length; }),
    unsubscribe: jest.fn(async (t: any[]) => { count -= t.length; }),
    activeTokenCount: () => count,
    onTick: (l: any) => (listeners.tick = l),
    onState: (l: any) => (listeners.state = l),
    dispose: jest.fn().mockResolvedValue(undefined),
    __listeners: listeners,
  };
}

it('creates one session per user and ref-counts tokens', async () => {
  const sessions: any[] = [];
  const factory = jest.fn(() => { const s = fakeSession(); sessions.push(s); return s; });
  const mgr = new UserFeedManager(factory as any, { idleMs: 120000, maxSessions: 40 });
  await mgr.subscribe('u1', [{ token: '1', exchange: 'NSE' }]);
  await mgr.subscribe('u1', [{ token: '1', exchange: 'NSE' }]); // 2nd viewer of same token
  expect(factory).toHaveBeenCalledTimes(1);
  await mgr.unsubscribe('u1', [{ token: '1', exchange: 'NSE' }]); // still 1 ref left
  expect(sessions[0].unsubscribe).not.toHaveBeenCalled();
  await mgr.unsubscribe('u1', [{ token: '1', exchange: 'NSE' }]); // ref hits 0
  expect(sessions[0].unsubscribe).toHaveBeenCalled();
});

it('tears down an idle session after idleMs', async () => {
  jest.useFakeTimers();
  const sessions: any[] = [];
  const factory = jest.fn(() => { const s = fakeSession(); sessions.push(s); return s; });
  const mgr = new UserFeedManager(factory as any, { idleMs: 1000, maxSessions: 40 });
  await mgr.subscribe('u1', [{ token: '1', exchange: 'NSE' }]);
  mgr.releaseUser('u1');
  jest.advanceTimersByTime(1001);
  await Promise.resolve();
  expect(sessions[0].dispose).toHaveBeenCalled();
  jest.useRealTimers();
});

it('routes ticks through the global handler tagged by userId', async () => {
  const s = fakeSession();
  const mgr = new UserFeedManager((() => s) as any, { idleMs: 1000, maxSessions: 40 });
  const seen: any[] = [];
  mgr.setHandlers((uid, t) => seen.push([uid, t]), () => {});
  await mgr.subscribe('u1', [{ token: '1', exchange: 'NSE' }]);
  s.__listeners.tick({ token: '1', ltp: 100 });
  expect(seen).toEqual([['u1', { token: '1', ltp: 100 }]]);
});
```

- [ ] **Step 2: Run — expect FAIL.** `cd apps/api && npx jest user-feed-manager.service.spec` → fail.

- [ ] **Step 3: Implement.** `Map<userId, { session, refs: Map<tokenKey, number>, idleTimer }>`. `subscribe`: create session via factory on first use (wire its `onTick`/`onState` to the manager's global handlers, tagging `userId`), `ensureConnected()`, increment refs, `session.subscribe(newTokensOnly)`. `unsubscribe`: decrement; `session.unsubscribe(tokensHittingZero)`; if the user's total refs hit 0, start the idle timer. `releaseUser`: treat as "drop this user's live interest" → if refs already 0 start/keep idle timer; (single-instance/one-socket-per-user target, so releaseUser can zero the user out). Idle timer fires → `dispose()` + remove from map. Enforce `maxSessions`: on create, if at cap, dispose the least-recently-active session with 0 refs; if none idle, log a warning (never silently drop). Accept a plain options object `{ idleMs, maxSessions }` in the constructor for testability; the Nest provider passes config values.

- [ ] **Step 4: Run — expect PASS.** `cd apps/api && npx jest user-feed-manager.service.spec` → green.

- [ ] **Step 5: Commit.**

```bash
git add apps/api/src/modules/market-data/services/user-feed-manager.service.ts apps/api/src/modules/market-data/services/user-feed-manager.service.spec.ts
git commit -m "feat(market-data): per-user feed manager with ref-count + idle teardown"
```

---

## Task 5: Authenticate the socket + per-user routing in the gateway

**Files:**
- Modify: `apps/api/src/modules/market-data/gateways/market-data.gateway.ts`
- Test: `apps/api/src/modules/market-data/gateways/market-data.gateway.spec.ts` (create)

**Interfaces:**
- Consumes: `UserFeedManager` (Task 4); a new pure `getUserIdFromSocket(client): string | null` (created in Step 1 below), mirroring `common/ws/authenticate-admin-socket.ts` — `jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'], audience: ACCESS_TOKEN_AUDIENCE })` and returning `payload.sub`. Token read from `client.handshake.auth?.token` (or `Authorization: Bearer`).
- Produces: authenticated sockets carry `data.userId`; ticks emit only to `user:{userId}`; `emitTickToUser(userId, quote)` / `emitCandleToUser(userId, candle)`.

- [ ] **Step 1: Create the socket-auth helper (mirror the admin one).** Create `apps/api/src/common/ws/authenticate-user-socket.ts` copying the structure of `authenticate-admin-socket.ts`, but returning the user id instead of an admin boolean:

```ts
import type { Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { ACCESS_TOKEN_AUDIENCE } from '../../modules/auth/services/token.service';

/** Verify the handshake JWT and return the user id (`sub`), or null if invalid. */
export function getUserIdFromSocket(client: Socket): string | null {
  const raw =
    (client.handshake.auth?.token as string | undefined) ??
    client.handshake.headers.authorization?.replace(/^Bearer\s+/i, '');
  try {
    const payload = jwt.verify(raw ?? '', process.env.JWT_SECRET as string, {
      algorithms: ['HS256'],
      audience: ACCESS_TOKEN_AUDIENCE,
    }) as { sub?: string };
    return payload.sub ?? null;
  } catch {
    return null;
  }
}
```

  Write `apps/api/src/common/ws/authenticate-user-socket.spec.ts` (mirror any existing `authenticate-admin-socket.spec.ts` if present): set `process.env.JWT_SECRET`, sign a token with `jsonwebtoken` (`{ sub: 'u1' }`, `audience: 'td-access'`, `algorithm: 'HS256'`), assert it returns `'u1'`; a token with a wrong audience or bad signature returns `null`. Run `cd apps/api && npx jest authenticate-user-socket.spec` → PASS.

- [ ] **Step 2: Write failing gateway tests** with a fake `Socket` and fake `Server`. Sign real tokens with `jsonwebtoken` + the test `JWT_SECRET` so `getUserIdFromSocket` verifies them (mirrors `test/tda006/signal-gateway-auth.spec.ts`).

```ts
import jwt from 'jsonwebtoken';
import { MarketDataGateway } from './market-data.gateway';

const SECRET = 'test-secret';
beforeAll(() => { process.env.JWT_SECRET = SECRET; });
function signToken(sub: string): string {
  return jwt.sign({ sub, role: 'USER', email: 'u@x.com' }, SECRET, {
    algorithm: 'HS256', audience: 'td-access', expiresIn: '5m',
  });
}
function fakeSocket(token?: string) {
  const rooms: string[] = [];
  return {
    id: 's1',
    handshake: { auth: token ? { token } : {}, headers: {} },
    data: {} as any,
    join: (r: string) => rooms.push(r),
    disconnect: jest.fn(),
    emit: jest.fn(),
    __rooms: rooms,
  };
}
// makeGateway() constructs the gateway with a fake UserFeedManager (jest.fn()s).
it('rejects an unauthenticated socket', () => {
  const gw = makeGateway();
  const sock = fakeSocket(undefined);
  gw.handleConnection(sock as any);
  expect(sock.disconnect).toHaveBeenCalled();
});

it('authenticated socket joins its user room', () => {
  const gw = makeGateway();
  const sock = fakeSocket(signToken('u1'));
  gw.handleConnection(sock as any);
  expect(sock.data.userId).toBe('u1');
  expect(sock.__rooms).toContain('user:u1');
});

it('emitTickToUser targets only that user room', () => {
  const to = jest.fn().mockReturnValue({ emit: jest.fn() });
  const gw = makeGateway();
  (gw as any).server = { to };
  gw.emitTickToUser('u1', { token: '1' } as any);
  gw.flushForTest();                            // trigger the 100ms coalesced flush synchronously
  expect(to).toHaveBeenCalledWith('user:u1');
});
```

- [ ] **Step 3: Run — expect FAIL.** `cd apps/api && npx jest market-data.gateway.spec` → fail.

- [ ] **Step 4: Implement.**
  - `handleConnection`: `const userId = getUserIdFromSocket(client)` (Step 1 helper); if `null` → `client.disconnect()` and return. Else set `client.data.userId = userId` and `client.join(\`user:${userId}\`)`.
  - `handleSubscribe`/`handleUnsubscribe`: call `this.userFeedManager.subscribe(client.data.userId, tokens.map(toTokenRef))` / `unsubscribe(...)` (skip if `!client.data.userId`). Keep returning the ack.
  - `handleDisconnect`: `this.userFeedManager.releaseUser(client.data.userId)`.
  - Register manager handlers once in `afterInit`: `this.userFeedManager.setHandlers((userId, tick) => this.emitTickToUser(userId, tick), (userId, state) => this.server.to(\`user:${userId}\`).emit('feed-state', state))`.
  - Change coalescing to per-user: `pendingTicks: Map<userId, Map<token, Quote>>`; `emitTickToUser(userId, quote)` stores; `flushPendingTicks` iterates users and emits with `this.server.to(\`user:${userId}\`).emit('tick', quote)`. Add `flushForTest()` that calls the private flush (guarded for tests). Replace the old global `emitTick`/`emitCandle` (`:156-173`) and delete the dead `token:` room logic.
  - Inject only `UserFeedManager` via the constructor (Nest DI). Socket auth uses the module-level `getUserIdFromSocket` import — no `TokenService` injection needed.

- [ ] **Step 5: Run — expect PASS.** `cd apps/api && npx jest market-data.gateway.spec` → green.

- [ ] **Step 6: Commit.**

```bash
git add apps/api/src/common/ws/authenticate-user-socket.ts apps/api/src/common/ws/authenticate-user-socket.spec.ts apps/api/src/modules/market-data/gateways/market-data.gateway.ts apps/api/src/modules/market-data/gateways/market-data.gateway.spec.ts
git commit -m "feat(market-data): authenticate socket + per-user tick routing"
```

---

## Task 6: Wire the module + config + feature flag

**Files:**
- Modify: `apps/api/src/modules/market-data/market-data.module.ts`
- Modify: `apps/api/src/config/configuration.ts` (add feed config block; mirror existing structure)
- Test: extend `market-data.gateway.spec` OR add a small module-compile smoke test.

**Interfaces:**
- Consumes: everything above.
- Produces: `UserFeedManager` + `USER_FEED_SESSION_FACTORY` provided; gateway receives `UserFeedManager` + verifier; `PER_USER_FEED_ENABLED` gates session creation.

- [ ] **Step 1: Add config.** In `configuration.ts` add:

```ts
feed: {
  perUserEnabled: process.env.PER_USER_FEED_ENABLED !== 'false',
  idleTeardownMs: Number(process.env.USER_FEED_IDLE_TEARDOWN_MS ?? 120000),
  maxSessions: Number(process.env.USER_FEED_MAX_SESSIONS ?? 40),
},
```

- [ ] **Step 2: Provide the factory + manager** in `market-data.module.ts`. Mirror the existing `useFactory`/`useExisting` patterns already in this module (e.g. `BROKER_ADAPTER_TOKEN`). The session factory closes over the vault lease service, SmartAPI factory, and the real `WebSocketV2` import:

```ts
import { CREDENTIAL_DECRYPTOR, CredentialDecryptor } from '../credential-vault/execution/credential-decryptor';
// @ts-ignore — smartapi-javascript has no type declarations
import { SmartAPI, WebSocketV2 } from 'smartapi-javascript';

{
  provide: USER_FEED_SESSION_FACTORY,
  inject: [CREDENTIAL_DECRYPTOR],
  useFactory: (decryptor: CredentialDecryptor) => (userId: string) =>
    new UserFeedSession(userId, {
      // Adapt the 3-arg vault lease to the session's 2-arg dep, pinning reason 'FEED'.
      withDecryptedCreds: (uid, cb) =>
        decryptor.withDecryptedCredentials(uid, { reason: 'FEED' }, cb),
      smartApiFactory: (apiKey) => new SmartAPI({ api_key: apiKey }),
      wsFactory: (opts) => new WebSocketV2(opts),
    }),
},
{
  provide: UserFeedManager,
  inject: [USER_FEED_SESSION_FACTORY, ConfigService],
  useFactory: (factory, config: ConfigService) =>
    new UserFeedManager(
      config.get('feed.perUserEnabled') ? factory : () => { throw new Error('per-user feed disabled'); },
      { idleMs: config.get('feed.idleTeardownMs'), maxSessions: config.get('feed.maxSessions') },
    ),
},
```

  `CredentialDecryptorModule` (which provides `CREDENTIAL_DECRYPTOR`) is **already** in `MarketDataModule.imports` (`market-data.module.ts:47`) — no new import needed. `ConfigService` is globally available (`ConfigModule.forRoot({ isGlobal: true })`). Add `UserFeedManager` to `providers`; `MarketDataGateway` is already provided. No `TokenService` import is required (socket auth uses the `getUserIdFromSocket` helper from Task 5).

- [ ] **Step 3: Build.** `cd apps/api && npx nest build` → `Successfully compiled`.

- [ ] **Step 4: Run the affected specs.** `cd apps/api && npx jest market-data` → green.

- [ ] **Step 5: Commit.**

```bash
git add apps/api/src/modules/market-data/market-data.module.ts apps/api/src/config/configuration.ts
git commit -m "feat(market-data): wire per-user feed manager + config flag"
```

---

## Task 7: Frontend socket auth handshake + subscribe surface + transport logging

**Files:**
- Modify: `apps/web/src/services/websocket.ts`
- Test: `apps/web/src/services/websocket.spec.ts` (create — pure logic only; do NOT open real sockets)

**Interfaces:**
- Consumes: the auth store access token (`useAuthStore`/token getter used elsewhere).
- Produces: `wsService.emitSubscribe(tokens: string[])`, `wsService.emitUnsubscribe(tokens: string[])`, and a `getTransport()` helper; `connect()` passes `auth: { token }` and logs the negotiated transport on `upgrade`.

- [ ] **Step 1: Write a failing pure-logic test** for the token→handshake builder and the subscribe payload shaper (extract these as pure functions so no socket is needed).

```ts
import { buildHandshakeAuth, toSubscribePayload } from './websocket';
it('builds handshake auth from a token', () => {
  expect(buildHandshakeAuth('abc')).toEqual({ token: 'abc' });
});
it('shapes a subscribe payload', () => {
  expect(toSubscribePayload(['1', '2'])).toEqual({ tokens: ['1', '2'] });
});
```

- [ ] **Step 2: Run — expect FAIL.** `cd apps/web && npx vitest run src/services/websocket.spec.ts` → fail (exports missing).

- [ ] **Step 3: Implement.** Export the two pure helpers. In `connect()`, add `auth: buildHandshakeAuth(getAccessToken())` to each `io(...)` options; keep `transports: ['websocket', 'polling']` (websocket first) and add an `upgrade`/`connect` listener that logs `socket.io.engine.transport.name`; store it for `getTransport()` and expose via the existing `window.__wsDiag()`. Add `emitSubscribe`/`emitUnsubscribe` that call `socket.emit('subscribe', toSubscribePayload(tokens))` on the `/ws` namespace. Re-send `auth` and re-subscribe on reconnect.

- [ ] **Step 4: Run — expect PASS.** `cd apps/web && npx vitest run src/services/websocket.spec.ts` → green. Also `npx tsc -b --noEmit`.

- [ ] **Step 5: Commit.**

```bash
git add apps/web/src/services/websocket.ts apps/web/src/services/websocket.spec.ts
git commit -m "feat(web): socket auth handshake + subscribe surface + transport logging"
```

---

## Task 8: Chart subscribes/unsubscribes + gap-fill on reconnect

**Files:**
- Modify: `apps/web/src/hooks/useChartData.ts` (subscribe on open/symbol-change; unsubscribe on cleanup; gap-fill on `feed-state` → live after reconnect)
- Test: `apps/web/src/hooks/useChartData.subscribe.spec.ts` (create — extract a pure `computeSubscriptionDelta(prev, next)` helper and test it; the hook wiring is exercised manually)

**Interfaces:**
- Consumes: `wsService.emitSubscribe/emitUnsubscribe` (Task 7).
- Produces: correct subscribe/unsubscribe calls on symbol switch; a `feedState` value the page can render.

- [ ] **Step 1: Write failing test** for the pure delta helper.

```ts
import { computeSubscriptionDelta } from './useChartData';
it('computes tokens to add and remove on symbol switch', () => {
  expect(computeSubscriptionDelta('111', '222')).toEqual({ add: ['222'], remove: ['111'] });
  expect(computeSubscriptionDelta(null, '222')).toEqual({ add: ['222'], remove: [] });
  expect(computeSubscriptionDelta('222', '222')).toEqual({ add: [], remove: [] });
});
```

- [ ] **Step 2: Run — expect FAIL.** `cd apps/web && npx vitest run src/hooks/useChartData.subscribe.spec.ts` → fail.

- [ ] **Step 3: Implement.** Export `computeSubscriptionDelta`. In the hook: on token change, compute delta and call `wsService.emitUnsubscribe(delta.remove)` + `wsService.emitSubscribe(delta.add)`; on unmount, `emitUnsubscribe([token])`. Subscribe to `feed-state` events → set local `feedState`. On transition into `live` after a prior `reconnecting`, call the existing live-edge REST refetch once to gap-fill (reuse the `applyClosedCandles` path ~466-525). Keep the 20s REST poll (~535-561) but only mark visible state "Delayed" while it is the source of the last update.

- [ ] **Step 4: Run — expect PASS.** `cd apps/web && npx vitest run src/hooks/useChartData.subscribe.spec.ts` → green; `npx tsc -b --noEmit` clean.

- [ ] **Step 5: Commit.**

```bash
git add apps/web/src/hooks/useChartData.ts apps/web/src/hooks/useChartData.subscribe.spec.ts
git commit -m "feat(web): chart subscribe/unsubscribe + gap-fill on reconnect"
```

---

## Task 9: Connection-state badge (replace silent failures)

**Files:**
- Create: `apps/web/src/pages/charts/feedState.ts` (pure map: raw signals → badge)
- Create: `apps/web/src/pages/charts/feedState.spec.ts`
- Modify: `apps/web/src/pages/charts/ChartsPage.tsx` (render the badge; remove the "Displaying demo data" ambiguity)

**Interfaces:**
- Consumes: `feedState` from the hook (Task 8), plus flags (marketOpen, brokerConnected).
- Produces: `deriveBadge(input): { label, tone }`.

- [ ] **Step 1: Write failing tests.**

```ts
import { deriveBadge } from './feedState';
it('shows Live when connected and ticking', () => {
  expect(deriveBadge({ feedState: 'live', marketOpen: true, brokerConnected: true }).label).toBe('Live');
});
it('shows Market closed outside hours', () => {
  expect(deriveBadge({ feedState: 'closed', marketOpen: false, brokerConnected: true }).label).toBe('Market closed');
});
it('shows Broker not connected when no creds', () => {
  expect(deriveBadge({ feedState: 'error', marketOpen: true, brokerConnected: false }).label).toBe('Broker not connected');
});
it('shows Reconnecting during a drop', () => {
  expect(deriveBadge({ feedState: 'reconnecting', marketOpen: true, brokerConnected: true }).label).toBe('Reconnecting');
});
```

- [ ] **Step 2: Run — expect FAIL.** `cd apps/web && npx vitest run src/pages/charts/feedState.spec.ts` → fail.

- [ ] **Step 3: Implement `deriveBadge`** with the mapping above (priority: brokerConnected=false → "Broker not connected"; marketOpen=false → "Market closed"; else by feedState: live→Live, reconnecting/connecting→Reconnecting, error→Delayed). Render it in `ChartsPage.tsx` where the current status/demo-data text lives (~434-443), driven by the hook's `feedState`.

- [ ] **Step 4: Run — expect PASS.** `cd apps/web && npx vitest run src/pages/charts/feedState.spec.ts` → green; `npx tsc -b --noEmit` clean.

- [ ] **Step 5: Commit.**

```bash
git add apps/web/src/pages/charts/feedState.ts apps/web/src/pages/charts/feedState.spec.ts apps/web/src/pages/charts/ChartsPage.tsx
git commit -m "feat(web): honest chart connection-state badge"
```

---

## Task 10: End-to-end verification (manual, during market hours)

**Files:** none (verification only).

- [ ] **Step 1: Build both apps.** `cd apps/api && npx nest build` and `cd apps/web && npx tsc -b --noEmit && npm run build`. All succeed.
- [ ] **Step 2: Run all affected tests.** `cd apps/api && npx jest market-data` and `cd apps/web && npx vitest run src/services/websocket.spec.ts src/hooks/useChartData.subscribe.spec.ts src/pages/charts/feedState.spec.ts`. All green.
- [ ] **Step 3: Live check (owner, two accounts, market open).** Open a chart on each account. Confirm: (a) `window.__wsDiag()` shows transport `websocket`; (b) each chart matches its own Angel One terminal in real time; (c) neither account receives the other's symbols; (d) killing the network briefly shows "Reconnecting" then recovers with gap-filled bars; (e) after closing the chart, server logs show the per-user session torn down after the idle window.
- [ ] **Step 4: Update the HANDOFF doc.** Correct `docs/deploy/HANDOFF.md` §5.8/§6 (the stale "no live socket feed" notes) to describe the per-user feed and the `PER_USER_FEED_ENABLED` flag.
- [ ] **Step 5: Commit.**

```bash
git add docs/deploy/HANDOFF.md
git commit -m "docs(deploy): update feed notes for per-user real-time feed"
```

---

## Self-Review (spec coverage)

- Root cause 1 (shared 50-token cap) → Tasks 3-6 (per-user sessions). ✓
- Root cause 2 (REST-poll fallback) → superseded by per-user WS; REST kept only as surfaced "Delayed" (Task 8). ✓
- Root cause 3 (long-polling transport) → Task 7 (websocket-first + transport logging). ✓
- Root cause 4 (broadcast/no auth) → Task 5 (auth + per-user rooms). ✓
- Root cause 5 (masked failures) → Tasks 8-9 (feed-state + badge). ✓
- Root cause 6 (cache window bug) → Task 1. ✓
- Security (brief cred lease, tokens only) → Task 3 design note + Global Constraints. ✓
- Lifecycle (on-demand connect, idle teardown, cap) → Tasks 3-4. ✓
- Feature flag + config → Task 6. ✓
- Testing → each task is TDD; Task 10 integration/manual. ✓

**Known follow-ups (out of scope, noted):** migrating dashboard index tiles / watchlist widgets off the shared feed onto per-user subscriptions; Redis fan-out for >30 users; confirming a live feed WS + an order `generateSession` coexist on one Angel account (Task 3/10 live check will reveal this).
