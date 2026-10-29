-- repair-paper-option-pnl-2026-10-29.sql
--
-- One-off, idempotent repair of `trades.pnl` on CLOSED paper trades that were
-- booked with the mark-to-market double count (fixed in
-- TradeExecutionService.closeTrade, 2026-10-29).
--
-- The bug: an OPEN paper trade's `pnl` column holds an UNREALISED mark written
-- by OpenPaperTradeRefresherWorker (paper options, every 30 s) and by
-- SignalPaperWatchService (TELEGRAM_SIGNAL_NO_FUNDS, every sweep). closeTrade
-- did `pnl = trade.pnl + slicePnl`, so the close ADDED that mark to the
-- realised P&L: ~2x gross when the last mark sat near the exit price
-- (CRUDEOIL 10400CE -2878 for a -1439 move), mark + gross otherwise
-- (ACUTAAS-EQ -44 = -84.18 + a stale +40.18 mark). `pnlPercent` was always
-- computed from prices only and is correct; `fees` is correct.
--
-- Convention kept: `trades.pnl` is GROSS = side x (exitPrice - entryPrice) x
-- quantity; charges stay in `trades.fees` (net = pnl - fees, as the paper
-- balance replay in PaperTradeService computes it).
--
-- Selection (all must hold):
--   * status = 'CLOSED' AND "isPaperTrade" = true
--   * in scope of one of the two mark-to-market writers:
--       instrument segment = 'OPTIONS'          (refresher, any strategy)
--       OR strategy = 'TELEGRAM_SIGNAL_NO_FUNDS' (signal paper watch, any segment)
--   * entryPrice > 0, exitPrice > 0, quantity > 0
--   * NO 'PARTIAL_EXIT' trade_event: after a partial exit the row's quantity is
--     only the last slice, so pnl cannot be recomputed from the row alone.
--     Those rows are listed separately below for manual review, not updated.
--   * stored pnl differs from the corrected figure by more than 0.01
--     (this is what makes a re-run a no-op).
--
-- NOT run by the author. Run the SELECTs first, read them, then uncomment the
-- UPDATE inside the transaction. Note: the paper virtual balance is replayed
-- from SUM(pnl - fees) on API boot, so after the UPDATE the replayed balance
-- changes by the sum of `delta` below on the next restart.

-- ---------------------------------------------------------------------------
-- 1. DRY RUN: every row the UPDATE would touch, with old/new pnl.
-- ---------------------------------------------------------------------------
WITH candidates AS (
  SELECT
    t.id,
    t.strategy,
    i.symbol,
    i.exchange,
    i.segment,
    t.side,
    t.quantity,
    t."entryPrice",
    t."exitPrice",
    t.fees,
    t."exitTime",
    t.pnl AS old_pnl,
    ROUND(
      ((CASE WHEN UPPER(t.side) = 'BUY' THEN 1 ELSE -1 END)
        * (t."exitPrice" - t."entryPrice") * t.quantity)::numeric,
      2
    ) AS new_pnl
  FROM trades t
  JOIN instruments i ON i.id = t."instrumentId"
  WHERE t.status = 'CLOSED'
    AND t."isPaperTrade" = true
    AND (i.segment = 'OPTIONS' OR t.strategy = 'TELEGRAM_SIGNAL_NO_FUNDS')
    AND t."entryPrice" > 0
    AND t."exitPrice" > 0
    AND t.quantity > 0
    AND NOT EXISTS (
      SELECT 1 FROM trade_events e
      WHERE e."tradeId" = t.id AND e."eventType" = 'PARTIAL_EXIT'
    )
)
SELECT
  id, strategy, symbol, exchange, segment, side, quantity,
  "entryPrice", "exitPrice", fees, "exitTime",
  old_pnl, new_pnl, ROUND((new_pnl - COALESCE(old_pnl, 0)::numeric), 2) AS delta
FROM candidates
WHERE old_pnl IS NULL OR ABS(old_pnl::numeric - new_pnl) > 0.01
ORDER BY "exitTime" DESC NULLS LAST;

-- Summary of the same set by strategy / segment.
WITH candidates AS (
  SELECT
    t.strategy,
    i.segment,
    t.pnl AS old_pnl,
    ROUND(
      ((CASE WHEN UPPER(t.side) = 'BUY' THEN 1 ELSE -1 END)
        * (t."exitPrice" - t."entryPrice") * t.quantity)::numeric,
      2
    ) AS new_pnl
  FROM trades t
  JOIN instruments i ON i.id = t."instrumentId"
  WHERE t.status = 'CLOSED'
    AND t."isPaperTrade" = true
    AND (i.segment = 'OPTIONS' OR t.strategy = 'TELEGRAM_SIGNAL_NO_FUNDS')
    AND t."entryPrice" > 0
    AND t."exitPrice" > 0
    AND t.quantity > 0
    AND NOT EXISTS (
      SELECT 1 FROM trade_events e
      WHERE e."tradeId" = t.id AND e."eventType" = 'PARTIAL_EXIT'
    )
)
SELECT
  strategy, segment, COUNT(*) AS rows_to_fix,
  ROUND(SUM(COALESCE(old_pnl, 0))::numeric, 2) AS old_sum,
  ROUND(SUM(new_pnl), 2) AS new_sum,
  ROUND(SUM(new_pnl - COALESCE(old_pnl, 0)::numeric), 2) AS delta_sum
FROM candidates
WHERE old_pnl IS NULL OR ABS(old_pnl::numeric - new_pnl) > 0.01
GROUP BY strategy, segment
ORDER BY rows_to_fix DESC;

-- Partially-exited closed paper trades in the same scope: NOT updated (the row
-- no longer holds the full quantity). Their first partial slice may also carry
-- a mark; review by hand against trade_events if any appear.
SELECT t.id, t.strategy, i.symbol, t.side, t.quantity, t."entryPrice", t."exitPrice", t.pnl
FROM trades t
JOIN instruments i ON i.id = t."instrumentId"
WHERE t.status = 'CLOSED'
  AND t."isPaperTrade" = true
  AND (i.segment = 'OPTIONS' OR t.strategy = 'TELEGRAM_SIGNAL_NO_FUNDS')
  AND EXISTS (
    SELECT 1 FROM trade_events e
    WHERE e."tradeId" = t.id AND e."eventType" = 'PARTIAL_EXIT'
  )
ORDER BY t."exitTime" DESC NULLS LAST;

-- ---------------------------------------------------------------------------
-- 2. REPAIR (commented out on purpose). Idempotent: a second run matches 0 rows.
-- ---------------------------------------------------------------------------
-- BEGIN;
--
-- UPDATE trades t
-- SET pnl = ROUND(
--       ((CASE WHEN UPPER(t.side) = 'BUY' THEN 1 ELSE -1 END)
--         * (t."exitPrice" - t."entryPrice") * t.quantity)::numeric,
--       2
--     )::double precision,
--     "updatedAt" = NOW()
-- FROM instruments i
-- WHERE i.id = t."instrumentId"
--   AND t.status = 'CLOSED'
--   AND t."isPaperTrade" = true
--   AND (i.segment = 'OPTIONS' OR t.strategy = 'TELEGRAM_SIGNAL_NO_FUNDS')
--   AND t."entryPrice" > 0
--   AND t."exitPrice" > 0
--   AND t.quantity > 0
--   AND NOT EXISTS (
--     SELECT 1 FROM trade_events e
--     WHERE e."tradeId" = t.id AND e."eventType" = 'PARTIAL_EXIT'
--   )
--   AND (
--     t.pnl IS NULL
--     OR ABS(t.pnl::numeric - ROUND(
--          ((CASE WHEN UPPER(t.side) = 'BUY' THEN 1 ELSE -1 END)
--            * (t."exitPrice" - t."entryPrice") * t.quantity)::numeric,
--          2
--        )) > 0.01
--   );
--
-- -- Check the row count matches the dry run, then:
-- COMMIT;   -- or ROLLBACK;
