-- Undo the 2026-11-06 deactivation of expired derivative instrument rows.
-- What was done: 60,360 NFO/BFO/MCX rows with expiry < 2026-11-06 IST were set isActive=false, skipping any
-- row an OPEN trade or OPEN tracker uses (the 9 stale scanner paper trades' contracts stayed active).
-- Why: NSE/MCX reuse instrument tokens after expiry. Token lookups resolved live positions to expired
-- contracts (NIFTY09NOV2624300CE -> COFORGE29SEP262240CE; BHARTIARTL23NOV262100CE -> BANKINDIA25AUG26137.5CE,
-- lot 5200, which blocked 91 exits as LOT_SIZE_MISMATCH).
-- The backup table instruments_deactivate_backup_20261106 holds id, exchange, symbol, token, expiry and the old
-- isActive/updatedAt.
BEGIN;
UPDATE instruments i SET "isActive" = b."isActive" FROM instruments_deactivate_backup_20261106 b WHERE b.id = i.id;
COMMIT;
