-- TDA-008: AuditLog hash-chain — phase 1 (additive, NULLABLE seq).
--
-- Adds the `chainKey` and `seq` columns plus the (chainKey, seq) lookup index.
-- `seq` is deliberately left NULLABLE and `prevHash` is left NULLABLE here so
-- the idempotent JS backfill (prisma/audit-backfill.ts) can populate seq /
-- prevHash / hash for the existing rows BEFORE the NOT NULL + UNIQUE
-- constraints are sealed in the follow-up migration
-- (20260701120100_tda008_audit_chain_seal).
--
-- Forward-only: do NOT add SET NOT NULL or the UNIQUE index here, and never
-- edit this file once applied.

-- AlterTable
ALTER TABLE "audit_logs" ADD COLUMN "chainKey" TEXT NOT NULL DEFAULT 'global';
ALTER TABLE "audit_logs" ADD COLUMN "seq" BIGINT;

-- CreateIndex
CREATE INDEX "audit_logs_chainKey_seq_idx" ON "audit_logs"("chainKey", "seq");
