-- TDA-011: ExecutionClaim local idempotency store (forward-only, additive).
--
-- At-most-once backstop for the per-user auto-execution pipeline. A CLAIMED row
-- is inserted BEFORE any side effect (credential decrypt / broker order); the
-- unique index on "idempotencyKey" is the concurrency guarantee — two concurrent
-- jobs with the same key → exactly one wins the INSERT, the loser hits P2002 and
-- is silently skipped by the caller. NOT tenant-scoped (worker writes cross-user).

CREATE TABLE "execution_claims" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'CLAIMED',
    "brokerOrderId" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "execution_claims_pkey" PRIMARY KEY ("id")
);

-- The concurrency backstop: one CLAIMED row per (signal, user).
CREATE UNIQUE INDEX "execution_claims_idempotencyKey_key" ON "execution_claims"("idempotencyKey");

CREATE INDEX "execution_claims_userId_entryId_idx" ON "execution_claims"("userId", "entryId");
