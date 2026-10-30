-- Entry engine replay fixture export (READ-ONLY). One underlying-day as a single JSON document:
-- news impacts (+ cluster), the underlying line's 1m bars (candles_1m and the legacy `candles` 1m),
-- the option chain's oi_snapshots for one expiry within a strike band, and the near-month future's
-- OI + LTP. Fill the placeholders and run with a read-only transaction, e.g.
--   sed -e 's/__U__/CRUDEOIL/;s/__D__/2026-10-29/;s/__LEX__/MCX/;s/__LTOK__/573422/;s/__OEX__/MCX/;s/__EXP__/2026-11-17/;s/__LO__/9000/;s/__HI__/10400/;s/__FUT__/CRUDEOIL19NOV26FUT/' \
--     export-entry-fixture.sql > /tmp/x.sql
--   docker exec -i -e PGOPTIONS='-c default_transaction_read_only=on' grw-postgres psql -U grw -d grw -P pager=off -At < /tmp/x.sql > ../fixtures/crude-2026-10-29.real.json
-- __U__ underlying, __D__ IST day, __LEX__/__LTOK__ the price line (index / MCX near future), __OEX__ the
-- option venue, __EXP__ the option expiry, __LO__/__HI__ the strike band, __FUT__ the near-month future symbol.
-- Timestamps: oi_snapshots / candles are UTC without zone; exported with a Z.
\set QUIET on
with
p as (select '__U__'::text u, '__D__'::date d, '__LEX__'::text lex, '__LTOK__'::text ltok, '__OEX__'::text oex, '__EXP__'::date expiry, __LO__::float lo, __HI__::float hi, '__FUT__'::text fut),
w as (select (d::timestamp - interval '5 hours 30 minutes') day0, (d::timestamp + interval '18 hours 30 minutes') day1 from p),
contracts as (
  select i.id, i.strike, i."optionType" ot from instruments i, p
  where i.name = p.u and i.exchange = p.oex and i."optionType" in ('CE','PE')
    and (i.expiry + interval '5 hours 30 minutes')::date = p.expiry and i.strike between p.lo and p.hi),
oirows as (
  select o."instrumentId" i, o.oi::float8 oi, to_char(o.timestamp,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') t
  from oi_snapshots o, w where o."instrumentId" in (select id from contracts) and o.timestamp >= w.day0 and o.timestamp < w.day1),
futinst as (select i.id, i.symbol from instruments i, p where i.symbol = p.fut limit 1),
futrows as (
  select o.oi::float8 oi, o.ltp, to_char(o.timestamp,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') t
  from oi_snapshots o, w where o."instrumentId" in (select id from futinst) and o.timestamp >= w.day0 and o.timestamp < w.day1),
hub as (
  select to_char(ts at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') t, open o, high h, low l, close c, volume::float8 v
  from candles_1m, p, w where exchange = p.lex and token = p.ltok and ts >= (w.day0 - interval '6 days') at time zone 'UTC' and ts < w.day1 at time zone 'UTC'),
tbl as (
  select to_char(c.timestamp,'YYYY-MM-DD"T"HH24:MI:SS"Z"') t, c.open o, c.high h, c.low l, c.close c, c.volume::float8 v
  from candles c join instruments i on i.id = c."instrumentId", p, w
  where i.exchange = p.lex and i.token = p.ltok and c.timeframe = '1m' and c.timestamp >= w.day0 - interval '6 days' and c.timestamp < w.day1),
imp as (
  select to_char(i.analysed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') "analysedAt", to_char(c.first_seen at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') "firstSeen",
    i.direction, i.magnitude, i.confidence, i.priced_in "pricedIn", i.symbols, i.sectors, i.index_name "indexName", c.material, c.material_type "materialType", c.headline, i.cluster_id "clusterId"
  from news_impacts i join news_clusters c on c.id = i.cluster_id, w
  where i.analysed_at >= (w.day0 - interval '2 hours') at time zone 'UTC' and i.analysed_at < w.day1 at time zone 'UTC')
select json_build_object(
  'v', 1, 'underlying', (select u from p), 'date', (select d from p)::text, 'line', json_build_object('exchange', (select lex from p), 'token', (select ltok from p)),
  'optionExchange', (select oex from p), 'exportedAt', to_char(now() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  'impacts', coalesce((select json_agg(imp order by "analysedAt") from imp), '[]'),
  'hubBars', coalesce((select json_agg(hub order by t) from hub), '[]'),
  'tableBars', coalesce((select json_agg(tbl order by t) from tbl), '[]'),
  'chain', json_build_object('expiry', (select expiry from p)::text,
     'contracts', coalesce((select json_agg(json_build_object('instrumentId', id, 'strike', strike, 'optionType', ot)) from contracts), '[]'),
     'rows', coalesce((select json_agg(oirows order by t) from oirows), '[]')),
  'futures', case when exists (select 1 from futrows) then json_build_object('instrumentId', (select id from futinst), 'symbol', (select symbol from futinst),
     'rows', (select json_agg(json_build_object('oi', oi, 't', t) order by t) from futrows),
     'prices', (select json_agg(json_build_object('close', ltp, 't', t) order by t) from futrows where ltp is not null)) else null end
);
