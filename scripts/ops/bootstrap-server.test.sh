#!/usr/bin/env bash
# Unit tests for bootstrap-server.sh's safety logic — the parts that can lock the
# owner out of their own server. Runs on Linux (file modes matter), e.g.:
#   docker run --rm -v "$PWD:/repo" -w /repo bash:5 bash scripts/ops/bootstrap-server.test.sh
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
failures=0
expect() { if [[ "$2" == "$3" ]]; then echo "ok   $1"; else echo "FAIL $1: got [$2] want [$3]"; failures=$((failures + 1)); fi; }

setup() {
  # shellcheck source=/dev/null
  source "$here/bootstrap-server.sh"
  set +e
  failures=0   # per group: an earlier group's failure must not fail this one
  log() { :; }
  tmp="$(mktemp -d)"
  ROOT_SSH_DIR="$tmp/root-ssh"
  SSHD_DROPIN="$tmp/sshd_config.d/00-grw.conf"
  sshd() { echo "sshd $*" >> "$tmp/calls"; }
  systemctl() { echo "systemctl $*" >> "$tmp/calls"; }
}

( setup
  ensure_root_key; ensure_root_key
  expect "root key added once, even when run twice" \
    "$(grep -c "$GRW_KEY_FRAGMENT" "$ROOT_SSH_DIR/authorized_keys")" 1
  expect "authorized_keys is private (600)" "$(stat -c %a "$ROOT_SSH_DIR/authorized_keys")" 600
  exit $failures ) || failures=$((failures + 1))

( setup
  mkdir -p "$ROOT_SSH_DIR"; echo "ssh-rsa AAAAother someone" > "$ROOT_SSH_DIR/authorized_keys"
  harden_ssh; rc=$?
  expect "harden refuses when the owner's key is not installed" "$rc" 1
  expect "...and writes no sshd config" "$([[ -e "$SSHD_DROPIN" ]] && echo yes || echo no)" no
  expect "...and never reloads ssh" "$(cat "$tmp/calls" 2>/dev/null | grep -c systemctl)" 0
  exit $failures ) || failures=$((failures + 1))

( setup
  ensure_root_key
  harden_ssh; rc=$?
  expect "harden succeeds when the key is installed" "$rc" 0
  expect "...disables password login" "$(grep -c '^PasswordAuthentication no' "$SSHD_DROPIN")" 1
  expect "...keeps root on keys only" "$(grep -c '^PermitRootLogin prohibit-password' "$SSHD_DROPIN")" 1
  expect "...validates config before reloading" "$(head -1 "$tmp/calls")" "sshd -t"
  exit $failures ) || failures=$((failures + 1))

( setup
  ensure_root_key
  sshd() { echo "sshd $*" >> "$tmp/calls"; return 1; }   # config invalid
  harden_ssh; rc=$?
  expect "harden rolls back an sshd config that fails validation" "$rc" 1
  expect "...removing the bad file" "$([[ -e "$SSHD_DROPIN" ]] && echo yes || echo no)" no
  expect "...without reloading ssh" "$(cat "$tmp/calls" 2>/dev/null | grep -c systemctl)" 0
  exit $failures ) || failures=$((failures + 1))

( setup
  expect "api_host turns an IPv4 into its sslip.io name" "$(api_host 203.0.113.7)" "203-0-113-7.sslip.io"
  exit $failures ) || failures=$((failures + 1))

if (( failures > 0 )); then echo "$failures test group(s) failed"; exit 1; fi
echo "all bootstrap tests passed"
