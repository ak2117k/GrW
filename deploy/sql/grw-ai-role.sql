-- SP3: the ai-engine's database login, least privilege per spec §5.1.
-- Run as the DB owner AFTER `prisma migrate deploy` (the ai_* tables must exist), interactively so
-- the password is prompted for and never appears in shell history or `ps`:
--   docker cp grw-ai-role.sql grw-postgres:/tmp/grw-ai-role.sql
--   docker exec -it grw-postgres psql -U "$PG_USER" -d "$PG_DB" -f /tmp/grw-ai-role.sql
--   docker exec grw-postgres rm /tmp/grw-ai-role.sql
-- Idempotent. Each run first REVOKEs every table privilege from grw_ai and then re-grants only the
-- allow-list below, so a re-run narrows any earlier broader grant. Allow-listed tables that do not
-- exist yet (e.g. core_journal) are skipped silently; re-run after a migration adds them.
--
-- Granted:  SELECT on ai_calls; SELECT/INSERT/UPDATE on ai_decision_records, ai_models;
--           SELECT on sentinel_verdicts, sentinel_theses; legacy silo tables (trades, watch_entries,
--           ungated_*, adaptive_stop_*); candle tables (candles, candles_1m, candles_1h, candles_1d);
--           core journal tables when present (core_journal, core_trade_summaries).
-- EXCLUDED on purpose (never granted, also filtered defensively below): users, user_settings,
--           broker_credentials, any table whose name contains "token", payments, subscriptions,
--           billing_profiles — auth material, broker secrets and billing data.
-- psql variables are NOT substituted inside $$ … $$ bodies, so conditional DDL uses \gexec.
-- Note: if the server logs DDL (log_statement = ddl|all) the ALTER ROLE … PASSWORD line is logged;
-- check log_statement before running, or set the password afterwards with `\password grw_ai`.

\set ON_ERROR_STOP on
\prompt 'grw_ai password: ' ai_password

SELECT :'ai_password' = '' AS ai_password_empty \gset
\if :ai_password_empty
  DO $$ BEGIN RAISE EXCEPTION 'grw_ai password must not be empty'; END $$;
\endif

SELECT format('CREATE ROLE grw_ai LOGIN PASSWORD %L', :'ai_password')
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grw_ai') \gexec
SELECT format('ALTER ROLE grw_ai PASSWORD %L', :'ai_password') \gexec
\unset ai_password

SELECT format('GRANT CONNECT ON DATABASE %I TO grw_ai', current_database()) \gexec
GRANT USAGE ON SCHEMA public TO grw_ai;

-- Start from nothing so a re-run removes anything granted before (incl. the old blanket SELECT).
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM grw_ai;

-- The SP3 tables: named explicitly so a run before the migration fails loudly.
GRANT SELECT ON "ai_calls" TO grw_ai;
GRANT SELECT, INSERT, UPDATE ON "ai_decision_records", "ai_models" TO grw_ai;

-- Read-only inputs: allow-list by name/prefix; missing tables are simply not in pg_tables.
SELECT format('GRANT SELECT ON %I.%I TO grw_ai', schemaname, tablename)
  FROM pg_tables
 WHERE schemaname = 'public'
   AND (   tablename IN ('sentinel_verdicts', 'sentinel_theses',
                         'trades', 'watch_entries',
                         'candles', 'candles_1m', 'candles_1h', 'candles_1d',
                         'core_journal', 'core_trade_summaries')
        OR tablename LIKE 'ungated\_%'
        OR tablename LIKE 'adaptive\_stop\_%')
   AND tablename NOT IN ('users', 'user_settings', 'broker_credentials',
                         'payments', 'subscriptions', 'billing_profiles')
   AND tablename NOT LIKE '%token%'
 ORDER BY tablename \gexec
