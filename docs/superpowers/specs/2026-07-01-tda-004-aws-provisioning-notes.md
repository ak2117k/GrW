# TDA-004 — AWS Provisioning Notes (Deployment Runbook)

> **Status: deployment-gated — NOT part of the MVP test loop.**
> This document is an Infrastructure-as-Code (IaC) **outline only**. Nothing here
> is executed by the MVP test suite. The local/offline defaults
> (`SECRETS_PROVIDER=local`, `KMS_PROVIDER=local`, in-memory throttler, plain
> Redis/Postgres) are what CI and dev run on. The resources below are stood up
> only when promoting to a real AWS environment, at which point the provider
> factories are flipped via env (`SECRETS_PROVIDER=aws`, `KMS_PROVIDER=aws`).

---

## 0. Provider-flip summary

| Concern | Local default (MVP/CI) | AWS prod |
|---|---|---|
| Secrets | `SECRETS_PROVIDER=local` (env file) | `SECRETS_PROVIDER=aws` (Secrets Manager) |
| Envelope key | `KMS_PROVIDER=local` (in-process) | `KMS_PROVIDER=aws` (KMS CMK) |
| Redis | plain TCP, `REDIS_TLS=false` | `rediss://`, `REDIS_TLS=true` |
| Throttler store | in-memory, `REDIS_THROTTLER=false` | Redis, `REDIS_THROTTLER=true` |
| DB transport | local Postgres | RDS `sslmode=require` + bundled CA |

The `@aws-sdk/client-kms` and `@aws-sdk/client-secrets-manager` packages are
added **only in the prod build** (prod-stage `npm install`), never in the MVP
dependency set. The `SECRETS_PROVIDER=aws` / `KMS_PROVIDER=aws` env values are
what flip the provider factories over to the AWS adapters at boot. CI therefore
needs neither AWS SDK packages nor live AWS endpoints.

---

## 1. KMS — Customer Master Key (CMK)

- Create a symmetric CMK with alias **`alias/td-saas-cmk`**.
- Key policy grants **only the application execution role** (ECS task role / EC2
  instance role) the actions: `kms:Encrypt`, `kms:Decrypt`, `kms:GenerateDataKey`.
  No `kms:*`, no broad principals. Root account retains administrative key
  management only.
- Enable automatic annual key rotation.
- The app uses the CMK for envelope encryption: a per-record data key is produced
  via `GenerateDataKey`, the ciphertext data key is stored alongside the record,
  and `Decrypt` unwraps it at read time. (Envelope columns themselves land in
  TDA-005.)
- `KMS_CMK_ID` env is set to `alias/td-saas-cmk` when `KMS_PROVIDER=aws`.

## 2. Secrets Manager — secret bundle + rotation

- One JSON secret per environment: **`td-saas/<env>`** (e.g. `td-saas/prod`).
- Bundle keys: `JWT_SECRET`, `ENCRYPTION_KEY`, `DATABASE_URL`, plus broker /
  third-party credentials as the platform grows.
- Encrypt the secret with the `alias/td-saas-cmk` CMK above.
- Enable **rotation** (Lambda rotation function); resource policy limits read to
  the execution role only.
- At boot, with `SECRETS_PROVIDER=aws`, the secrets factory fetches and caches
  `td-saas/<env>` and resolves each key through the same accessor used locally —
  no call sites change between local and AWS.

## 3. RDS (PostgreSQL) — TLS in transit

- Require TLS: connection string carries **`sslmode=require`**.
- Ship the **AWS RDS CA bundle** with the deployment and point the client at it
  so the server certificate is verified (not just encrypted).
- `DATABASE_URL` (delivered via the Secrets Manager bundle) encodes the
  `sslmode=require` parameter.

## 4. ElastiCache (Redis) — in-transit encryption

- Provision the Redis cluster with **in-transit encryption** enabled.
- App connects over **`rediss://`** (`REDIS_TLS=true`).
- When `REDIS_THROTTLER=true`, the global and per-account throttlers use this
  cluster as shared storage so limits hold across instances.

## 5. ALB — TLS termination + HSTS

- Application Load Balancer terminates TLS (ACM-managed certificate); HTTP :80
  redirects to HTTPS :443.
- Emit **HSTS** (`Strict-Transport-Security`) on responses (ALB rule or app-level
  `helmet` HSTS — coordinate so it is set exactly once).
- Security groups: only the ALB is internet-facing; app, RDS, and ElastiCache sit
  in private subnets reachable only from the app tier.

---

## Acceptance / scope notes

- This runbook covers **AWS provisioning** (Spec §8). It introduces **no schema
  change and no migration** — envelope-encryption columns are TDA-005.
- Re-confirm at provisioning time that the AWS SDK packages are present only in
  the prod build and that flipping `SECRETS_PROVIDER`/`KMS_PROVIDER` back to
  `local` cleanly restores the offline path.
