-- TDA-005: BrokerCredential keyVersion -> String + rotation/display columns (forward-only).
--
-- keyVersion was INTEGER (TDA-001 default 1); it now holds KmsProvider.keyVersion()
-- (a string, e.g. 'local-v1' or a CMK id). Cast existing rows in place, then reset
-- the default so new rows land on the local KEK version.
ALTER TABLE "broker_credentials"
  ALTER COLUMN "keyVersion" DROP DEFAULT,
  ALTER COLUMN "keyVersion" TYPE TEXT USING "keyVersion"::text,
  ALTER COLUMN "keyVersion" SET DEFAULT 'local-v1';

-- Non-secret masked client-id for the status view (§4.1) — no backfill (nullable).
ALTER TABLE "broker_credentials" ADD COLUMN "clientIdMasked" TEXT;

-- Observability for the KEK re-wrap job (§7) — nullable, no backfill.
ALTER TABLE "broker_credentials" ADD COLUMN "lastRotatedAt" TIMESTAMP(3);
