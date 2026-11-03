-- repair-paper-pnl-2026-11-03.sql
--
-- One-off, idempotent repair of CLOSED paper trades' P&L and of paper trades linked to the wrong
-- contract by a reused token. NOT run by the author. Run it whole with psql:
--
--     psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/ops/repair-paper-pnl-2026-11-03.sql
--
-- As shipped it ends in ROLLBACK: a complete DRY RUN that executes every statement, prints the
-- before / after rows and totals, and persists nothing. Read the output, then change the last line
-- to COMMIT and run it again. A second committed run changes 0 rows (idempotent).
-- Undo after a COMMIT: scripts/ops/rollback-paper-pnl-2026-11-03.sql.
--
-- WHAT pnl IS SET TO — GROSS, not gross − fees (deliberate; read before changing):
--   trades.pnl is GROSS side × (exitPrice − entryPrice) × quantity everywhere in the app; charges live in
--   trades.fees. The paper balance replay (PaperTradeService.onModuleInit: balance += pnl − fees), the
--   sanity audit's PNL_ARITHMETIC check (pnl must equal gross), strategy-review (net = pnl − fees) and
--   the 2026-10-29 repair all rely on it. The "gap = fees" seen on 30 Oct – 2 Nov rows is that convention,
--   not a bug: writing gross − fees into pnl would subtract the fees TWICE in the balance replay and make
--   the sanity audit flag every repaired row. The net figure is shown below (net_pnl) and is now reported
--   by the signal paper summary (charges / net / netRealised).
--   What this repairs is pnl that is not even gross:
--     * 28–29 Oct: the mark-to-market double count (closeTrade added the open mark; fixed 0a5c8ca).
--     * a stale mark written AFTER the close by the paper watch / open-paper refresher (fixed 2026-11-03,
--       TradeRepository.markOpenTrade is OPEN-only): BSE23NOV263600CE qty 200, 175.6667 → 175.5, gross
--       −33.34, stored −363.34 (= the mark at LTP 173.85). pnlPercent was overwritten by the same mark,
--       so it is recomputed too.
--
-- NOTE: instruments.segment holds the EXCHANGE segment (NFO / BFO / MCX / NSE …, the instrument-master
-- refresh convention), NOT 'OPTIONS' — the 2026-10-29 script's `segment = 'OPTIONS'` filter matched
-- nothing for master rows. This script does not filter on segment at all.
--
-- Selection
--   (c) P&L: trades.status = 'CLOSED', "isPaperTrade", "entryTime" >= 2026-10-28 (IST day start),
--       entry / exit / quantity > 0, NO PARTIAL_EXIT trade_event (the row then holds only the last slice:
--       listed for manual review, not updated), |pnl − gross| > ₹1.
--   (d) Contract link: TELEGRAM_SIGNAL_NO_FUNDS paper trades (any status — an OPEN one linked to an
--       expired contract is closed by the paper watch on that contract's "expiry"), "entryTime" >=
--       2026-10-28, whose entryReason names "(decision <id>)" and whose linked instruments.symbol differs
--       from the decision's tradingsymbol (plan->>'tradingsymbol', else the instrument_resolved gate
--       check's detail "SYM (EXCH:TOKEN) lot N …"). Relinked to the instruments row with that symbol on
--       that exchange (the plan's token preferred); inserted when missing (segment = exchange,
--       expiry / strike / option type parsed from the tradingsymbol, as SignalPaperService does).

BEGIN;

-- ---------------------------------------------------------------------------------------------------
-- 0. Backup tables (kept after COMMIT; the rollback script reads them). First write wins: a re-run
--    never overwrites the original values.
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trades_repair_backup_20261103 (
  id               text PRIMARY KEY,
  pnl              double precision,
  "pnlPercent"     double precision,
  "instrumentId"   text NOT NULL,
  reason           text NOT NULL,
  backed_up_at     timestamptz NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS instruments_repair_inserted_20261103 (
  id               text PRIMARY KEY,
  symbol           text NOT NULL,
  exchange         text NOT NULL,
  token            text NOT NULL,
  inserted_at      timestamptz NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------------------------------
-- Working sets
-- ---------------------------------------------------------------------------------------------------
CREATE TEMP TABLE pnl_fix ON COMMIT DROP AS
SELECT
  t.id, t.strategy, i.symbol, t.side, t.quantity, t."entryPrice", t."exitPrice", t.fees, t."entryTime", t."exitTime",
  t.pnl AS old_pnl, t."pnlPercent" AS old_pct,
  ROUND(((CASE WHEN UPPER(t.side) = 'SELL' THEN -1 ELSE 1 END) * (t."exitPrice" - t."entryPrice") * t.quantity)::numeric, 2) AS gross,
  ROUND(((CASE WHEN UPPER(t.side) = 'SELL' THEN -1 ELSE 1 END) * (t."exitPrice" - t."entryPrice") / t."entryPrice" * 100)::numeric, 2) AS new_pct
FROM trades t
JOIN instruments i ON i.id = t."instrumentId"
WHERE t.status = 'CLOSED'
  AND t."isPaperTrade" = true
  AND t."entryTime" >= TIMESTAMPTZ '2026-10-28 00:00:00+05:30'
  AND t."entryPrice" > 0 AND t."exitPrice" > 0 AND t.quantity > 0
  AND NOT EXISTS (SELECT 1 FROM trade_events e WHERE e."tradeId" = t.id AND e."eventType" = 'PARTIAL_EXIT');
DELETE FROM pnl_fix WHERE old_pnl IS NOT NULL AND ABS(old_pnl::numeric - gross) <= 1;

CREATE TEMP TABLE link_fix ON COMMIT DROP AS
WITH paper AS (
  SELECT t.id, t.status, t."instrumentId", t."entryTime", i.symbol AS linked_symbol, i.token AS linked_token,
         i.expiry AS linked_expiry, substring(t."entryReason" FROM '\(decision ([^)[:space:]]+)\)') AS decision_id
  FROM trades t
  JOIN instruments i ON i.id = t."instrumentId"
  WHERE t."isPaperTrade" = true
    AND t.strategy = 'TELEGRAM_SIGNAL_NO_FUNDS'
    AND t."entryTime" >= TIMESTAMPTZ '2026-10-28 00:00:00+05:30'
), resolved AS (
  SELECT p.*, d.underlying,
         (SELECT g->>'detail' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(d.gate::jsonb) = 'array' THEN d.gate::jsonb ELSE '[]'::jsonb END) g
           WHERE g->>'name' = 'instrument_resolved' LIMIT 1) AS gate_detail,
         d.plan::jsonb AS plan
  FROM paper p
  JOIN signal_decisions d ON d.id = p.decision_id
), wanted AS (
  SELECT r.*,
         COALESCE(NULLIF(r.plan->>'tradingsymbol', ''), substring(r.gate_detail FROM '^(\S+) \(')) AS want_symbol,
         COALESCE(NULLIF(r.plan->>'exchange', ''), substring(r.gate_detail FROM '^\S+ \(([A-Z]+):')) AS want_exchange,
         COALESCE(NULLIF(r.plan->>'token', ''), substring(r.gate_detail FROM '^\S+ \([A-Z]+:([^)]+)\)')) AS want_token,
         NULLIF(r.plan->>'lotSize', '')::numeric AS plan_lot,
         COALESCE(NULLIF(r.plan->>'tickSize', '')::double precision, 0.05) AS plan_tick,
         substring(r.gate_detail FROM ' lot ([0-9]+)')::int AS gate_lot
  FROM resolved r
)
SELECT w.*,
       (SELECT i2.id FROM instruments i2
         WHERE i2.symbol = w.want_symbol AND i2.exchange = w.want_exchange
         ORDER BY (i2.token = w.want_token) DESC, i2.expiry DESC NULLS LAST, i2."updatedAt" DESC
         LIMIT 1) AS target_id
FROM wanted w
WHERE w.want_symbol IS NOT NULL AND w.want_exchange IS NOT NULL AND w.want_token IS NOT NULL
  AND w.linked_symbol IS DISTINCT FROM w.want_symbol;

-- ---------------------------------------------------------------------------------------------------
-- 1. DRY RUN — what will change
-- ---------------------------------------------------------------------------------------------------
\echo '== (c) P&L repairs: old pnl vs gross (net = gross - fees shown for reference) =='
SELECT id, strategy, symbol, side, quantity, "entryPrice", "exitPrice", fees, "exitTime",
       old_pnl, gross AS new_pnl, ROUND(gross - COALESCE(old_pnl, 0)::numeric, 2) AS delta,
       ROUND(gross - fees::numeric, 2) AS net_pnl, old_pct, new_pct
FROM pnl_fix
ORDER BY "exitTime" DESC NULLS LAST;

\echo '== (c) totals by IST day =='
SELECT ("exitTime" AT TIME ZONE 'Asia/Kolkata')::date AS ist_day, COUNT(*) AS rows_to_fix,
       ROUND(SUM(COALESCE(old_pnl, 0))::numeric, 2) AS old_sum, ROUND(SUM(gross), 2) AS new_sum,
       ROUND(SUM(gross - COALESCE(old_pnl, 0)::numeric), 2) AS delta_sum, ROUND(SUM(fees)::numeric, 2) AS fees_sum,
       ROUND(SUM(gross - fees::numeric), 2) AS net_sum
FROM pnl_fix GROUP BY 1 ORDER BY 1;

\echo '== (c) NOT updated: partially exited closed paper trades in the window (review by hand) =='
SELECT t.id, t.strategy, i.symbol, t.side, t.quantity, t."entryPrice", t."exitPrice", t.pnl, t.fees
FROM trades t JOIN instruments i ON i.id = t."instrumentId"
WHERE t.status = 'CLOSED' AND t."isPaperTrade" = true AND t."entryTime" >= TIMESTAMPTZ '2026-10-28 00:00:00+05:30'
  AND EXISTS (SELECT 1 FROM trade_events e WHERE e."tradeId" = t.id AND e."eventType" = 'PARTIAL_EXIT')
ORDER BY t."exitTime" DESC NULLS LAST;

\echo '== (d) contract relinks: linked symbol vs the decision tradingsymbol (target_id NULL = row will be inserted) =='
SELECT id, status, "entryTime", decision_id, linked_symbol, linked_token, linked_expiry,
       want_symbol, want_exchange, want_token, target_id
FROM link_fix ORDER BY "entryTime";

-- ---------------------------------------------------------------------------------------------------
-- 2. Backup, then repair
-- ---------------------------------------------------------------------------------------------------
INSERT INTO trades_repair_backup_20261103 (id, pnl, "pnlPercent", "instrumentId", reason)
SELECT t.id, t.pnl, t."pnlPercent", t."instrumentId",
       CONCAT_WS('+', CASE WHEN t.id IN (SELECT id FROM pnl_fix) THEN 'pnl' END, CASE WHEN t.id IN (SELECT id FROM link_fix) THEN 'link' END)
FROM trades t
WHERE t.id IN (SELECT id FROM pnl_fix UNION SELECT id FROM link_fix)
ON CONFLICT (id) DO NOTHING;

-- (c) pnl / pnlPercent → gross, from prices.
UPDATE trades t
SET pnl = f.gross::double precision, "pnlPercent" = f.new_pct::double precision, "updatedAt" = NOW()
FROM pnl_fix f
WHERE f.id = t.id;

-- (d) the missing instruments rows (one per symbol / exchange / token), recorded for the rollback.
CREATE TEMP TABLE new_inst ON COMMIT DROP AS
SELECT DISTINCT ON (want_symbol, want_exchange, want_token)
       'rep' || substr(md5(want_symbol || '|' || want_exchange || '|' || want_token), 1, 22) AS id,
       want_symbol AS symbol, want_exchange AS exchange, want_token AS token,
       COALESCE(underlying, substring(want_symbol FROM '^([A-Z&-]+)[0-9]{2}[A-Z]{3}[0-9]{2}'), want_symbol) AS name,
       COALESCE(plan_lot::int, gate_lot, 1) AS lot_size, plan_tick AS tick_size,
       (to_date(substring(want_symbol FROM '^[A-Z&-]+([0-9]{2}[A-Z]{3}[0-9]{2})'), 'DDMONYY')::timestamp AT TIME ZONE 'Asia/Kolkata') AS expiry,
       substring(want_symbol FROM '^[A-Z&-]+[0-9]{2}[A-Z]{3}[0-9]{2}([0-9]+(\.[0-9]+)?)(CE|PE)$')::double precision AS strike,
       substring(want_symbol FROM '(CE|PE)$') AS option_type
FROM link_fix
WHERE target_id IS NULL
ORDER BY want_symbol, want_exchange, want_token, "entryTime" DESC;

INSERT INTO instruments (id, symbol, token, name, exchange, segment, "lotSize", "tickSize", expiry, strike, "optionType", "isActive", "createdAt", "updatedAt")
SELECT n.id, n.symbol, n.token, n.name, n.exchange, n.exchange, n.lot_size, n.tick_size, n.expiry, n.strike, n.option_type, true, NOW(), NOW()
FROM new_inst n
ON CONFLICT (symbol, exchange, token) DO NOTHING;

INSERT INTO instruments_repair_inserted_20261103 (id, symbol, exchange, token)
SELECT n.id, n.symbol, n.exchange, n.token FROM new_inst n
WHERE EXISTS (SELECT 1 FROM instruments i WHERE i.id = n.id)
ON CONFLICT (id) DO NOTHING;

UPDATE trades t
SET "instrumentId" = COALESCE(l.target_id, (
      SELECT i.id FROM instruments i
      WHERE i.symbol = l.want_symbol AND i.exchange = l.want_exchange
      ORDER BY (i.token = l.want_token) DESC, i.expiry DESC NULLS LAST, i."updatedAt" DESC LIMIT 1)),
    "updatedAt" = NOW()
FROM link_fix l
WHERE l.id = t.id
  AND COALESCE(l.target_id, (SELECT i.id FROM instruments i WHERE i.symbol = l.want_symbol AND i.exchange = l.want_exchange LIMIT 1)) IS NOT NULL;

-- ---------------------------------------------------------------------------------------------------
-- 3. After-state checks (inside the transaction)
-- ---------------------------------------------------------------------------------------------------
\echo '== after: closed paper trades in the window whose pnl still differs from gross by > 1 (expect only partial exits) =='
SELECT COUNT(*) AS still_off
FROM trades t
WHERE t.status = 'CLOSED' AND t."isPaperTrade" = true AND t."entryTime" >= TIMESTAMPTZ '2026-10-28 00:00:00+05:30'
  AND t."entryPrice" > 0 AND t."exitPrice" > 0 AND t.quantity > 0
  AND NOT EXISTS (SELECT 1 FROM trade_events e WHERE e."tradeId" = t.id AND e."eventType" = 'PARTIAL_EXIT')
  AND (t.pnl IS NULL OR ABS(t.pnl::numeric - ((CASE WHEN UPPER(t.side) = 'SELL' THEN -1 ELSE 1 END) * (t."exitPrice" - t."entryPrice") * t.quantity)::numeric) > 1);

\echo '== after: relinked trades and their instrument now =='
SELECT t.id, t.status, i.symbol, i.exchange, i.token, i.expiry, i."lotSize"
FROM trades t JOIN instruments i ON i.id = t."instrumentId"
WHERE t.id IN (SELECT id FROM link_fix);

\echo '== backup rows held =='
SELECT reason, COUNT(*) FROM trades_repair_backup_20261103 GROUP BY reason;

-- Note: the paper virtual balance is replayed from SUM(pnl - fees) on the next API boot, so it moves by
-- the (c) delta_sum total after a COMMIT + restart.

ROLLBACK;  -- DRY RUN. Change to COMMIT after reading the output above.
