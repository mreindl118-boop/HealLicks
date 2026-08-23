# Stadium Deck

iPad-first PWA + LAN bridge for viewing, controlling, and editing a Line 6
Helix Stadium XL in real time — live board control, active-preset editing,
and drag-and-drop signal-chain editing, from the couch.

**Unofficial personal interoperability tool.** Not affiliated with,
endorsed by, or associated with Line 6, Yamaha Guitar Group, or Yamaha
Corporation. "Helix" and "Helix Stadium" are trademarks of their respective
owners, referenced solely for identification and interoperability.

## How it works

Safari on iPadOS cannot open raw TCP sockets or browse mDNS, and the
Stadium's editor protocol is OSC inside ZMTP 3.0 over two TCP ports. So a
small Node **bridge** daemon on an always-on Mac (or Raspberry Pi)
discovers the device, holds the TCP link, serves the PWA, and relays typed
JSON over a same-origin WebSocket.

```
iPad PWA  ⇄  bridge (Node, Mac/Pi)  ⇄  Helix Stadium XL (TCP 2001/2002)
```

## Quick start

```bash
npm install && npm run build && npm run bridge
```

Scan the printed QR code with the iPad, then Add to Home Screen. Full
command reference: [RUNBOOK.md](RUNBOOK.md). No hardware? `npm run mock`
first and pass `STADIUM_HOST=127.0.0.1` to the bridge.

## Repo map

- `packages/protocol` — typed protocol implementation (tested; Node + browser)
- `bridge` — LAN daemon (discovery, device link, WS relay, static PWA, safety rails)
- `app` — the iPad PWA (Vite + React + zustand)
- `mock` — full mock Stadium for hardware-free development
- `tools` — Guided Capture Wizard (`npm run capture`), CLI, pcap decoder
- [PROTOCOL.md](PROTOCOL.md) — the protocol spec as we know it
- [CLAUDE.md](CLAUDE.md) — project memory / phase status
- [RUNBOOK.md](RUNBOOK.md) — copy-paste commands for every session type

## Safety rails

Read-only by default (visible toggle in the app), pre-mutation preset
snapshots to disk, rate-limited control messages, and experimental protocol
pokes confined to the CLI — never the app UI.

## Credits

Protocol knowledge builds on
[Vheissu/helix-stadium-tools](https://github.com/Vheissu/helix-stadium-tools)
(MIT, Dwayne Charrington) — the definitive community reverse-engineering
effort. See PROTOCOL.md for the cross-referenced details.

## License

MIT (see [LICENSE](LICENSE)). Use at your own risk; respect the Line 6 EULA
and use a spare preset when experimenting against real hardware.
