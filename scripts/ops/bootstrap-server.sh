#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu 22.04/24.04 VPS for GrW. Run as root:
#
#   bash bootstrap-server.sh                # 1. install everything (safe to re-run)
#   ssh -i ~/.ssh/grw_oracle root@<ip>      # 2. from the laptop: prove key login works
#   bash bootstrap-server.sh --harden-ssh   # 3. only then turn off password logins
#
# Hardening is a separate, explicit step on purpose: turning passwords off before
# the owner's key is proven would lock them out of their own server.
set -euo pipefail

# The owner's laptop key (public half — safe to commit). See docs/deploy runbook.
GRW_KEY_FRAGMENT="${GRW_KEY_FRAGMENT:-AAAAC3NzaC1lZDI1NTE5AAAAIJlfEBRGDFuiYQUx8vavRwTaN8JOlbL7T1kiFCJPNvwx}"
GRW_PUBKEY="ssh-ed25519 $GRW_KEY_FRAGMENT grw-oracle"
ROOT_SSH_DIR="${ROOT_SSH_DIR:-/root/.ssh}"
SSHD_DROPIN="${SSHD_DROPIN:-/etc/ssh/sshd_config.d/00-grw.conf}"

log() { echo "[bootstrap] $*"; }

# 203.0.113.7 -> 203-0-113-7.sslip.io : the free HTTPS name Caddy certifies.
api_host() { echo "${1//./-}.sslip.io"; }

key_installed() { [[ -f "$1" ]] && grep -qF "$2" "$1"; }

ensure_root_key() {
  mkdir -p "$ROOT_SSH_DIR"
  chmod 700 "$ROOT_SSH_DIR"
  key_installed "$ROOT_SSH_DIR/authorized_keys" "$GRW_KEY_FRAGMENT" \
    || echo "$GRW_PUBKEY" >> "$ROOT_SSH_DIR/authorized_keys"
  chmod 600 "$ROOT_SSH_DIR/authorized_keys"
}

# 00- sorts first in sshd_config.d, and sshd keeps the FIRST value it reads, so
# this wins over cloud-init's 50-cloud-init.conf "PasswordAuthentication yes".
harden_ssh() {
  if ! key_installed "$ROOT_SSH_DIR/authorized_keys" "$GRW_KEY_FRAGMENT"; then
    log "REFUSING: the owner's key is not in $ROOT_SSH_DIR/authorized_keys; password login stays ON"
    return 1
  fi
  mkdir -p "$(dirname "$SSHD_DROPIN")"
  printf '%s\n' \
    '# GrW: key-only SSH (scripts/ops/bootstrap-server.sh --harden-ssh)' \
    'PasswordAuthentication no' \
    'KbdInteractiveAuthentication no' \
    'PermitRootLogin prohibit-password' > "$SSHD_DROPIN"
  if ! sshd -t; then
    log "sshd rejected the new config; removing it, nothing changed"
    rm -f "$SSHD_DROPIN"
    return 1
  fi
  systemctl reload ssh 2>/dev/null || systemctl reload sshd
  log "password login is OFF; key-only from now on"
}

install_all() {
  [[ $EUID -eq 0 ]] || { log "run as root"; exit 1; }
  export DEBIAN_FRONTEND=noninteractive

  log "updating the system"
  apt-get update -q
  apt-get -yq -o Dpkg::Options::=--force-confold upgrade
  apt-get -yq install ca-certificates curl git ufw fail2ban unattended-upgrades rclone postgresql-client
  dpkg-reconfigure -f noninteractive unattended-upgrades
  timedatectl set-timezone UTC

  if ! command -v docker >/dev/null; then
    log "installing Docker"
    curl -fsSL https://get.docker.com | sh
  fi

  if [[ -z "$(swapon --show)" ]]; then
    log "adding 2 GB swap"
    fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
    grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  fi

  log "firewall: allow 22 (ssh), 80 + 443 (Caddy); deny the rest"
  ufw allow 22/tcp >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
  ufw --force enable >/dev/null

  id grw >/dev/null 2>&1 || useradd -m -s /bin/bash -G docker grw
  mkdir -p /opt/grw/{app,env,state,backups}
  chown -R grw:grw /opt/grw
  chmod 700 /opt/grw/env

  ensure_root_key

  # A read-only GitHub deploy key, so the server can pull the private repo.
  if [[ ! -f /home/grw/.ssh/id_ed25519 ]]; then
    sudo -u grw mkdir -p /home/grw/.ssh
    sudo -u grw ssh-keygen -q -t ed25519 -N '' -C "grw-server-deploy" -f /home/grw/.ssh/id_ed25519
    sudo -u grw sh -c 'ssh-keyscan -t ed25519 github.com >> ~/.ssh/known_hosts 2>/dev/null'
  fi

  local ip; ip="$(curl -fsS -4 -m 10 https://ifconfig.me || echo '<this-server-ip>')"
  cat <<EOF

================ SETUP DONE ================
Server IP          : $ip
Your API address   : https://$(api_host "$ip")

NEXT (send Claude only the lines marked "send"):
 1. From your LAPTOP, prove key login:   ssh -i ~/.ssh/grw_oracle root@$ip
    If that works, run here:             bash bootstrap-server.sh --harden-ssh
 2. Add this DEPLOY KEY on GitHub -> repo GrW -> Settings -> Deploy keys -> Add
    (title: grw-server, leave "Allow write access" UNTICKED):

$(cat /home/grw/.ssh/id_ed25519.pub)

 3. Tell Claude "deploy key added" and send:  Server IP = $ip
============================================
EOF
}

main() {
  case "${1:-}" in
    --harden-ssh) harden_ssh ;;
    "") install_all ;;
    *) echo "usage: bash bootstrap-server.sh [--harden-ssh]"; exit 2 ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
