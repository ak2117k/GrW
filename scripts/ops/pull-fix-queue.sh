#!/usr/bin/env bash
# Pull the self-review fix queue (OPEN fix_tickets on prod) into docs/self-review/fix-queue.md for the dev session
# (docs/superpowers/plans/2026-11-04-self-review-wrong-decision-loop.md, G1b / spec S5). Run from the repo by the
# Claude Code SessionStart hook. Read-only: the psql session runs with default_transaction_read_only=on; it uses
# the existing SSH key, no new credential. The file is gitignored.
#
# Usage: pull-fix-queue.sh [--out PATH] [--limit N] [--dry-run] [--help]
#   --dry-run   print the ssh target and the SQL, touch nothing
# Exit: 0 written (or "fix queue unavailable: <reason>" written — a session start must never fail on this) ·
#       2 bad args.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
SSH_KEY="${FIX_QUEUE_SSH_KEY:-$HOME/.ssh/grw_oracle}"
SSH_HOST="${FIX_QUEUE_SSH_HOST:-root@157.10.98.70}"
PG_CONTAINER="${PG_CONTAINER:-grw-postgres}"
PG_USER="${PG_USER:-grw}"
PG_DB="${PG_DB:-grw}"
out="$repo/docs/self-review/fix-queue.md"
limit=50
dry=0

usage() { sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }
while (( $# > 0 )); do
  case "$1" in
    --out) out="${2:-}"; shift 2 ;;
    --limit) limit="${2:-}"; shift 2 ;;
    --dry-run) dry=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done
[[ "$limit" =~ ^[0-9]+$ ]] && (( limit > 0 && limit <= 500 )) || { echo "bad --limit: $limit" >&2; exit 2; }
[[ -n "$out" ]] || { echo "bad --out" >&2; exit 2; }

# One markdown block per OPEN ticket, the costliest first (the same order as GET /api/self-review/fix-queue).
read -r -d '' SQL <<SQL
SELECT '## [' || status || '] ' || regexp_replace(title, '\s+', ' ', 'g') || E'\n\n'
  || '- key: \`' || key || '\` · cause: ' || cause || ' · seen ' || occurrences || '× · cost ₹' || round(cost_rupees)::bigint
  || ' · ' || to_char(first_seen AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') || ' → ' || to_char(last_seen AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD')
  || CASE WHEN coalesce(evidence->>'cause', '') <> '' THEN E'\n- why: ' || regexp_replace(evidence->>'cause', '\s+', ' ', 'g') ELSE '' END
  || E'\n- change: ' || regexp_replace(proposed_change, '\s+', ' ', 'g')
  || CASE WHEN coalesce(array_length(files, 1), 0) > 0 THEN E'\n- files: ' || array_to_string(files, ', ') ELSE '' END
  || CASE WHEN test_description <> '' THEN E'\n- test: ' || regexp_replace(test_description, '\s+', ' ', 'g') ELSE '' END
  || E'\n'
FROM fix_tickets WHERE status = 'OPEN'
ORDER BY cost_rupees DESC, last_seen DESC
LIMIT $limit;
SQL

ssh_cmd=(ssh -i "$SSH_KEY" -o BatchMode=yes -o ConnectTimeout=8 "$SSH_HOST"
  "docker exec -i -e PGOPTIONS='-c default_transaction_read_only=on' $PG_CONTAINER psql -U $PG_USER -d $PG_DB -At -v ON_ERROR_STOP=1")

if (( dry )); then
  printf 'would write: %s\nwould run: %s\n--- SQL ---\n%s\n' "$out" "${ssh_cmd[*]}" "$SQL"
  exit 0
fi

mkdir -p "$(dirname "$out")"
tmp="$(mktemp "${TMPDIR:-/tmp}/fix-queue.XXXXXX")"; err="$(mktemp "${TMPDIR:-/tmp}/fix-queue-err.XXXXXX")"
trap 'rm -f "$tmp" "$err"' EXIT

if printf '%s\n' "$SQL" | "${ssh_cmd[@]}" > "$tmp" 2> "$err"; then
  n="$(grep -c '^## \[' "$tmp" || true)"
  {
    echo "# Self-review fix queue"
    echo
    echo "Pulled $(date -u +%FT%TZ) from prod fix_tickets — ${n} OPEN (costliest first, max ${limit}). Fix these first; each is a CODE_BUG or DATA cause the nightly self-review found on repeated wrong decisions."
    echo
    if (( n == 0 )); then echo "No OPEN tickets."; else cat "$tmp"; fi
  } > "$out"
  echo "fix queue: ${n} OPEN ticket(s) → ${out}"
else
  # psql puts the cause on its ERROR/FATAL line (then LINE n / caret lines); ssh on its last line.
  reason="$(grep -m 1 -E '(ERROR|FATAL|psql:)' "$err" | tr -d '\r' | cut -c1-200)"
  [[ -n "$reason" ]] || reason="$(grep -v '^[[:space:]]*$' "$err" | tail -n 1 | tr -d '\r' | cut -c1-200)"
  echo "fix queue unavailable: ${reason:-ssh/psql failed}" > "$out"
  cat "$out"
fi
exit 0
