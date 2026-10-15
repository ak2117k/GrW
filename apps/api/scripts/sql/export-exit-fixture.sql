-- Exit-discipline replay fixture (ExitFixtureV1) for one tracked trade — psql-only
-- alternative to apps/api/scripts/export-exit-fixture.ts. READ-ONLY (SELECT only).
--
-- psql "$DATABASE_URL" -At -v tracker="'<trackerId>'" -v utoken="'<underlyingToken>'" -v uex="'MCX'" \
--      -v t0="'2026-10-14T10:00:00Z'" -v t1="'2026-10-14T13:00:00Z'" -f export-exit-fixture.sql > crude-2026-10-14.real.json
--
-- Timestamps are emitted as UTC with a Z: the columns are timestamp WITHOUT time zone (stored UTC), and a
-- zone-less string parses as LOCAL time in Node (the replay then misses every bar). The validator rejects them.
-- Then fill meta.finalMark (price/at), meta.actualExit, meta.productType and
-- meta.maxLossPerTrade by hand if needed; the replay validates the file
-- (validateFixture names the first bad field). Before the 20261015120000
-- migration is deployed, drop "fillPrice"/"orderLtp" from the executions object
-- and the whole outcomes entry (ai_exit_outcomes does not exist yet).
SELECT json_build_object(
  'v', 1,
  'name', 'export ' || :tracker,
  'meta', (SELECT json_build_object(
      'symbol', t."symbol", 'exchange', t."exchange", 'token', t."token",
      'underlyingExchange', :uex, 'underlyingToken', :utoken,
      'side', CASE WHEN t."qty" < 0 THEN 'SHORT' ELSE 'LONG' END, 'qty', abs(t."qty"),
      'entryPrice', t."entryPrice", 'entryAt', to_char(t."entryTime", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'segment', 'OPT',
      'productType', NULL, 'maxLossPerTrade', NULL, 'actualExit', NULL,
      'finalMark', json_build_object('price', 0, 'at', :t1), 'source', 'prod-export', 'exportedAt', now())
    FROM "trade_trackers" t WHERE t."id" = :tracker),
  'verdicts', COALESCE((SELECT json_agg(json_build_object('id', v."id", 'verdict', v."verdict", 'createdAt', to_char(v."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'packet', v."packet", 'promptVersion', v."promptVersion", 'reason', v."reason") ORDER BY v."createdAt")
    FROM "sentinel_verdicts" v WHERE v."trackerId" = :tracker AND v."createdAt" BETWEEN :t0::timestamptz AND :t1::timestamptz
      AND v."promptVersion" !~ '^o[0-9]+/'), '[]'::json),
  'contractBars', COALESCE((SELECT json_agg(json_build_object('ts', (extract(epoch FROM c.ts) * 1000)::bigint,
      'open', c.open, 'high', c.high, 'low', c.low, 'close', c.close) ORDER BY c.ts)
    FROM "candles_1m" c JOIN "trade_trackers" t ON t."id" = :tracker
    WHERE c.exchange = t."exchange" AND c.token = t."token" AND c.ts BETWEEN :t0::timestamptz AND :t1::timestamptz), '[]'::json),
  'underlyingBars', COALESCE((SELECT json_agg(json_build_object('ts', (extract(epoch FROM c.ts) * 1000)::bigint,
      'open', c.open, 'high', c.high, 'low', c.low, 'close', c.close) ORDER BY c.ts)
    FROM "candles_1m" c WHERE c.exchange = :uex AND c.token = :utoken AND c.ts BETWEEN :t0::timestamptz AND :t1::timestamptz), '[]'::json),
  'executions', COALESCE((SELECT json_agg(json_build_object('verdictId', e."verdictId", 'status', e."status", 'reason', e."reason",
      'createdAt', to_char(e."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'fillPrice', e."fillPrice", 'orderLtp', e."orderLtp") ORDER BY e."createdAt")
    FROM "ai_exit_executions" e WHERE e."trackerId" = :tracker), '[]'::json),
  'outcomes', COALESCE((SELECT json_agg(json_build_object('verdictId', o."verdictId", 'kind', o."kind",
      'missedPnl', o."missedPnl", 'savedPnl', o."savedPnl", 'netAtEnd', o."netAtEnd") ORDER BY o."decisionAt")
    FROM "ai_exit_outcomes" o WHERE o."trackerId" = :tracker), '[]'::json)
);
