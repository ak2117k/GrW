-- Gate replay export (READ-ONLY): every recorded entry-engine ENTER decision since __FROM__ (with its trade's P&L,
-- price line, news material path and pre-open read) plus the price lines' candles_1m (from 10 days before __FROM__)
-- and `candles` 15m history, as one JSON document for replay-gates.ts. Run with a read-only transaction, e.g.
--   sed -e 's/__FROM__/2026-11-02/' export-gate-replay.sql > /tmp/g.sql
--   docker exec -i -e PGOPTIONS='-c default_transaction_read_only=on' grw-postgres psql -U grw -d grw -P pager=off -At < /tmp/g.sql > ../fixtures/gates.real.json
-- Timestamps: `candles` is UTC without zone (read AT TIME ZONE 'UTC'); candles_1m / entry_engine_decisions are timestamptz.
\set QUIET on
with
p as (select '__FROM__'::date d0),
dec as (
  select d.id, d.underlying, to_char(d.at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') "at", d.action, d.trade_id "tradeId",
    round(t.pnl::numeric, 2)::float8 pnl,
    case when d.inputs->'trend'->'line' is null or d.inputs->'trend'->'line' = 'null'::jsonb then null
      else json_build_object('exchange', d.inputs->'trend'->'line'->>'exchange', 'token', d.inputs->'trend'->'line'->>'token') end line,
    d.inputs->'scores'->>'newsMaterialPath' "materialPath",
    case when d.inputs->'news'->'preOpen' is null or d.inputs->'news'->'preOpen' = 'null'::jsonb then null
      else json_build_object('bias', d.inputs->'news'->'preOpen'->>'bias', 'confidence', (d.inputs->'news'->'preOpen'->>'confidence')::float8, 'at', d.inputs->'news'->'preOpen'->>'at') end "preOpen"
  from entry_engine_decisions d left join trades t on t.id = d.trade_id, p
  where d.at >= p.d0 and d.action in ('ENTER_CE', 'ENTER_PE')),
lines as (select distinct line->>'exchange' ex, line->>'token' tok from dec where line is not null),
m1 as (
  select c.exchange || ':' || c.token k, json_agg(json_build_array((extract(epoch from c.ts) * 1000)::bigint, c.open, c.high, c.low, c.close) order by c.ts) v
  from candles_1m c join lines l on l.ex = c.exchange and l.tok = c.token, p
  where c.ts >= p.d0 - interval '10 days' group by 1),
s15 as (
  select i.exchange || ':' || i.token k, json_agg(json_build_array((extract(epoch from (c.timestamp at time zone 'UTC')) * 1000)::bigint, c.open, c.high, c.low, c.close) order by c.timestamp) v
  from candles c join instruments i on i.id = c."instrumentId" join lines l on l.ex = i.exchange and l.tok = i.token
  where c.timeframe = '15m' group by 1)
select json_build_object(
  'v', 1,
  'decisions', coalesce((select json_agg(dec order by "at") from dec), '[]'),
  'm1', coalesce((select json_object_agg(k, v) from m1), '{}'),
  's15', coalesce((select json_object_agg(k, v) from s15), '{}'));
