# Stadium Deck — project memory

iPad-first PWA + LAN bridge for viewing, controlling, and editing a Line 6
Helix Stadium XL in real time. Personal interoperability tool; not a
product. Keep this file current every session.

## Architecture (settled — do not relitigate)

Safari/iPadOS cannot open raw TCP or do mDNS, and the Stadium speaks an
OSC-over-ZMTP protocol on raw TCP. Therefore:

```
iPad Safari PWA  ── http:// + ws:// (same-origin) ──▶  BRIDGE (Node daemon on Mac/Pi)
                                                          │  mDNS discovery
                                                          │  TCP 2001 (SUB stream)
                                                          │  TCP 2002 (DEALER commands)
                                                          ▼
                                                   Helix Stadium XL
```

npm workspaces monorepo:

| Path | Package | Role |
|---|---|---|
| `packages/protocol` | `@stadium-deck/protocol` | Pure typed protocol: OSC codec, ZMTP 3.0 framing, 0x0108 envelope, msgpack blobs, message catalogue + builders, request correlation, connection state machine, heartbeat monitor, firmware compat, bridge⇄app WS message types. No sockets/UI. Runs in Node + browser. Unit-tested (vitest). |
| `bridge` | `@stadium-deck/bridge` | Daemon: discovery, `StadiumClient` (TCP + handshakes), `StadiumLink` (reconnect state machine driver), WS relay w/ READ-ONLY + rate-limit + pre-mutation snapshots, static PWA serving, NDJSON traffic logs, QR pairing, launchd/systemd deploy. Exports `./stadium-client`, `./discovery` etc. for tools/tests. |
| `app` | `@stadium-deck/app` | Vite+React+zustand PWA. Phase 0: connection-status shell w/ read-only toggle, Safari reconnect+resync hardening (`ws-client.ts`). Board UI = Phase 1. |
| `mock` | `@stadium-deck/mock` | Full mock Stadium over real TCP+ZMTP (`npm run mock`); integration tests drive the real bridge client against it. |
| `tools` | `@stadium-deck/tools` | Guided Capture Wizard (`npm run capture`), CLI (`npm run cli -- discover|info|watch|send|decode-pcap`), TS pcap→OSC decoder. Experimental messages live here, never the app. |

Key invariants:
- The app renders ONLY from bridge-relayed state; it never speaks the device
  protocol directly.
- WS `request` messages carry args WITHOUT cmdId (bridge allocates it).
- Bridge starts READ-ONLY; writes need the explicit UI toggle
  (`--allow-writes` / `BRIDGE_ALLOW_WRITES=1` to change the default).
- Before any preset-modifying request the bridge snapshots state to
  `bridge/snapshots/` (10s throttle) — see `bridge/src/snapshots.ts`.
- Outbound control messages are token-bucket rate-limited in the WS relay.
- HTTP upgrade path later: mkcert local CA or `tailscale serve` in front of
  the bridge (documented in RUNBOOK.md; not built).

## Protocol findings

See PROTOCOL.md (the living spec, with verified/synthesized/unknown tags).
One-line summary: OSC 1.0 messages inside ZMTP 3.0 frames over two TCP
ports (2001 device→editor stream w/ 12-byte 0x0108 envelope; 2002
editor→device raw), discovered via `_stadiumserver._tcp`, correlated by a
cmdId echoed as the first reply arg.

Primary source: `/home/user/vheissu/helix-stadium-tools` clone (MIT,
Dwayne Charrington) — `docs/TECHNICAL_DETAILS.md`, `helix/*.py`, and
`mobile/src/protocol/*.ts` (an existing TS client port our protocol package
was cross-checked against). The author's blog post is egress-blocked here;
the repo supersedes it. If that clone is gone, re-clone:
`git clone https://github.com/Vheissu/helix-stadium-tools`.

## Firmware tested against

**None yet** (pre-capture). Mock reports `0.0.0-mock`. After the first real
capture: record firmware here, add it to `VALIDATED_FIRMWARE_VERSIONS`
(`packages/protocol/src/firmware.ts`), fix `parseDeviceInfo` key names
against the real `/getProductInfo` blob, and update PROTOCOL.md §7.

## Phase status

- **Phase 0 — Protocol spike: code complete; awaiting hardware session.**
  Done: research (community repo deep-read + audited), PROTOCOL.md,
  monorepo, protocol package (86 tests), mock, bridge (verified end-to-end
  against mock: discovery→handshake→queries→writes→pushes→read-only rail),
  Guided Capture Wizard (verified against mock in Mode B), CLI + pcap
  decoder, PWA shell served by bridge.
  Remaining: run `npm run capture` against the real Stadium (Mode A then
  Mode B), then update PROTOCOL.md §4/§7 + regenerate mock fixtures from
  captures.
- Phase 1 — Live board: not started.
- Phase 2 — Active-preset editing: not started. (Model metadata seeding
  path documented in PROTOCOL.md §6 — `blockTypes.json` has wire param ids.)
- Phase 3 — Drag & drop + librarian: not started. (User has an .hsp
  library + "Tone Bible" to seed the librarian — ask for them then.)
- Phase 4 — Polish: not started.

## Open questions

The authoritative list is PROTOCOL.md §4 (heartbeat cadence, product-info
schema, edit-buffer schema, footswitch/pedal/setlist signatures, save/rename
sequences, reconnect behaviour, concurrent-session tolerance). Also:
- Does the bridge coexist with the official editor connected (Mode A
  implies yes for reads)? Affects whether we must warn users to close it.
- iPad Add-to-Home-Screen flow needs a real-device pass (icons/meta are in
  place; untested on hardware).

## Development notes

- Node ≥20 (dev container: v22). Build: `npm run build` (tsc -b project
  references + vite). Tests: `npm run test`. Everything runnable per
  RUNBOOK.md one-liners.
- Strict TS everywhere, no `any`. ESM throughout. Workspace imports resolve
  to `dist/` — run a build after changing `packages/protocol` before using
  dependents' start scripts.
- The wizard has test hooks: `--host/--update-port/--command-port` (skip
  mDNS, e.g. against the mock) and `CAPTURE_BASELINE_MS` (shorten the 60s
  baseline). Paced-stdin smoke: see scratchpad history or RUNBOOK.md.
- tcpdump is only needed for capture Mode A, not for normal bridge use.
- Repo remote name is HealLicks (pre-existing); the project is Stadium Deck.
