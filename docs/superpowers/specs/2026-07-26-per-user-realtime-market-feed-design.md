# Per-User Real-Time Market Feed — Design Spec

> Status: **Approved for planning** · Date: 2026-07-26 · Owner: platform
> Supersedes the single shared-feed market-data architecture for chart/live quotes.

---

## 1. Problem

The price chart shows **delayed** data, not the real-time stream a user sees in
the Angel One terminal — even though every user has connected their own Angel One
account. Previous attempts have not fixed it.

### Root causes (evidence-cited)

1. **Single shared 50-token feed can't cover everyone's symbols.** Market data is
   streamed from ONE Angel "feed account" (`feed-credential-provider.ts:28-44`,
   `findFeedAccountUserId` `:119-125`) over a single `WebSocketV2` capped at 50
   tokens (`angel-one-websocket.service.ts:32`), with a shared **ad-hoc "viewing"
   LRU of only 10 slots** (`market-feed.service.ts:89-90`, `addViewing` `:387`).
   Any symbol a user opens that is not in the default universe or those 10 slots
   is **never on the live WS** and is served by REST polling instead.
2. **REST-poll fallback = 5s, unthrottled → effectively worse.** When the single
   WS can't establish (`feedToken` missing at WS-connect, or the broker WS is
   blocked), `MarketFeedService` falls to `REST_POLL_INTERVAL_MS = 5_000`
   (`market-feed.service.ts:118`, `:1021`). Live quotes are **not** throttled
   against Angel's ~3 req/sec cap (`pollQuotesViaRest` `:1073`), so many tokens
   silently drop and never refresh.
3. **Server→browser transport likely stuck on HTTP long-polling.** The client
   opens socket.io with `transports: ['polling', 'websocket']` and never confirms
   the upgrade (`websocket.ts:99`); the code itself notes "Cloudflare
   polling-transport stalls" (`useChartData.ts:527-534`). Long-polling adds
   latency and drops ticks.
4. **Broadcast-to-all + no socket auth.** The gateway `server.emit('tick')`
   sends every token to every client (`market-data.gateway.ts:163`); the socket
   is never authenticated (`handleConnection` `:84-87`). There is no way to route
   a specific user's stream to only that user.
5. **Failures are masked.** ~6 silent `catch` blocks (`useChartData.ts:451, 323,
   554, 392`, etc.) make a symbol with no stream look "frozen" rather than
   surfacing state — the "unreliable" perception.
6. **Historical cache ignores `[from,to]`.** `historicalCache` keys on
   `token:exchange:timeframe` only (`angel-one-adapter.service.ts:917`), risking
   stale/wrong-window candles for background consumers and premature
   end-of-history on scroll-back.

Note: the broker→server hop, **when the WS connects**, is a real Angel
`WebSocketV2` in **SNAP_QUOTE (mode 3)** — sub-second. The problem is that in a
multi-user setting the shared feed frequently is *not* the active path for a
given user's symbol.

## 2. Goals / Non-goals

**Goals**
- Chart price/candles match the Angel One terminal in real time (sub-second to
  ~1s) for the symbols a user is actively viewing.
- Each user's viewed symbols stream from **their own** Angel One account — no
  cross-user contention for a shared token budget.
- Reliable: automatic reconnect + resubscribe + gap-fill; honest connection-state
  UI; no silent failures.
- Scalable to the target of **< 30 concurrent chart viewers** on a single API
  instance, with a clear path to more later.

**Non-goals (this iteration)**
- Redis pub/sub fan-out / horizontal scaling (deferred until > 30 users).
- Options-chain / market-depth streaming redesign (unchanged).
- Order-execution path (per-user order sessions in `auto-execution`) — untouched.
- Removing the existing default-universe shared feed used by non-chart widgets
  (dashboard index tiles, watchlist) — see §9 Migration; it stays until those
  widgets are migrated or explicitly retired.

## 3. Target architecture (fully per-user)

```
User vault creds ──(brief zeroizing decrypt lease)──► generateSession
      │                                                  │  {jwtToken, feedToken}
      ▼                                                  ▼
UserFeedManager  (Map<userId, UserFeedSession>)  ──►  per-user Angel WebSocketV2
  · on-demand connect   · ref-counted tokens                (SNAP_QUOTE, mode 3)
  · idle teardown       · reconnect + resubscribe            │ 'tick' (userId-tagged)
      │                                                       ▼
MarketDataGateway  (JWT-authenticated socket)
  · socket joins room  user:{userId}
  · subscribe/unsubscribe → UserFeedManager for that user
  · emitTickToUser(userId, quote) → server.to(`user:{userId}`).emit('tick')
      │
      ▼
Browser chart (useChartData) — subscribes on open, renders live ticks,
  shows connection state, gap-fills on reconnect.
```

Single instance, in-memory registry. No shared feed account for chart symbols.

## 4. Backend components

### 4.1 `UserFeedSession` (new)
Wraps ONE `WebSocketV2` for one user.

Responsibilities:
- **Connect**: obtain the user's session tokens via a brief vault lease →
  `generateSession` (reuse the credential-vault decrypt lease + the TOTP util
  `angel-one-totp`). Capture BOTH `jwtToken` and `feedToken` from
  `session.data` (the per-user order factory discards `feedToken` today —
  `per-user-broker-session.factory.ts:315`). Construct
  `new WebSocketV2({ jwttoken, clientcode, feedtype: feedToken, apikey })`
  (shape per `angel-one-websocket.service.ts:122-127`) and `connect()`.
- **Subscribe / unsubscribe** tokens in SNAP_QUOTE mode; maintain the active-token
  set; enforce a per-user cap (≤ 50 tokens/Angel connection — a chart user needs
  a handful).
- **Reconnect**: bounded backoff; on reconnect, resubscribe the active-token set;
  emit a `reconnected` signal so the client gap-fills. Reuse the benign
  heartbeat-error handling already in `main.ts:56-75`.
- **Emit** ticks upward tagged with `userId`.
- **Dispose**: unsubscribe all, close WS, best-effort broker logout, zeroize any
  retained token strings.

Interface (structural, for testability — inject a fake `WebSocketV2` factory):
```ts
interface UserFeedSession {
  ensureConnected(): Promise<void>;
  subscribe(tokens: TokenRef[]): Promise<void>;
  unsubscribe(tokens: TokenRef[]): Promise<void>;
  activeTokenCount(): number;
  dispose(): Promise<void>;
  // events: 'tick'(TickData), 'state'(FeedState)
}
type FeedState = 'connecting' | 'live' | 'reconnecting' | 'closed' | 'error';
```

### 4.2 `UserFeedManager` (new)
`Map<userId, UserFeedSession>` + ref-counting.

- `subscribe(userId, tokens)`: lazily create the user's session (on-demand
  connect), ref-count each token, subscribe new ones.
- `unsubscribe(userId, tokens)`: decrement; unsubscribe tokens whose count hits 0.
- `releaseUser(userId)`: called on socket disconnect — drop that socket's
  contribution; if the user has no remaining subscriptions, start the idle timer.
- **Idle teardown**: after ~2 min with zero active tokens (or immediately when the
  user's last socket disconnects and holds nothing), `dispose()` the session.
- Bounds: cap concurrent sessions (config, default 40 to cover ~30 users + slack);
  when exceeded, evict the least-recently-active idle session; log if a live one
  would be evicted (never silently).

### 4.3 Gateway changes (`market-data.gateway.ts`)
- **Authenticate the socket**: read the JWT from the socket.io handshake
  (`client.handshake.auth.token`), verify with the existing access-token verifier
  (the same one `TokenService.verifyAccess` / the "WS admin verifier" use), attach
  `userId` to the socket, and `client.join(`user:{userId}`)`. Reject/disconnect
  unauthenticated sockets.
- `handleSubscribe`/`handleUnsubscribe` call `UserFeedManager.subscribe/unsubscribe`
  for `socket.userId` (instead of only joining `token:` rooms).
- **Per-user emit**: replace `server.emit('tick')` with
  `server.to(`user:{userId}`).emit('tick', quote)`; same for `candle`. Keep the
  100ms coalescing flush, but coalesce **per (userId, token)**.
- `handleDisconnect` → `UserFeedManager.releaseUser(userId)`.

### 4.4 Config
- `PER_USER_FEED_ENABLED` (feature flag, default true) — lets us fall back to the
  legacy shared feed without a redeploy if needed.
- `USER_FEED_IDLE_TEARDOWN_MS` (default 120_000).
- `USER_FEED_MAX_SESSIONS` (default 40).

## 5. Data flow

1. User opens a chart for token T. Client emits `subscribe { tokens: [T] }` on the
   authenticated `/ws` socket.
2. Gateway → `UserFeedManager.subscribe(userId, [T])`. First subscription for the
   user → create + connect `UserFeedSession` (vault lease → generateSession →
   WebSocketV2). Subscribe T (SNAP_QUOTE).
3. Angel WS emits ticks for T → session emits `tick(userId, quote)` → gateway
   coalesces (100ms) → `server.to(user:{userId}).emit('tick', quote)`.
4. Client `useChartData` renders the forming candle from ticks; closed candles via
   the existing `candle`/live-edge path.
5. On symbol switch/close → `unsubscribe { tokens: [T] }` → ref-count to 0 →
   Angel unsubscribe. On socket disconnect → `releaseUser` → idle teardown.

## 6. Server → browser transport (co-equal fix)

- **Observe**: log the negotiated transport on connect, both ends
  (`socket.conn.transport.name` server-side; `socket.io.engine.transport.name` +
  `upgrade` event client-side). Expose via the existing `window.__wsDiag()`.
- **Prefer WebSocket**: once the upgrade is verified through the Cloudflare Worker
  (which routes `/socket.io/*` via `run_worker_first`, `wrangler.jsonc:25`, and
  passes the Upgrade header, `worker/index.js:26-35`), set the client to
  `transports: ['websocket']` with polling retained only as an explicit fallback
  if the upgrade demonstrably fails (detected via the transport log). Add an
  `upgradeTimeout`.
- **Rooms** (§4.3) replace broadcast — each socket only receives its user's ticks.

## 7. Frontend changes

- **Auth handshake**: pass the access token in `io(ns, { auth: { token } })`
  (`websocket.ts`), and re-auth on token refresh.
- **Explicit subscribe/unsubscribe**: `useChartData` emits `subscribe` on mount /
  symbol change and `unsubscribe` on cleanup (today the client never emits
  `subscribe` — it relied on broadcast).
- **Connection-state UI**: a single badge driven by `state` events + tick
  liveness: **Live · Reconnecting · Delayed (REST) · Market closed · Broker not
  connected**. Replaces the silent `catch` blocks; each failure path sets a state
  instead of swallowing.
- **Gap-fill**: on `reconnected`, trigger the existing REST live-edge refetch to
  fill bars missed while disconnected.
- Keep the 20s REST poll strictly as a fallback, surfaced as "Delayed".

## 8. Reliability, security, cache

- **Security**: raw creds (`password`/`totpSecret`/`apiSecret`) are decrypted only
  inside the vault's short zeroizing lease to call `generateSession`; only the
  daily-expiring session tokens (`jwtToken`/`feedToken`) are held for the WS
  lifetime; nothing logs plaintext (mirror `per-user-broker-session.factory`
  masking). Token strings are cleared on dispose.
- **Market hours**: outside NSE hours, no ticks flow → state = "Market closed",
  chart shows historical only (no misleading "delayed").
- **Cache fix**: include `from`/`to` in the adapter `historicalCache` key (or scope
  the live-window cache to the actual requested window)
  (`angel-one-adapter.service.ts:917`).
- **Observability**: structured per-user logs — feed state transitions, active
  token count, transport, tick-liveness — formalizing the existing TEMP
  diagnostic (`websocket.ts:85-193`).
- **Rate/limits**: per-user WS avoids the shared 3/s REST contention entirely for
  chart symbols; `generateSession` happens once per user per session (on-demand),
  not per subscribe.

## 9. Migration / rollout

- Behind `PER_USER_FEED_ENABLED`. Ship with per-user feed driving the **chart**
  first; leave the shared default-universe feed running for dashboard index tiles /
  watchlist until they are migrated (they read the same gateway; per-user routing
  is additive — those widgets can subscribe their tokens the same way in a
  follow-up).
- No DB schema change required (per-user creds already in the vault;
  `isFeedAccount` remains for any residual shared usage).

## 10. Testing

- **Unit**
  - `UserFeedSession`: connect (fake `WebSocketV2` + fake vault lease),
    subscribe/unsubscribe token accounting, reconnect resubscribes active set,
    dispose closes+zeroizes. No real broker calls.
  - `UserFeedManager`: ref-counting, idle teardown timer, session cap/eviction.
  - Gateway: rejects unauthenticated socket; authenticated socket joins
    `user:{userId}`; a tick for user A never reaches user B's room.
  - Cache-key: two different `[from,to]` windows do not collide.
- **Integration**: authenticated socket → `subscribe` → fake tick → assert
  delivery only to the owning room; disconnect → session torn down.
- **Manual/live** (owner, market hours): open two accounts, confirm each chart
  matches its Angel terminal and neither sees the other's symbols; verified
  transport = `websocket` via `window.__wsDiag()`.

## 11. Risks / open questions

- **Angel per-account WS limits**: ~3 WS connections/account; we use 1 for market
  data per user — order execution uses ephemeral sessions, so no conflict. Confirm
  during implementation that a live feed WS + an order `generateSession` on the
  same account coexist.
- **`generateSession` login rate**: on-demand connect spreads logins; if a burst
  is hit, add a small per-user login mutex + short retry.
- **Free Render tier** (512MB, sleeps): fine for < 30 sessions, but the sleep
  behavior interacts with the keep-warm cron (separate work); note that a cold
  start delays first feed connect — surfaced as "Connecting".
- **Cloudflare WS upgrade**: if it proves unreliable in practice, we keep polling
  but must then tighten the server→browser cadence; the transport log tells us
  which reality we're in before committing.
