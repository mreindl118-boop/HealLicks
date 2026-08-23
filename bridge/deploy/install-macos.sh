#!/usr/bin/env bash
# Install the Stadium Deck bridge as a macOS launchd agent (auto-start on login).
# Run from anywhere: ./bridge/deploy/install-macos.sh
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
NODE_BIN="$(command -v node)"
PLIST_SRC="$REPO/bridge/deploy/launchd/com.stadiumdeck.bridge.plist"
PLIST_DST="$HOME/Library/LaunchAgents/com.stadiumdeck.bridge.plist"

if [[ -z "$NODE_BIN" ]]; then
  echo "node not found on PATH — install Node 20+ first (https://nodejs.org)" >&2
  exit 1
fi

echo "Building bridge + app..."
(cd "$REPO" && npm run build)

mkdir -p "$REPO/bridge/logs" "$HOME/Library/LaunchAgents"
sed -e "s|__NODE__|$NODE_BIN|g" -e "s|__REPO__|$REPO|g" "$PLIST_SRC" > "$PLIST_DST"

launchctl unload "$PLIST_DST" 2>/dev/null || true
launchctl load "$PLIST_DST"

echo ""
echo "Installed and started: com.stadiumdeck.bridge"
echo "  status : launchctl list | grep stadiumdeck"
echo "  logs   : tail -f $REPO/bridge/logs/launchd-stdout.log"
echo "  stop   : launchctl unload $PLIST_DST"
echo "  remove : launchctl unload $PLIST_DST && rm $PLIST_DST"
