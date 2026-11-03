-- rollback-paper-pnl-2026-11-03.sql
--
-- Undoes a COMMITTED run of repair-paper-pnl-2026-11-03.sql from its backup tables:
--   * trades.pnl / "pnlPercent" / "instrumentId" restored to the values held before the first repair;
--   * the instruments rows the repair inserted are deleted when nothing references them any more.
-- NOT run by the author. Ends in ROLLBACK (dry run): read the counts, change the last line to COMMIT.
-- Re-runnable; the backup tables are kept (drop them by hand once the repair is accepted).
--
--     psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/ops/rollback-paper-pnl-2026-11-03.sql

BEGIN;

\echo '== rows to restore =='
SELECT b.reason, COUNT(*) AS rows,
       COUNT(*) FILTER (WHERE t.pnl IS DISTINCT FROM b.pnl) AS pnl_changed,
       COUNT(*) FILTER (WHERE t."instrumentId" IS DISTINCT FROM b."instrumentId") AS link_changed
FROM trades_repair_backup_20261103 b JOIN trades t ON t.id = b.id
GROUP BY b.reason;

UPDATE trades t
SET pnl = b.pnl, "pnlPercent" = b."pnlPercent", "instrumentId" = b."instrumentId", "updatedAt" = NOW()
FROM trades_repair_backup_20261103 b
WHERE b.id = t.id
  AND (t.pnl IS DISTINCT FROM b.pnl OR t."pnlPercent" IS DISTINCT FROM b."pnlPercent" OR t."instrumentId" IS DISTINCT FROM b."instrumentId");

\echo '== inserted instruments removed (still referenced ones are kept and listed) =='
DELETE FROM instruments i
USING instruments_repair_inserted_20261103 r
WHERE i.id = r.id
  AND NOT EXISTS (SELECT 1 FROM trades t WHERE t."instrumentId" = i.id)
  AND NOT EXISTS (SELECT 1 FROM candles c WHERE c."instrumentId" = i.id)
  AND NOT EXISTS (SELECT 1 FROM oi_snapshots o WHERE o."instrumentId" = i.id)
  AND NOT EXISTS (SELECT 1 FROM signals s WHERE s."instrumentId" = i.id)
  AND NOT EXISTS (SELECT 1 FROM alerts a WHERE a."instrumentId" = i.id);
DELETE FROM instruments_repair_inserted_20261103 r WHERE NOT EXISTS (SELECT 1 FROM instruments i WHERE i.id = r.id);
SELECT r.* FROM instruments_repair_inserted_20261103 r;

ROLLBACK;  -- DRY RUN. Change to COMMIT to apply.
