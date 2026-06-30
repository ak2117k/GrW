-- TDA-008: AuditLog hash-chain — phase 2 (SEAL).
--
-- Runs AFTER prisma/audit-backfill.ts has populated seq / prevHash / hash for
-- every pre-existing `audit_logs` row. Tightens `seq` and `prevHash` to
-- NOT NULL and adds the UNIQUE(chainKey, seq) backstop that guards the
-- append() race (per-chain advisory lock + this unique index).
--
-- Forward-only: never edit this file once applied. If the backfill has NOT run,
-- the SET NOT NULL statements will fail (existing rows still have NULL seq) —
-- that failure is intentional and protects against sealing an unbuilt chain.

-- AlterTable
ALTER TABLE "audit_logs" ALTER COLUMN "seq" SET NOT NULL;
ALTER TABLE "audit_logs" ALTER COLUMN "prevHash" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "audit_logs_chainKey_seq_key" ON "audit_logs"("chainKey", "seq");
