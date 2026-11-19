-- Fingerprint of oi_snapshots and candles: run BEFORE and AFTER oi-candles-compression.sql; the two
-- outputs must be identical (row counts, time range, value sums, id checksum). Read-only.
SELECT 'oi_snapshots' AS t, count(*) AS n, min("timestamp") AS lo, max("timestamp") AS hi,
       sum(oi) AS s1, sum(coalesce("oiChange", 0)) AS s2, sum(volume) AS s3,
       round(sum(coalesce(ltp, 0))::numeric, 4) AS s4,
       sum(hashtext(id)::bigint) AS idsum
  FROM "oi_snapshots" WHERE "timestamp" < :'cutoff'
UNION ALL
SELECT 'candles', count(*), min("timestamp"), max("timestamp"),
       round(sum(open)::numeric, 4)::bigint, round(sum(close)::numeric, 4)::bigint, sum(volume),
       round(sum(high - low)::numeric, 4),
       sum(hashtext(id || timeframe)::bigint)
  FROM "candles" WHERE "timestamp" < :'cutoff';
