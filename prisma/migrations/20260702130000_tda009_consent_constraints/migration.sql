-- TDA-009 — additive consent constraints (forward-only).
--
-- Adds:
--   * a unique index on consent_records(userId, documentId) so POST /accept is
--     an idempotent upsert (one acceptance row per user per document);
--   * an index on consent_documents(kind, active) for the "current active doc
--     for kind" point-lookup.
-- No column changes, no NOT NULL tightening.

-- Prod-safety: if any pre-existing duplicate (userId, documentId) acceptance
-- rows exist, keep only the most-recently accepted one before adding the unique
-- index (the dev DB has none; this keeps the migration safe on populated DBs).
DELETE FROM "consent_records" a
USING "consent_records" b
WHERE a."userId" = b."userId"
  AND a."documentId" = b."documentId"
  AND (
    a."acceptedAt" < b."acceptedAt"
    OR (a."acceptedAt" = b."acceptedAt" AND a."id" < b."id")
  );

-- CreateIndex
CREATE UNIQUE INDEX "consent_records_userId_documentId_key" ON "consent_records"("userId", "documentId");

-- CreateIndex
CREATE INDEX "consent_documents_kind_active_idx" ON "consent_documents"("kind", "active");
