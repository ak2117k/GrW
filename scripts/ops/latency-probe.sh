#!/usr/bin/env bash
# p50/p95 total time of N GETs to a URL. Usage: latency-probe.sh <url> [n=20]
set -euo pipefail
url="$1"; n="${2:-20}"
for _ in $(seq "$n"); do curl -s -o /dev/null -w '%{time_total}\n' "$url"; done | sort -n \
  | awk '{a[NR]=$1} END {printf "n=%d p50=%.0fms p95=%.0fms max=%.0fms\n", NR, a[int(NR*0.5)]*1000, a[int(NR*0.95)]*1000, a[NR]*1000}'
