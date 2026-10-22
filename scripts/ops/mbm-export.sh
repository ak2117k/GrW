#!/usr/bin/env bash
# Nightly MBM export: OI, OI-wall and option-chain snapshots → gzipped CSV, one file
# per (table, IST session day), BEFORE the in-app prunes delete them (chain 30 d at
# 02:00 IST, OI 30 d at 02:45 IST, walls 45 d). Run by grw-mbm-export.timer at
# 01:15 IST; catches up the last EXPORT_CATCHUP_DAYS so a missed night loses nothing.
# mbm_chain_snapshots (the MBM NIFTY chain capture, never pruned) is exported the same way.
# The PC pulls the files over ssh/scp (ai-engine/scripts/mbm_data.py pull-exports).
#
# Usage: mbm-export.sh [--since YYYY-MM-DD] [--today YYYY-MM-DD]
# Exit: 0 ok · 1 a table/day failed (others still exported) · 2 bad args ·
#       4 a newly written Mon–Fri day had zero rows in every table.
set -uo pipefail

PG_CONTAINER="${PG_CONTAINER:-grw-postgres}"
PG_USER="${PG_USER:-grw}"
PG_DB="${PG_DB:-grw}"
EXPORT_DIR="${EXPORT_DIR:-/opt/grw/exports}"
EXPORT_KEEP_DAYS="${EXPORT_KEEP_DAYS:-30}"
EXPORT_CATCHUP_DAYS="${EXPORT_CATCHUP_DAYS:-7}"

since=""; today=""
while (( $# > 0 )); do
  case "$1" in
    --since) since="${2:-}"; shift 2 ;;
    --today) today="${2:-}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$today" ]] || today="$(TZ=Asia/Kolkata date +%F)"
[[ -n "$since" ]] || since="$(date -u -d "$today - $EXPORT_CATCHUP_DAYS days" +%F)"
date -u -d "$today" +%F >/dev/null 2>&1 && date -u -d "$since" +%F >/dev/null 2>&1 \
  || { echo "bad date: --since $since --today $today" >&2; exit 2; }

# Prisma DateTime columns are `timestamp` (no zone) holding UTC; exported as *_utc.
query() { # $1 table, $2 utc_from, $3 utc_to
  case "$1" in
    oi_snapshots) echo "SELECT s.id, s.\"timestamp\" AS ts_utc, i.symbol, i.exchange, i.token, i.segment, i.expiry AS expiry_utc, i.strike, i.\"optionType\" AS option_type, s.oi, s.\"oiChange\" AS oi_change, s.volume FROM oi_snapshots s JOIN instruments i ON i.id = s.\"instrumentId\" WHERE s.\"timestamp\" >= '$2' AND s.\"timestamp\" < '$3' ORDER BY s.\"timestamp\", s.id" ;;
    oi_wall_snapshots) echo "SELECT id, \"capturedAt\" AS captured_at_utc, symbol, expiry, \"callWall\" AS call_wall, \"putWall\" AS put_wall, \"callWallOi\" AS call_wall_oi, \"putWallOi\" AS put_wall_oi FROM oi_wall_snapshots WHERE \"capturedAt\" >= '$2' AND \"capturedAt\" < '$3' ORDER BY \"capturedAt\", id" ;;
    option_chain_snapshots) echo "SELECT id, \"capturedAt\" AS captured_at_utc, underlying, \"expiryDate\" AS expiry_date, \"spotPrice\" AS spot_price, source, \"strikeCount\" AS strike_count, \"chainJson\" AS chain_json FROM option_chain_snapshots WHERE \"capturedAt\" >= '$2' AND \"capturedAt\" < '$3' ORDER BY \"capturedAt\", id" ;;
    # timestamptz (not Prisma's zone-less timestamp): the window is pinned to UTC with +00.
    mbm_chain_snapshots) echo "SELECT id, captured_at AS captured_at_utc, instrument, expiry, spot, pcr, max_pain, call_wall, put_wall, strikes, fut FROM mbm_chain_snapshots WHERE captured_at >= '$2+00' AND captured_at < '$3+00' ORDER BY captured_at, id" ;;
  esac
}
rows_in() { local n; n=$(gzip -dc "$1" | wc -l); echo $(( n > 0 ? n - 1 : 0 )); }

TABLES=(oi_snapshots oi_wall_snapshots option_chain_snapshots mbm_chain_snapshots)
failed=0; empty_days=()
day="$since"
while [[ "$day" < "$today" ]]; do
  from="$(date -u -d "$day - 1 day" +%F) 18:30:00"; to="$day 18:30:00"
  wrote=0; total=0
  for t in "${TABLES[@]}"; do
    file="$EXPORT_DIR/$t/$t-$day.csv.gz"
    if [[ -e "$file" ]]; then total=$(( total + $(rows_in "$file") )); continue; fi
    mkdir -p "$EXPORT_DIR/$t"
    part="$file.partial"
    if docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -v ON_ERROR_STOP=1 -q \
         -c "COPY ($(query "$t" "$from" "$to")) TO STDOUT WITH CSV HEADER" | gzip > "$part" \
       && gzip -t "$part" && mv "$part" "$file"; then
      n=$(rows_in "$file"); total=$(( total + n )); wrote=1
      echo "$t $day rows=$n"
    else
      rm -f "$part"; failed=1
      echo "export FAILED: $t $day" >&2
    fi
  done
  dow=$(date -u -d "$day" +%u)
  if (( wrote == 1 && total == 0 && dow <= 5 )); then empty_days+=("$day"); fi
  day="$(date -u -d "$day + 1 day" +%F)"
done

find "$EXPORT_DIR" -name '*.csv.gz' -mtime +"$EXPORT_KEEP_DAYS" -delete 2>/dev/null || true
find "$EXPORT_DIR" -name '*.partial' -delete 2>/dev/null || true

(( failed )) && exit 1
if (( ${#empty_days[@]} > 0 )); then
  for d in "${empty_days[@]}"; do echo "no OI/chain rows for $d — feed down or market holiday?" >&2; done
  exit 4
fi
exit 0
