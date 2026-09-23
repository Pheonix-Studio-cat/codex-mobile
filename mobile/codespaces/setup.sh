#!/usr/bin/env bash
# Runs once when the codespace is created: installs what the bridge needs.
set -euo pipefail

# The released Codex, pinned: the version the end-to-end test runs against.
CODEX_VERSION="0.156.1"
npm install -g --no-audit --no-fund "@openai/codex@${CODEX_VERSION}"

# Chinook Security at the commit the bridge pins.
python3 mobile/bridge/codex_mobile.py --fetch-chinook-only
