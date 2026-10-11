-- SP1 M5: option chain + OI snapshots on the market hub.
-- oiChange is NULL when there is no previous-session baseline ("unknown" is not 0).
ALTER TABLE "oi_snapshots" ALTER COLUMN "oiChange" DROP NOT NULL;
ALTER TABLE "oi_snapshots" ALTER COLUMN "oiChange" DROP DEFAULT;
-- 30-day prune scans by time.
CREATE INDEX IF NOT EXISTS "oi_snapshots_timestamp_idx" ON "oi_snapshots"("timestamp");
-- Chain contract lookup: name + expiry over every derivative contract in the master.
CREATE INDEX IF NOT EXISTS "instruments_name_expiry_idx" ON "instruments"("name", "expiry");
