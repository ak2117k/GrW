-- Read-only fixture for scripts/notes-judge-replay.ts (judge replay with / without verified notes; MESSAGE_READER gate).
-- Run with default_transaction_read_only=on, -At, the IST session as a psql variable; the output is ONE JSON object
-- { session, readings[], decisions[] }:
--   docker exec -i -e PGOPTIONS='-c default_transaction_read_only=on' grw-postgres psql -U grw -d grw -P pager=off -At \
--     -v session=2026-11-25 < export-notes-replay.sql > notes-replay.fixture.json
-- decisions: every signal_decisions row created on that IST session with a stored judge packet (judge->'packet'),
--   in the export-judge-rescore.sql row shape (judge incl. the FULL packet, plan, ai_check; the paper trade, its
--   contract, the contract's and the underlying's candles_1m over the trade, the exit shadow's STOP row, the nearest
--   chain snapshot ≤ 30 min before entry, the paper sentinel's looks). trade / instrument are null when the
--   decision opened no paper trade (the replay reports such a row as unscorable).
-- readings: that session's message_readings the live judge reads (READ / CACHED), with the channel title and
--   availableAt = when the reading was stored (read_at, else created_at).
WITH d AS (
  SELECT d.id, d.underlying, d.created_at, d.judge, d.plan, d.ai_check, d.plan->'paper'->>'tradeId' AS tid
  FROM signal_decisions d
  WHERE (d.created_at AT TIME ZONE 'Asia/Kolkata')::date = :'session'::date AND d.judge->'packet' IS NOT NULL
), x AS (
  SELECT d.*, t.id AS trade_id, t.side, t.quantity, t."entryPrice" AS entry_price, t."exitPrice" AS exit_price, t."entryTime" AS entry_time,
         t."exitTime" AS exit_time, t.status, t."exitReasonTag" AS exit_tag, t."entryTags" AS tags,
         i.symbol, i.name, i.exchange, i.token, i.strike, i."optionType" AS option_type, i.expiry, i."lotSize" AS lot_size, i."tickSize" AS tick_size,
         CASE WHEN i.id IS NULL THEN NULL
              WHEN i.name IN ('NIFTY','BANKNIFTY','FINNIFTY','SENSEX','MIDCPNIFTY') THEN
                (CASE i.name WHEN 'NIFTY' THEN '99926000' WHEN 'BANKNIFTY' THEN '99926009' WHEN 'FINNIFTY' THEN '99926037' WHEN 'SENSEX' THEN '99919000' ELSE '99926074' END)
              WHEN i.exchange = 'MCX' THEN (SELECT f.token FROM instruments f WHERE f.name = i.name AND f.exchange = 'MCX' AND f.symbol LIKE '%FUT' AND f.expiry >= t."entryTime"::date ORDER BY f.expiry LIMIT 1)
              WHEN i.exchange = 'NSE' THEN i.token
              ELSE (SELECT c.token FROM instruments c WHERE c.exchange = 'NSE' AND c.symbol IN (i.name || '-EQ', i.name) ORDER BY c.symbol DESC LIMIT 1) END AS u_token,
         CASE WHEN i.name = 'SENSEX' THEN 'BSE' WHEN i.exchange = 'MCX' THEN 'MCX' ELSE 'NSE' END AS u_exchange
  FROM d LEFT JOIN trades t ON t.id = d.tid LEFT JOIN instruments i ON i.id = t."instrumentId"
)
SELECT json_build_object(
  'session', :'session',
  'readings', (SELECT coalesce(json_agg(json_build_object(
                  'messageId', r.message_id, 'channelId', r.channel_id, 'channelTitle', coalesce(c.title, r.channel_id),
                  'postedAt', to_char(r.posted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                  'availableAt', to_char(coalesce(r.read_at, r.created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                  'scope', r.scope, 'claims', r.claims, 'summary', r.summary) ORDER BY r.posted_at), '[]'::json)
               FROM message_readings r LEFT JOIN telegram_channels c ON c.id = r.channel_id
               WHERE r.session_date = :'session' AND r.status IN ('READ', 'CACHED')),
  'decisions', (SELECT coalesce(json_agg(json_build_object(
    'decisionId', x.id, 'underlying', x.underlying, 'createdAt', to_char(x.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'judge', x.judge, 'plan', x.plan, 'aiCheck', x.ai_check,
    'trade', CASE WHEN x.trade_id IS NULL THEN NULL ELSE json_build_object('id', x.trade_id, 'side', x.side, 'quantity', x.quantity, 'entryPrice', x.entry_price, 'exitPrice', x.exit_price,
                               'entryTime', to_char(x.entry_time, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'exitTime', to_char(x.exit_time, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                               'status', x.status, 'exitTag', x.exit_tag, 'tags', x.tags) END,
    'instrument', CASE WHEN x.symbol IS NULL THEN NULL ELSE json_build_object('symbol', x.symbol, 'name', x.name, 'exchange', x.exchange, 'token', x.token, 'strike', x.strike, 'optionType', x.option_type,
                                    'expiry', to_char(x.expiry, 'YYYY-MM-DD'), 'lotSize', x.lot_size, 'tickSize', x.tick_size) END,
    'underlyingRef', json_build_object('exchange', x.u_exchange, 'token', x.u_token),
    'contractBars', (SELECT coalesce(json_agg(json_build_array(extract(epoch FROM c.ts) * 1000, c.open, c.high, c.low, c.close) ORDER BY c.ts), '[]'::json)
                     FROM candles_1m c WHERE x.entry_time IS NOT NULL AND c.exchange = x.exchange AND c.token = x.token AND c.ts BETWEEN x.entry_time - interval '5 min' AND coalesce(x.exit_time, now())),
    'underlyingBars', (SELECT coalesce(json_agg(json_build_array(extract(epoch FROM c.ts) * 1000, c.open, c.high, c.low, c.close) ORDER BY c.ts), '[]'::json)
                       FROM candles_1m c WHERE x.entry_time IS NOT NULL AND c.exchange = x.u_exchange AND c.token = x.u_token AND c.ts BETWEEN x.entry_time - interval '5 min' AND coalesce(x.exit_time, now())),
    'shadowStop', (SELECT json_build_object('ts', extract(epoch FROM s.would_exit_at) * 1000, 'price', s.price) FROM paper_exit_shadows s
                   WHERE s.trade_id = x.trade_id AND s.rule = 'STOP' AND s.would_exit_at IS NOT NULL LIMIT 1),
    'chain', (SELECT json_build_object('capturedAt', m.captured_at, 'spot', m.spot, 'fut', m.fut,
                                       'row', (SELECT e FROM jsonb_array_elements(m.strikes) e WHERE (e->>'strike')::float = x.strike LIMIT 1))
              FROM mbm_chain_snapshots m
              WHERE m.instrument = x.name AND m.expiry = x.expiry::date AND m.captured_at <= x.entry_time AND m.captured_at >= x.entry_time - interval '30 min'
              ORDER BY m.captured_at DESC LIMIT 1),
    'looks', (SELECT coalesce(json_agg(json_build_array(extract(epoch FROM l."createdAt") * 1000, (l.packet->'position'->>'ltp')::float) ORDER BY l."createdAt"), '[]'::json)
              FROM paper_sentinel_looks l WHERE l."tradeId" = x.trade_id AND l.packet->'position'->>'ltp' IS NOT NULL)
  ) ORDER BY x.created_at), '[]'::json) FROM x)
);
