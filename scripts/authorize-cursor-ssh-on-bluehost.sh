#!/usr/bin/env bash
# Run once from your PC (WSL) where ~/.ssh/haim_bot_codex_ed25519_nopass already works.
set -euo pipefail
HOST="${BLUEHOST_SSH_HOST:-129.121.137.125}"
USER="${BLUEHOST_SSH_USER:-root}"
KEY="${1:-}"
if [ -z "$KEY" ]; then
  echo "Usage: $0 'ssh-ed25519 AAAA... comment'"
  exit 1
fi
ssh -i "$HOME/.ssh/haim_bot_codex_ed25519_nopass" -o StrictHostKeyChecking=accept-new "${USER}@${HOST}" \
  "mkdir -p ~/.ssh && chmod 700 ~/.ssh && grep -Fq '${KEY}' ~/.ssh/authorized_keys || echo '${KEY}' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && grep -c '${KEY##* }' ~/.ssh/authorized_keys"
