# RUNBOOK — copy-paste commands for every session type

Every session starts in the repo root. Fresh terminal? Paste the block for
your session type and go.

---

## 0. Fresh install (new machine / fresh clone)

```bash
git clone <this-repo-url> stadium-deck && cd stadium-deck
npm install
npm run build
npm run test
```

Green tests = protocol codecs + mock integration verified on this machine.

---

## 1. Start the bridge (normal daily use)

```bash
npm run bridge
```

- Discovers the Stadium via mDNS, prints the LAN URL **and a QR code** —
  scan it with the iPad camera, then Share → **Add to Home Screen**.
- Starts **READ-ONLY** (toggle writes in the app's top bar).
- Health check: `curl http://localhost:8484/healthz`
- Useful flags (after `--`):

```bash
npm run bridge -- --verbose                 # log link transitions + ws activity
npm run bridge -- --stadium-host 192.168.1.50   # skip mDNS
npm run bridge -- --allow-writes            # start with writes enabled (not recommended)
npm run bridge -- --no-traffic-log          # disable NDJSON traffic logging
BRIDGE_PORT=9000 npm run bridge             # different HTTP/WS port
```

Rebuild first if you changed code: `npm run build && npm run bridge`.

### Install as an always-on service

```bash
# macOS (launchd, auto-start at login):
./bridge/deploy/install-macos.sh

# Raspberry Pi (systemd; needs avahi-daemon for mDNS):
./bridge/deploy/install-pi.sh
```

---

## 2. Run the Guided Capture Wizard (hardware session)

Prerequisites: Stadium on, same Wi-Fi as this Mac, Remote Access = Allow.

```bash
npm run capture
```

The wizard does the rest — mode choice (A recommended first), preflight
(refuses to start until discovery/device-info/disk/permissions/editor-state
all pass), one instruction at a time with auto-verification, and a manifest
+ summary in `captures/session-<stamp>/` at the end.

- **Mode A** needs packet capture rights. If preflight says so:
  `sudo npm run capture` (or install Wireshark's ChmodBPF once:
  `brew install --cask wireshark`).
- **Mode A**: official Helix Stadium editor OPEN. **Mode B**: fully quit.
- Decode a Mode A segment afterwards:

```bash
npm run cli -- decode-pcap captures/session-*/segments/02-*.pcap
npm run cli -- decode-pcap captures/session-*/segments/02-*.pcap --json > seg02.json
```

After the session: update PROTOCOL.md §4/§7 + CLAUDE.md ("Firmware tested
against"), and refresh mock fixtures from the decoded payloads.

---

## 3. Run everything against the mock (no hardware)

Terminal 1:

```bash
npm run mock -- --verbose
```

Terminal 2 — bridge against the mock:

```bash
STADIUM_HOST=127.0.0.1 npm run bridge -- --verbose
```

Open http://localhost:8484/ in any browser: full app, mock device.

Wizard against the mock (Mode B, short baseline):

```bash
CAPTURE_BASELINE_MS=5000 npm run capture -- --host 127.0.0.1
```

CLI pokes:

```bash
npm run cli -- info --host 127.0.0.1
npm run cli -- watch --host 127.0.0.1 --seconds 20
```

---

## 4. App development (UI work with hot reload)

```bash
# Terminal 1: mock device
npm run mock
# Terminal 2: bridge for the /ws endpoint
STADIUM_HOST=127.0.0.1 npm run bridge
# Terminal 3: Vite dev server (proxies /ws to the bridge)
npm run dev:app
```

Open the printed Vite URL. For the iPad, use the bridge URL instead (built
app): `npm run build && npm run bridge`.

---

## 5. Tests / typecheck

```bash
npm run test        # protocol unit tests + mock<->bridge integration tests
npm run typecheck   # strict TS across all workspaces
npm run build       # full build (protocol -> bridge/mock/tools -> app)
```

---

## 6. CLI reference (tools)

```bash
npm run cli -- discover                       # mDNS scan
npm run cli -- info [--host <ip>]             # product info + snapshot state
npm run cli -- watch [--host <ip>] --seconds 60   # read-only push monitor
npm run cli -- decode-pcap <file.pcap> [--json]
npm run cli -- send --address /SnapshotCountGet --tags i --args '[]' --expect /getSnapshotCount
#   ^ EXPERIMENTAL escape hatch — spare preset only; never wired into the app
```

---

## 7. Optional HTTPS upgrade path (later, unbuilt)

Plain same-origin http://+ws:// avoids mixed-content blocks and works
today. When proper HTTPS is wanted:

- **mkcert**: `brew install mkcert && mkcert -install && mkcert bridge.local
  <lan-ip>` then front the bridge with the cert (bridge TLS support would be
  a small addition — file an issue when needed), or
- **Tailscale**: `tailscale serve https / http://localhost:8484` gives a
  trusted `https://<machine>.<tailnet>.ts.net` URL on every device in the
  tailnet — zero cert management, works off-LAN too.

---

## 8. Where things land on disk

| What | Where |
|---|---|
| Traffic logs (NDJSON, toggleable) | `bridge/logs/traffic-<stamp>.ndjson` |
| Pre-mutation preset snapshots | `bridge/snapshots/preset-<stamp>.json` |
| Capture sessions (manifest, summary, segments) | `captures/session-<stamp>/` |
| Built PWA served by the bridge | `app/dist/` |
| launchd/systemd logs | `bridge/logs/launchd-*.log` / `journalctl -u stadium-bridge` |
