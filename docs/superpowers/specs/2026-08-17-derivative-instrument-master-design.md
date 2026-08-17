# Derivatives in the instrument master — design

**Date:** 2026-08-17
**Status:** approved, implementing
**Author:** pairing session

---

## 1. The problem

The `instruments` table holds **cash equities only**:

```
NSE   10,141 rows
BSE   13,098 rows
rows with an expiry:  0
```

Derivatives were deliberately excluded. `InstrumentMasterRefreshCron` skips
them, and its comment explains why: "F&O and commodity contracts carry
strike/expiry/optionType that this flat upsert shape cannot represent." That
reasoning is now stale — the `Instrument` model has `expiry`, `strike` and
`optionType` columns; only the upsert input omits them.

Three subsystems fail as a direct result, and all three failures are silent.

### 1.1 The sentinel is blind on every derivative position

`SentinelTickSource.resolveUnderlying` maps an option token to its underlying
via `getInstrumentByToken(token).name`. For `KEI29SEP265800CE` (token 120317)
that row does not exist, so the lookup returns null and the packet loses:

| Blocked | Because |
|---|---|
| `structure.levelBook`, `nearestSupport`, `nearestResistance` | no underlying name |
| `flow.volumeRatio`, `macro.realFactors` | same `analyze()` call |
| `news.headlines`, `news.freshCount` | news is keyed by underlying |
| `position.underlyingLtp` | no underlying cash token → no spot |
| `position.expiry` | expiry comes from the same row |

Measured on a real verdict: **12 of 24 packet fields blind.** The agent then
reasoned "no evidence the thesis is broken" and returned HOLD — which is
vacuous when it could see nothing, and is the failure mode this whole system
exists to prevent.

### 1.2 OI walls never work

`OiWallService.wallsExtended` needs `OptionsChainService.getExpiries`, which
tries three routes in order:

1. `option_chain_snapshots` — **1 row, ever**
2. `instruments` where expiry is set — **0 rows**
3. the Angel in-memory master — returns 0 in the processes observed

So `getExpiries('NIFTY')` returns `[]`, `wallsExtended` reports `no-options` at
debug level, and the caller sees an empty array indistinguishable from "this
stock has no options". `oi_wall_snapshots` has **0 rows**. The `oiWallShift`
tripwire has therefore never fired.

### 1.3 No expiry means no time reasoning

Without `expiry`, the agent cannot reason about theta. This is not academic: on
the same position, a tool-using agent that decoded the tradingsymbol itself made
decay the centre of its analysis (~₹960/day on a 6-session option), while the
packet-fed agent never mentioned time at all.

---

## 2. The binding constraint

**`instruments` is a de-facto allowlist.** Symbol resolution and Chartink alert
ingestion reject any symbol with no row ("symbol not in local DB"). Adding rows
changes what that table asserts, so the change has to be provably non-disruptive
rather than merely useful.

Two facts make it safe:

- `getInstrumentBySymbol(symbol, exchange)` **always filters by exchange**, so
  no NSE or BSE lookup can begin matching an NFO row.
- `getInstrumentByToken(token)` filters by token, which is unique per row.
  Adding tokens can only make previously-unresolvable tokens resolve — which is
  the entire point — and cannot change an existing answer.

The real cost is size. `InstrumentService` primes a token→id cache from every
active row at boot, so the table's row count is boot memory.

---

## 3. Design

### 3.1 Persist derivative contracts, bounded by expiry AND segment

Extend the refresh to persist NFO and MCX contracts **whose expiry is today or
later**, alongside the existing cash rows. Expired contracts are never written,
and existing rows for lapsed expiries are deactivated on each refresh.

Bounding is what keeps this affordable. Measured against the live master:

```
master rows                 155,535
live derivative contracts   102,564   NFO 35,282 | MCX 16,699 | BFO 40,880 | CDS 9,703
```

We persist NFO and MCX only — 51,981 rows, taking the table from 23,239 to
~75k rather than 102k. BFO (BSE derivatives) and CDS (currency) are excluded
because no position has ever been held in either; adding a segment later is a
one-line change. Every active row is boot memory, since `InstrumentService`
primes a token cache from all of them at startup.

### 3.2 Fields

`UpsertInstrumentInput` gains `expiry`, `strike` and `optionType` — columns the
model already has. Cash rows continue to write them as null, so nothing about
an existing row changes.

`name` carries the **underlying** for a derivative (Angel's master already puts
`KEI` in `name` for `KEI29SEP265800CE`). That single field is what unblocks
§1.1 — the sentinel already reads `.name`; it just found no row.

### 3.3 Segment marker

Rows get `segment` set to the exchange segment (`NFO`, `MCX`, `NSE`, `BSE`) so
any future caller that genuinely wants cash-only can express that, rather than
relying on the table having contained nothing else.

### 3.4 What does NOT change

- The daily 08:00 IST cron and the boot refresh keep their existing shape.
- Cash-equity rows are written exactly as before.
- No caller is modified. The sentinel, the options chain and the news tagger
  all already query for what they need and get nothing; they will simply start
  getting rows.

---

## 4. Out of scope

- **Backfilling `option_chain_snapshots`.** OI *walls* need the chain fetched
  live from the broker; this spec restores the expiry list they depend on, not
  the chain itself. If the chain still fails after this, the cause is the Angel
  session, which is a separate fault.
- **The broken Angel session.** `get_quote` and `get_candles` currently fail
  with "Unsupported state or unable to authenticate data". That blocks live
  quotes across the whole platform and is its own piece of work.
- **Storing the underlying on `trade_trackers`.** Still worth doing — the
  broker hands us `symbolname` free — but it becomes an optimisation once the
  master resolves, not a fix.

---

## 5. How we will know it worked

Verified against production data, not unit tests alone:

1. `SELECT count(*) FROM instruments WHERE expiry IS NOT NULL` > 0
2. `getInstrumentByToken('120317')` returns a row whose `name` is `KEI`
3. `getExpiries('NIFTY')` returns a non-empty list
4. A sentinel packet for a derivative position shows `structure`, `news` and
   `position.expiry` **populated** rather than absent
5. Cash behaviour unchanged: `getInstrumentBySymbol('KEI-EQ','NSE')` still
   returns exactly the row it does today

The row-count growth is recorded at the same time, since it is the one cost
this change carries.

---

## 6. Risks

| Risk | Mitigation |
|---|---|
| Table grows several-fold; boot cache grows with it | Bound by live expiries; measure and record the count |
| An NFO row shadows a cash symbol | Impossible for symbol lookups (exchange-filtered); token lookups are unique |
| A long refresh blocks boot | REALISED ON DEPLOY, 2026-08-17. Nest awaits every `onModuleInit` before `app.listen()`, so the refresh sat in front of the port bind and Render failed the deploy on its port-scan timeout. The boot refresh is now DETACHED (`void … .catch`); the server binds immediately and the master fills in behind it. Batch concurrency also cut 100 -> 25, because the old value saturated the connection pool and killed the Angel auto-login with a 5s transaction timeout. |
