#!/usr/bin/env bash
# Runs on every start of the codespace: starts the bridge in the background.
#
# The port stays private (the Codespaces default): only the owner of the
# codespace, signed in to GitHub, can open it. The pairing token is the
# second lock; set it once as the Codespaces secret CODEX_MOBILE_TOKEN.
set -euo pipefail

state="$HOME/codex-mobile"
mkdir -p "$state"
chmod 700 "$state"

# Codex works on the repositories beside this one: /workspaces.
workspace="$(dirname "$PWD")"

if [ -f "$state/bridge.pid" ] && kill -0 "$(cat "$state/bridge.pid")" 2>/dev/null; then
  exit 0
fi

# `setsid`: a session of its own. The command that runs this script is ended
# together with its process group once it returns; without setsid the bridge
# went with it (reproduced by killing the group).
setsid nohup python3 mobile/bridge/codex_mobile.py \
  --workspace "$workspace" \
  --port 8765 \
  > "$state/bridge.log" 2>&1 &
echo $! > "$state/bridge.pid"

# The link the owner taps. Without the secret the bridge generates a token;
# then the link carries it, and the file is readable by the owner only.
for _ in $(seq 1 50); do
  if grep -q "Open on your phone" "$state/bridge.log" 2>/dev/null; then
    break
  fi
  sleep 0.2
done
umask 077
{
  echo ""
  echo "Codex Mobile"
  grep -E "Open on your phone|Pairing token" "$state/bridge.log" || echo "  (the bridge did not start; see $state/bridge.log)"
  echo ""
} > "$state/link.txt"
cat "$state/link.txt"
