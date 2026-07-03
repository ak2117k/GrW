# Production Re-Architecture — Master Roadmap & Spec Registry

**Doc ID:** TDA-ROADMAP
**Date:** 2026-06-27
**Status:** Active — planning
**Owner:** development@panamoure.com

> This is the **index** for the production re-architecture of TD Automation
> (dev → production). Each `TDA-###` below gets its own detailed design spec
> (`docs/superpowers/specs/YYYY-MM-DD-tda-###-<topic>-design.md`) and
> implementation plan when its sprint starts. This file tracks the whole program.

---

## 1. Product model (locked decisions)

| Decision | Choice |
|---|---|
| Tenancy | **Public SaaS**, anyone signs up. User *is* the tenant (BYO broker account). |
| Broker connection | **Bring-your-own Angel One** SmartAPI credentials (key, secret, client-id, password/PIN, TOTP secret), encrypted per-tenant. |
| Signal model | **Centralized proprietary engine** — same intraday/swing calls for all subscribers (the IP). Signal **source/provenance is never exposed**. |
| Product surface | **Two sections only: Intraday and Swing.** |
| Plans | Intraday and Swing are **separate subscriptions** (plan-gating). |
| Execution | **Opt-in auto-execution** per user, consent-gated, with per-user risk sizing + kill switch. |
| Mobile | **React Native, later** → API-first + token auth designed in now. |
| Hosting | **AWS** (KMS, RDS Postgres, ElastiCache Redis, Secrets Manager). |
| Encryption at rest | **TLS in transit + encrypted volumes for all data**, **plus per-tenant envelope field-encryption** for sensitive fields (broker creds, TOTP, tokens, PII). |
| First milestone | **Secure multi-user MVP first**, harden (HA/billing) iteratively. |

---

## 2. Architectural approach

**Evolve the modular monolith** (`apps/api`, NestJS) rather than rewrite or split into
microservices. Add identity, tenancy, the credential vault, the IP boundary, audit, and
the fan-out engine as additive layers, reusing the existing reliability foundation
(WS backoff/resubscribe, Bull queues, cron jobs).

**One deliberate seam:** the **order-execution + credential-decryption path** is built as an
internally isolated module with the sole KMS grant, so it can later lift out into a
separate hardened service/VPC without a rewrite.

### Target data flow

```
Market data ─► CENTRAL SIGNAL ENGINE (IP, provenance lives ONLY here)
                       │ raw signal (full internals)
                       ▼
                  SANITIZER (outbound DTO allowlist — strips source/strategy/scanner)
                       │ {symbol, side, entry, target, stop, segment}
                       ▼
              FAN-OUT  ── per eligible user (subscribed + connected + auto-on):
                 1. subscription gate (intraday/swing)
                 2. consent + kill-switch + risk limits
                 3. decrypt THIS user's Angel One creds (KMS, in-memory, zeroized)
                 4. size order to user's capital/risk
                 5. place order (idempotency key = hash(signalId+userId))
                 6. append-only hash-chained AuditLog
```

---

## 3. Sub-project decomposition

| # | Sub-project | Phase | Sprint | Specs |
|---|---|---|---|---|
| 1 | Identity & Tenancy foundation | MVP | S1 | TDA-001..003 |
| 2 | Per-tenant Credential Vault + KMS envelope encryption | MVP | S2 | TDA-005 |
| 3 | Transport security & secrets | MVP | S2 | TDA-004 |
| 4 | Audit & tamper-evident log + Consent gate | MVP | S4 | TDA-008..009 |
| 5 | IP/provenance boundary + sanitized Intraday/Swing surface | MVP | S3 | TDA-006..007 |
| 6 | Signal fan-out & opt-in auto-execution | MVP | S5 | TDA-010..011 |
| 7 | Reliability & data-integrity hardening (HA) | Harden | S6 | TDA-012..013 |
| 8 | Landing page + Billing/payments | Harden | S7 | TDA-014..015 |
| 9 | Mobile (React Native) | Later | S8 | TDA-016 |

---

## 4. Sprint plan & spec registry

Status legend: `Not started` · `In design` · `In progress` · `In review` · `Done`

### Sprint S1 — Identity & Tenancy  *(MVP)*

| Spec | Title | Depends on | Status |
|---|---|---|---|
| **TDA-001** | Multi-tenant data model & migration | — | ✅ Done (merged c6defef; fresh-start on new DB `td_saas`) |
| **TDA-002** | Auth: signup/login, JWT access+refresh, email verify, reset, optional MFA | TDA-001 | Not started |
| **TDA-003** | Tenant isolation: `TenantGuard` + Prisma auto-scoping, RBAC | TDA-001, TDA-002 | Not started |

**TDA-001 scope:** Add `User` (= tenant), `Subscription { userId, segment INTRADAY|SWING, status, expiresAt }`,
`AutoTradeConsent`, `AuditLog`, vault shape on `BrokerCredential` (no plaintext fields). Add `userId` to every
user-owned table (`Trade`, positions, journal). Keep `Signal`/`Candle`/`Instrument` global (not user data).
Write a reversible migration + backfill plan for existing single-user data.

**TDA-002 scope:** Argon2id password hashing; access token (15 min) + rotating refresh token (30 d, hashed,
revocable); email verification; password reset; optional user-level TOTP MFA (separate from broker TOTP).
Mobile-ready, stateless.

**TDA-003 scope:** Global `TenantGuard` on authenticated routes; Prisma middleware auto-injecting
`where: { userId }` on tenant-owned models so unscoped queries are structurally impossible; RBAC roles
`USER`, `ADMIN` (ADMIN runs the engine / sees provenance).

### Sprint S2 — Secrets, Transport & Credential Vault  *(MVP)*

| Spec | Title | Depends on | Status |
|---|---|---|---|
| **TDA-004** | AWS baseline: KMS CMK, Secrets Manager, TLS, kill default key, headers/CORS/rate-limit | — (parallel w/ S1) | Planned (spec+plan 2026-07-01-tda-004) |
| **TDA-005** | Per-tenant credential vault + envelope encryption; "Connect Angel One" flow | TDA-001, TDA-004 | Planned (spec+plan 2026-07-02-tda-005) |

**TDA-004 scope:** Provision KMS customer master key; move all secrets to AWS Secrets Manager; remove the
hardcoded `ENCRYPTION_KEY` fallback (`td-automation-default-key-change-me`); enforce TLS on API, AI-engine,
and DB connections; security headers, strict CORS, global rate limiting.

**TDA-005 scope:** Envelope encryption — KMS CMK wraps a **per-user data key**; the 5 Angel One fields are
AES-256-GCM encrypted with that data key; `encDataKey` stored wrapped, `keyVersion` tracked. Decryption only
inside the isolated execution module (sole KMS grant); plaintext used in-memory then zeroized, never logged.
"Connect Angel One" UX: validate creds via a test login before saving. Key-rotation re-wrap job.

### Sprint S3 — IP Boundary & Product Surface  *(MVP)*

| Spec | Title | Depends on | Status |
|---|---|---|---|
| **TDA-006** | IP/provenance boundary: outbound DTO allowlist + log redaction | TDA-001 | ✅ Done (merged 7568d03; 55/55 tests; whole-branch review caught+fixed 3 extra leaks) |
| **TDA-007** | Sanitized Intraday/Swing API + frontend collapse to 2 sections | TDA-006, TDA-003 | Planned (spec + plan `2026-06-29-tda-007-user-surface.md`) — execute AFTER TDA-006 merges |

**TDA-006 scope:** A single sanitizer (shipped as `toPublicEntry()` on the anand Intraday/Swing entries — the
data-flow diagram above says `toPublicSignalDto()`, but the real symbol is `toPublicEntry()`) is the only
serializer that emits a signal outward (REST +
WebSocket); it physically cannot include `scanner`, `strategy`, `source`, `gate`, `rejectionReason`. CI test
fails if a forbidden field appears in any public payload. Log redactor for provenance. Provenance accessible
only via an `ADMIN`-only internal endpoint.

**TDA-007 scope:** Frontend reduced to **Intraday** and **Swing** sections; all 14-strategy / scanner / rejection
internals removed from the user-facing app and mobile API. Plan-gated visibility.

### Sprint S4 — Audit & Consent  *(MVP)*

| Spec | Title | Depends on | Status |
|---|---|---|---|
| **TDA-008** | Tamper-evident, hash-chained audit log | TDA-001 | Planned (spec+plan 2026-07-01-tda-008) |
| **TDA-009** | Versioned consent & disclaimer gate | TDA-002, TDA-008 | Planned (spec+plan 2026-07-02-tda-009) |

**TDA-008 scope:** Append-only `AuditLog` where each row stores `hash = H(prevHash + payload)` (tamper-evident).
Covers auth events, credential access/decrypt, consent changes, every order. `ADMIN`-readable, exportable.

**TDA-009 scope:** Versioned, content-hash-pinned disclaimer/risk-disclosure. Auto-execution is blocked until
the current version is accepted; version bump forces re-consent. Each acceptance recorded in `AuditLog` with
timestamp + IP. First-line legal defense for a public auto-trading product.

### Sprint S5 — Signals & Auto-Execution  *(MVP)*

| Spec | Title | Depends on | Status |
|---|---|---|---|
| **TDA-010** | Central signal sanitization + fan-out engine | TDA-005, TDA-006 | Planned (spec+plan 2026-07-02-tda-010) |
| **TDA-011** | Opt-in auto-execution: consent-gated, per-user risk, idempotency, kill switch | TDA-009, TDA-010 | Planned (spec+plan 2026-07-02-tda-011) |

**TDA-010 scope:** Central signal → one `signal.fanout` job → one `execute.user` job per eligible user.
Per-user Angel One key = independent 10-req/sec bucket. Failure isolation (one user's failure cannot block
others); retries with backoff; dead-letter queue.

**TDA-011 scope:** Per-job pipeline: subscription gate → consent/kill-switch → risk sizing → decrypt → place
order with idempotency key `hash(signalId+userId)` (broker dedupe + local guard) → audit. Reuse existing risk
backstops; add per-user `killSwitch` and global `LIVE_TRADING_ENABLED`.

### Sprint S6 — Reliability & Data Integrity  *(Harden)*

| Spec | Title | Depends on | Status |
|---|---|---|---|
| **TDA-012** | DB transactions on multi-step trades, idempotency store, exit race fixes | TDA-011 | Not started |
| **TDA-013** | HA infra: RDS Multi-AZ, ElastiCache, horizontal API scaling | TDA-004 | Not started |

### Sprint S7 — Landing & Billing  *(Harden)*

| Spec | Title | Depends on | Status |
|---|---|---|---|
| **TDA-014** | Public landing page + signup funnel | TDA-002 | Planned (spec+plan 2026-07-01-tda-014) |
| **TDA-015** | Billing/subscriptions/payments + plan-gating enforcement | TDA-001, TDA-014 | Planned (spec+plan 2026-07-03-tda-015, Razorpay) |

### Sprint S8 — Mobile  *(Later)*

| Spec | Title | Depends on | Status |
|---|---|---|---|
| **TDA-016** | React Native app (auth, intraday/swing, consent, positions) | TDA-007, TDA-011 | Not started |

---

## 5. Dependency graph (critical path)

```
TDA-001 ─┬─► TDA-002 ─► TDA-003 ─► TDA-007
         ├─► TDA-006 ─► TDA-007
         ├─► TDA-008 ─► TDA-009 ─► TDA-011
         └─► TDA-005 (needs TDA-004) ─► TDA-010 ─► TDA-011 ─► TDA-012
TDA-004 ─► TDA-005 ; TDA-004 ─► TDA-013
TDA-002 ─► TDA-014 ─► TDA-015
TDA-007, TDA-011 ─► TDA-016
```

Critical path to a sellable MVP: **TDA-001 → 005 → 010 → 011** (with 002/003/006/008/009 as required gates).

---

## 6. Definition of Done — MVP (S1–S5)

A new user can: sign up publicly → verify email → subscribe to Intraday and/or Swing →
connect their Angel One account (encrypted per-tenant) → accept the consent/disclaimer →
opt into auto-execution → receive **sanitized** central signals (no provenance) for their
subscribed segment(s) → have orders auto-placed on their own account, sized to their risk,
idempotent → with every action recorded in a tamper-evident audit log. No plaintext secrets
anywhere; TLS everywhere; tenant data isolation enforced structurally.

---

## 7. Open risks to validate (not blocking MVP build)

- **Regulatory (SEBI):** public auto-trading-against-own-broker model — validate the
  "execution tool" positioning; the consent gate (TDA-009) is the first mitigation.
- **Angel One ToS:** confirm third-party multi-user automation is permitted under SmartAPI terms.
- **Liability:** disclaimer wording to be reviewed by legal before public launch (Harden phase).

---

## 8. Carried-forward follow-ups (from completed sprints)

**From TDA-002 (auth) — final whole-branch review, non-blocking:**
- `POST /auth/resend-verification` — specced (§5/§7) but not implemented; an unverified user who loses the email is currently stuck. Small follow-up — implement a throttled public endpoint that re-mints an EMAIL_VERIFY token for a PENDING user (generic response).
- **Per-account rate limiting + durable throttler storage** — login/forgot are currently per-IP and in-memory only. Add a per-account limiter (keyed on normalized email) and move throttler storage to **Redis** so limits hold across API replicas. Folds into **TDA-004** (infra/secrets) since it needs Redis.
- Minor hardening for TDA-004/005: password strength check in `PasswordService`; pin `algorithms:['HS256']` in `loginMfa`; boot-time assertion that `JWT_SECRET`/`ENCRYPTION_KEY` are set; optional `AUTH_EMAIL_VERIFIED` audit row; DRY the duplicated `sha256`/`audit` helpers.
- TOTP replay-within-window protection (record consumed step) — TDA-005.

**From TDA-003 (tenant isolation) — BUILD-BLOCKER follow-up (high priority):**
- `apps/api` has **~159 pre-existing TypeScript errors** (since TDA-001 made `userId` NOT NULL on tenant-owned models). Existing engine services (broker, ai-advisor, alerts, market-data, chartink, signal-generator) create/read `Trade`/`UserSettings`/`Alert`/`AI*` rows WITHOUT a `userId`, so they no longer type-check — `nest build` fails. Tests pass because ts-jest transpiles per-file (no cross-file type check). **The new `td_saas` backend does not build/run end-to-end yet.** Remediation = make every engine write to a tenant-owned model supply a `userId` (engine/paper rows → ADMIN; real user rows arrive via the fan-out in TDA-010/011). Partly mechanical (stamp ADMIN), partly entangled with the centralized fan-out design. Recommend a dedicated remediation pass (call it **TDA-003b**) before or alongside TDA-010/011. Also fix `@td/shared` moduleResolution errors (likely a tsconfig path issue, may predate the re-architecture).

**TDA-003b (build/run remediation) — DONE (merged):** Key correction: the app **builds via SWC** (`nest-cli` `builder:swc`, `typeCheck:false`), so the ~159 `tsc` errors are **type-safety debt, not runtime blockers**. Fixed the real runtime blockers: `ClsModule.forRoot({ global: true })` (app now boots on `td_saas`), and stamped the seeded ADMIN `userId` (`SYSTEM_USER_ID`) on the 8 engine writes to tenant-owned models (Trade/Alert/UserSettings/DailyPerformance/AITradeAnalysis/AIWeeklyReport). App boots clean; 44 tenant tests pass. Remaining follow-ups: (a) `broker.service` credential flow still uses the removed plaintext fields → rebuilt in **TDA-005**; (b) `DailyPerformance`/`UserSettings` still single-column `@unique` (correct only while ADMIN-only) → make composite with `userId` when they go per-user; (c) ~159 `tsc` type-debt errors (largely `@td/shared` exports-vs-moduleResolution) — optional cleanup, non-blocking since SWC builds.
