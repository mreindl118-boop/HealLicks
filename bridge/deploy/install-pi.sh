#!/usr/bin/env bash
# Install the Stadium Deck bridge as a systemd service on a Raspberry Pi.
# Run as your normal user: ./bridge/deploy/install-pi.sh
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
NODE_BIN="$(command -v node)"
UNIT_SRC="$REPO/bridge/deploy/systemd/stadium-bridge.service"
UNIT_DST="/etc/systemd/system/stadium-bridge.service"

if [[ -z "$NODE_BIN" ]]; then
  echo "node not found on PATH — install Node 20+ first" >&2
  exit 1
fi
if ! systemctl is-active --quiet avahi-daemon 2>/dev/null; then
  echo "NOTE: avahi-daemon is not running; mDNS discovery needs it:" >&2
  echo "  sudo apt install avahi-daemon && sudo systemctl enable --now avahi-daemon" >&2
fi

echo "Building bridge + app..."
(cd "$REPO" && npm run build)

sed -e "s|__NODE__|$NODE_BIN|g" -e "s|__REPO__|$REPO|g" "$UNIT_SRC" | sudo tee "$UNIT_DST" > /dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now stadium-bridge

echo ""
echo "Installed and started: stadium-bridge"
echo "  status : systemctl status stadium-bridge"
echo "  logs   : journalctl -u stadium-bridge -f"
echo "  stop   : sudo systemctl stop stadium-bridge"
