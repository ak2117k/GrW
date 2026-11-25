-- Read-only fixture for scripts/floor-replay.ts (desk plan 1, Task 2: the ₹2k rule vs the catastrophe floor).
-- Run with default_transaction_read_only=on, -At; the output is ONE JSON array.
--   docker exec -i -e PGOPTIONS='-c default_transaction_read_only=on' grw-postgres psql -U grw -d grw -P pager=off -At < export-floor-replay.sql > floor-replay.fixture.json
-- Every CLOSED live F&O / MCX trade_trackers POSITION whose exit is in the last 30 days, with:
--   exitReason   the newest ai_exit_executions row that sent an exit (PLACED / FILLED): status, verdictReason, time.
--                NULL = the executor never closed it (signal SL / target / manual close…): "actual reason unknown".
--   signal       the live signal_orders row that opened it (by tracker_id, else same token filled ±30 min of the
--                tracker's entry): side, targets, sl, source. NULL = a MANUAL trade (listed, not counted).
--   underlyingRef the underlying's price line: index map / MCX nearest future / NSE cash (as export-judge-rescore.sql).
--   contract1m   the contract's session 1-minute bars from the entry minute to the horizon end.
--   underlying1m the underlying's session 1-minute bars from 125 min before entry (the N1 window) to the horizon end.
--   underlying15m the underlying's session 15-minute buckets (date_bin, origin 09:15 IST — the N15Reader's own read)
--                from 5 days before entry (N15_LOOKBACK_DAYS) to the horizon end.
-- 1-minute bars are the raw store only: the replay rolls them into 15-minute bars and decides on those.
-- Horizon end: the end of the entry's IST day when the trade closed that day; else the later of the exit and
-- entry + 7 days (the replay keeps entry day + 3 sessions, or to the exit session if later).
-- trade_trackers and ai_exit_executions times are timestamp WITHOUT time zone holding UTC: each is read with
-- AT TIME ZONE 'UTC' (→ timestamptz) and printed back AT TIME ZONE 'UTC', whatever the session TimeZone; candles_1m.ts is timestamptz.
WITH t AS (
  SELECT t.id, t."userId" AS user_id, t.symbol, t.exchange, t.token, t.qty,
         t."entryPrice" AS entry_price, t."exitPrice" AS exit_price,
         t."entryTime" AT TIME ZONE 'UTC' AS entry_at, t."exitTime" AT TIME ZONE 'UTC' AS exit_at
  FROM trade_trackers t
  WHERE t.status = 'CLOSED' AND t.kind = 'POSITION' AND t.exchange IN ('NFO', 'BFO', 'MCX')
    AND t."exitTime" IS NOT NULL AND t."exitPrice" IS NOT NULL
    AND t."exitTime" AT TIME ZONE 'UTC' >= now() - interval '30 days'
), x AS (
  SELECT t.*, i.name, i."lotSize" AS lot_size,
         CASE WHEN i.name IN ('NIFTY','BANKNIFTY','FINNIFTY','SENSEX','MIDCPNIFTY') THEN
                (CASE i.name WHEN 'NIFTY' THEN '99926000' WHEN 'BANKNIFTY' THEN '99926009' WHEN 'FINNIFTY' THEN '99926037' WHEN 'SENSEX' THEN '99919000' ELSE '99926074' END)
              WHEN t.exchange = 'MCX' THEN (SELECT f.token FROM instruments f WHERE f.name = i.name AND f.exchange = 'MCX' AND f.symbol LIKE '%FUT'
                                             AND f.expiry >= (t.entry_at AT TIME ZONE 'Asia/Kolkata')::date ORDER BY f.expiry LIMIT 1)
              ELSE (SELECT c.token FROM instruments c WHERE c.exchange = 'NSE' AND c.symbol IN (i.name || '-EQ', i.name) ORDER BY c.symbol DESC LIMIT 1) END AS u_token,
         CASE WHEN i.name = 'SENSEX' THEN 'BSE' WHEN t.exchange = 'MCX' THEN 'MCX' ELSE 'NSE' END AS u_exchange,
         CASE WHEN (t.entry_at AT TIME ZONE 'Asia/Kolkata')::date = (t.exit_at AT TIME ZONE 'Asia/Kolkata')::date
              THEN ((t.entry_at AT TIME ZONE 'Asia/Kolkata')::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata'
              ELSE least(now(), greatest(t.exit_at + interval '1 minute', t.entry_at + interval '7 days')) END AS horizon_end
  FROM t LEFT JOIN LATERAL (SELECT i.name, i."lotSize" FROM instruments i WHERE i.exchange = t.exchange AND i.token = t.token LIMIT 1) i ON true
)
SELECT coalesce(json_agg(json_build_object(
  'trackerId', x.id, 'userId', x.user_id, 'symbol', x.symbol, 'exchange', x.exchange, 'token', x.token, 'name', x.name,
  'qty', x.qty, 'lotSize', x.lot_size, 'entryPrice', x.entry_price, 'exitPrice', x.exit_price,
  'entryTime', to_char(x.entry_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'exitTime', to_char(x.exit_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'exitReason', (SELECT json_build_object('status', e.status, 'reason', e."verdictReason",
                                          'at', to_char((e."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'fillPrice', e."fillPrice")
                 FROM ai_exit_executions e WHERE e."trackerId" = x.id AND e.status IN ('PLACED', 'FILLED')
                 ORDER BY e."createdAt" DESC LIMIT 1),
  'signal', (SELECT json_build_object('decisionId', so.decision_id, 'side', so.side, 'targets', so.targets, 'sl', so.sl, 'source', so.source)
             FROM signal_orders so
             WHERE so.status IN ('FILLED', 'PARTIAL')
               AND (so.tracker_id = x.id
                    OR (so.tracker_id IS NULL AND so.token = x.token AND so.filled_at BETWEEN x.entry_at - interval '30 min' AND x.entry_at + interval '30 min'))
             ORDER BY (so.tracker_id = x.id) DESC NULLS LAST, so.created_at DESC LIMIT 1),
  'underlyingRef', CASE WHEN x.u_token IS NULL THEN NULL ELSE json_build_object('exchange', x.u_exchange, 'token', x.u_token) END,
  'contract1m', (SELECT coalesce(json_agg(json_build_array((extract(epoch FROM c.ts) * 1000)::bigint, c.open, c.high, c.low, c.close) ORDER BY c.ts), '[]'::json)
                 FROM candles_1m c
                 WHERE c.exchange = x.exchange AND c.token = x.token
                   AND c.ts >= date_trunc('minute', x.entry_at) AND c.ts < x.horizon_end
                   AND CASE WHEN c.exchange LIKE 'MCX%' THEN (c.ts AT TIME ZONE 'Asia/Kolkata')::time >= '09:00' AND (c.ts AT TIME ZONE 'Asia/Kolkata')::time < '23:55'
                            ELSE (c.ts AT TIME ZONE 'Asia/Kolkata')::time >= '09:15' AND (c.ts AT TIME ZONE 'Asia/Kolkata')::time < '15:30' END),
  'underlying1m', (SELECT coalesce(json_agg(json_build_array((extract(epoch FROM c.ts) * 1000)::bigint, c.open, c.high, c.low, c.close) ORDER BY c.ts), '[]'::json)
                   FROM candles_1m c
                   WHERE c.exchange = x.u_exchange AND c.token = x.u_token
                     AND c.ts >= x.entry_at - interval '125 min' AND c.ts < x.horizon_end
                     AND CASE WHEN c.exchange LIKE 'MCX%' THEN (c.ts AT TIME ZONE 'Asia/Kolkata')::time >= '09:00' AND (c.ts AT TIME ZONE 'Asia/Kolkata')::time < '23:55'
                              ELSE (c.ts AT TIME ZONE 'Asia/Kolkata')::time >= '09:15' AND (c.ts AT TIME ZONE 'Asia/Kolkata')::time < '15:30' END),
  'underlying15m', (SELECT coalesce(json_agg(json_build_array((extract(epoch FROM b.ts) * 1000)::bigint, b.open, b.high, b.low, b.close) ORDER BY b.ts), '[]'::json)
                    FROM (SELECT date_bin('15 minutes', c.ts, '2000-01-03T09:15:00+05:30'::timestamptz) AS ts,
                                 (array_agg(c.open ORDER BY c.ts))[1] AS open, max(c.high) AS high, min(c.low) AS low,
                                 (array_agg(c.close ORDER BY c.ts DESC))[1] AS close
                          FROM candles_1m c
                          WHERE c.exchange = x.u_exchange AND c.token = x.u_token
                            AND c.ts >= x.entry_at - interval '5 days' AND c.ts < x.horizon_end
                            AND CASE WHEN c.exchange LIKE 'MCX%' THEN (c.ts AT TIME ZONE 'Asia/Kolkata')::time >= '09:00' AND (c.ts AT TIME ZONE 'Asia/Kolkata')::time < '23:55'
                                     ELSE (c.ts AT TIME ZONE 'Asia/Kolkata')::time >= '09:15' AND (c.ts AT TIME ZONE 'Asia/Kolkata')::time < '15:30' END
                          GROUP BY 1) b)
) ORDER BY x.entry_at), '[]'::json)
FROM x;
