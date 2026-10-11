-- SP3: the ai-engine's database login (spec §5.1). Run as the DB owner:
--   docker exec -i grw-postgres psql -U "$PG_USER" -d "$PG_DB" -v ai_password='<secret>' -f - < grw-ai-role.sql
-- psql variables are NOT substituted inside $$ … $$ bodies, so the conditional CREATE uses \gexec.
-- Idempotent. GRANT ... ON ALL TABLES covers only tables that exist when this runs:
-- re-run it after any migration that creates new tables the ai-engine must read.
SELECT format('CREATE ROLE grw_ai LOGIN PASSWORD %L', :'ai_password')
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grw_ai') \gexec
SELECT format('ALTER ROLE grw_ai PASSWORD %L', :'ai_password') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO grw_ai', current_database()) \gexec
GRANT USAGE ON SCHEMA public TO grw_ai;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO grw_ai;
GRANT INSERT, UPDATE ON "ai_decision_records", "ai_models" TO grw_ai;
