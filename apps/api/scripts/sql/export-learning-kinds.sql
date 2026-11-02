-- Read-only fixture for scripts/replay-learning-kinds.ts (self-review PAPER_EXIT / ENGINE_ENTRY replay + the stored misses).
-- docker exec -i -e PGOPTIONS='-c default_transaction_read_only=on' grw-postgres psql -U grw -d grw -P pager=off -At < export-learning-kinds.sql > learning-kinds.fixture.json
-- Window: exits from 2026-10-28 18:30 UTC (10-29 00:00 IST) to 2026-11-02 18:30 UTC. SIGNAL_JUDGE comes from the judge-rescore fixture.
WITH px AS (
  SELECT t.id, t.side, t.quantity, t."entryPrice" AS entry_price, t."exitPrice" AS exit_price, t."exitTime" AS exit_time, t."exitReasonTag" AS exit_tag,
         t."exitNotes" AS exit_notes, t.strategy, i.symbol, i.name, i.exchange, i.token,
         CASE WHEN i.exchange IN ('NSE', 'BSE') THEN i.token
              WHEN i.name IN ('NIFTY','BANKNIFTY','FINNIFTY','SENSEX','MIDCPNIFTY') THEN
                (CASE i.name WHEN 'NIFTY' THEN '99926000' WHEN 'BANKNIFTY' THEN '99926009' WHEN 'FINNIFTY' THEN '99926037' WHEN 'SENSEX' THEN '99919000' ELSE '99926074' END)
              WHEN i.exchange = 'MCX' THEN (SELECT f.token FROM instruments f WHERE f.name = i.name AND f.exchange = 'MCX' AND f.symbol LIKE '%FUT' AND f.expiry >= t."exitTime"::date - 1 ORDER BY f.expiry LIMIT 1)
              ELSE (SELECT c.token FROM instruments c WHERE c.exchange = 'NSE' AND c.symbol IN (i.name || '-EQ', i.name) ORDER BY c.symbol DESC LIMIT 1) END AS u_token,
         CASE WHEN i.exchange IN ('NSE', 'BSE') THEN i.exchange WHEN i.name = 'SENSEX' THEN 'BSE' WHEN i.exchange = 'MCX' THEN 'MCX' ELSE 'NSE' END AS u_exchange
  FROM trades t JOIN instruments i ON i.id = t."instrumentId"
  WHERE t."isPaperTrade" AND t.status = 'CLOSED' AND t.strategy IN ('TELEGRAM_SIGNAL_NO_FUNDS', 'ENGINE_ENTRY')
    AND t."exitReasonTag" IN ('AI_EXIT', 'MOVED_STOP') AND t."exitTime" >= '2026-10-28 18:30' AND t."exitTime" < '2026-11-02 18:30'
)
SELECT json_build_object(
  'paperExits', (SELECT coalesce(json_agg(json_build_object(
      'tradeId', px.id, 'side', px.side, 'qty', px.quantity, 'entryPrice', px.entry_price, 'exitPrice', px.exit_price,
      'exitAt', to_char(px.exit_time, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'exitTag', px.exit_tag, 'exitNotes', left(px.exit_notes, 400), 'strategy', px.strategy,
      'symbol', px.symbol, 'underlying', px.name, 'uRef', px.u_exchange || ':' || px.u_token,
      'read', (SELECT json_build_object('verdict', r.verdict, 'n', r.noise_n, 'underlyingAtExit', r.underlying_at_exit, 'after15m', r.underlying_after_15m,
                                        'after30m', r.underlying_after_30m, 'maxFavour30m', r.max_favour_30m, 'maxAgainst30m', r.max_against_30m, 'summary', r.read->>'summary')
               FROM exit_noise_reads r WHERE r.trade_id = px.id ORDER BY r.exit_at LIMIT 1),
      'held', (SELECT json_build_object('rulePnl', s.rule_pnl, 'heldPnl', s.held_pnl, 'saved', s.saved) FROM paper_exit_shadows s WHERE s.trade_id = px.id AND s.rule = 'HELD' LIMIT 1),
      'bars', (SELECT coalesce(json_agg(json_build_array(extract(epoch FROM c.ts) * 1000, c.open, c.high, c.low, c.close) ORDER BY c.ts), '[]'::json)
               FROM candles_1m c WHERE c.exchange = px.u_exchange AND c.token = px.u_token AND c.ts >= px.exit_time - interval '125 min' AND c.ts < px.exit_time + interval '31 min')
    ) ORDER BY px.exit_time), '[]'::json) FROM px),
  'engineTrades', (SELECT coalesce(json_agg(json_build_object('id', t.id, 'side', t.side, 'quantity', t.quantity, 'entryPrice', t."entryPrice", 'exitPrice', t."exitPrice",
      'exitAt', to_char(t."exitTime", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'exitReasonTag', t."exitReasonTag", 'notes', left(t.notes, 300))), '[]'::json)
    FROM trades t WHERE t.strategy = 'ENGINE_ENTRY' AND t."isPaperTrade" AND t.status = 'CLOSED' AND t."exitTime" >= '2026-10-28 18:30' AND t."exitTime" < '2026-11-02 18:30'),
  'engineOpen', (SELECT count(*) FROM trades t WHERE t.strategy = 'ENGINE_ENTRY' AND t."isPaperTrade" AND t."createdAt" >= '2026-10-28 18:30'),
  'storedMisses', (SELECT coalesce(json_agg(json_build_object('sessionDate', v.session_date, 'kind', v.kind, 'refId', v.ref_id, 'symbol', v.symbol, 'score', v.score, 'predicted', left(v.predicted, 160), 'actual', left(v.actual, 160)) ORDER BY v.session_date, v.kind), '[]'::json)
    FROM verification_results v WHERE v.session_date IN ('2026-10-29', '2026-10-30', '2026-11-02') AND v.correct = false
      AND v.kind IN ('SCORECARD_TOTAL', 'OVERNIGHT_VERDICT', 'LIVE_EXIT', 'NEWS_IDEA', 'TRADE_SETUP')),
  'storedCounts', (SELECT coalesce(json_agg(json_build_object('sessionDate', x.session_date, 'kind', x.kind, 'n', x.n, 'wrong', x.wrong)), '[]'::json)
    FROM (SELECT session_date, kind, count(*) n, count(*) FILTER (WHERE correct = false) wrong FROM verification_results
          WHERE session_date IN ('2026-10-29', '2026-10-30', '2026-11-02') GROUP BY 1, 2) x)
);
