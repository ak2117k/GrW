#!/usr/bin/env bash
# Exact row counts for every base table in `public`, for two databases, diffed.
# Usage: compare-counts.sh <src_url> <dst_url>     exit 0 = identical, 1 = differ
set -euo pipefail
PSQL="${PSQL:-docker exec -i ${PG_CONTAINER:-grw-postgres} psql}"

counts() {
  # \gexec runs each generated SELECT; exact count(*), not planner estimates.
  $PSQL "$1" -qAt -F $'\t' -v ON_ERROR_STOP=1 <<'SQL' | sort
SELECT format('SELECT %L, count(*) FROM %I.%I', table_name, table_schema, table_name)
FROM information_schema.tables
WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
ORDER BY table_name
\gexec
SQL
}

src="$(counts "$1")"
dst="$(counts "$2")"
if [[ "$src" == "$dst" ]]; then
  echo "counts match ($(wc -l <<<"$src" | tr -d ' ') tables)"
  exit 0
fi
diff <(echo "$src") <(echo "$dst") || true
exit 1
