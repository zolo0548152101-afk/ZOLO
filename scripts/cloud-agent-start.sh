#!/usr/bin/env bash
# Per-boot Cloud Agent prep: VPS SSH only. No local Docker/Postgres.
set -euo pipefail
mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
if [[ -n "${BLUEHOST_SSH_PRIVATE_KEY:-}" ]]; then
  printf '%s\n' "$BLUEHOST_SSH_PRIVATE_KEY" > "$HOME/.ssh/bluehost"
  chmod 600 "$HOME/.ssh/bluehost"
fi
if [[ ! -f "$HOME/.ssh/bluehost" ]]; then
  echo "missing ~/.ssh/bluehost (add BLUEHOST_SSH_PRIVATE_KEY or rebuild from snapshot)" >&2
  exit 0
fi
cat > "$HOME/.ssh/config" <<'CFG'
Host bluehost-vps
  HostName 129.121.137.125
  User root
  IdentityFile ~/.ssh/bluehost
  IdentitiesOnly yes
  BatchMode yes
  StrictHostKeyChecking accept-new

Host bluehost-haim
  HostName 129.121.137.125
  User root
  IdentityFile ~/.ssh/bluehost
  IdentitiesOnly yes
CFG
chmod 600 "$HOME/.ssh/config"
