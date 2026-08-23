# Helix Stadium XL editor protocol — Stadium Deck notes

Status: **Phase 0 — pre-capture.** Everything here is cross-referenced from
[Vheissu/helix-stadium-tools](https://github.com/Vheissu/helix-stadium-tools)
(MIT, Dwayne Charrington), which reverse-engineered the protocol from live
captures against real hardware, plus our own reading of that repo's source.
Nothing has yet been verified against *our* unit — that is what
`npm run capture` exists for. Each claim below is tagged:

- **[verified-upstream]** — confirmed against a live device by the community repo
- **[code]** — read directly from the community repo's working client code
- **[synthesized]** — our mock's invention, awaiting capture confirmation
- **[unknown]** — open question for the capture session

The author's blog post
(`ilikekillnerds.com/2025/12/21/reverse-engineering-the-helix-stadium-xl-editor-protocol/`)
is blocked by this workspace's network egress policy; the repo's
`docs/TECHNICAL_DETAILS.md` is by the same author, newer, and more complete,
so it serves as the primary source.

> The protocol is unofficial and may change with any firmware update. Our
> code isolates it in `packages/protocol` with firmware detection
> (`firmware.ts`) so breakage is diagnosable, not fatal.

---

## 1. Transport stack

```
┌───────────────────────────────────────────────┐
│                OSC 1.0 messages               │  addresses like /ParamValueSet
│    (+ 12-byte Helix envelope on port 2001)    │
├───────────────────────────────────────────────┤
│              ZMTP 3.0 framing                 │  ZeroMQ wire protocol, NULL auth
├───────────────────────────────────────────────┤
│                  TCP x 2                      │  ports 2001 + 2002
└───────────────────────────────────────────────┘
```

- **Port 2001** — device → editor stream. Client is ZMTP **SUB**, server
  ROUTER. Pushes + `/heartbeat`. OSC usually wrapped in a 12-byte envelope,
  but raw OSC has also been observed — handle both. **[verified-upstream]**
- **Port 2002** — editor → device commands. Client is ZMTP **DEALER**
  (empty Identity), server ROUTER. Raw OSC request/response, correlated by
  cmdId. **[verified-upstream]**
- Without a completed ZMTP handshake the device **resets the TCP
  connection**. **[verified-upstream]**
- A device with Remote Access set to *Deny* refuses the TCP connect
  (ECONNREFUSED). *Require PIN* implies an authorisation flow that is
  **[unknown]** / not reverse-engineered. Keep the unit on *Allow*.

### Discovery

- Bonjour/mDNS service type `_stadiumserver._tcp`, domain `local.`
  (instance name observed upstream: `p35x1`, host `p35x1.local`).
  **[verified-upstream]**
- The advertised SRV port is the update/subscribe stream (2001); the command
  port is **advertised port + 1**. TXT records are ignored. **[code]**
- Implemented in `bridge/src/discovery.ts` (bonjour-service). Browsers
  cannot mDNS — this is one of the two reasons the bridge exists.

### ZMTP 3.0 handshake (both ports, exact bytes)

1. Client sends this 64-byte greeting in one write **[code]**:

   ```
   ff 00 00 00 00 00 00 00 01 7f   signature
   03 00                           version 3.0
   4e 55 4c 4c 00*16               mechanism "NULL" (20-byte field)
   00                              as-server
   00*31                           filler
   ```

2. Server replies with its own 64-byte greeting. The reference client
   discards it unvalidated; we validate signature + major version leniently
   (`zmtp.ts:validateGreeting`). **[code]**
3. Client sends a READY **command frame** (flags `0x04`):
   `\x05READY` + properties (1-byte name length + name, u32-BE value length
   + value):
   - port 2001: `Socket-Type: SUB` (no Identity) → frame `04 19 ...`
   - port 2002: `Socket-Type: DEALER` + zero-length `Identity` → `04 29 ...`
4. Server replies with its READY (contents ignored). **[code]**
5. Port 2001 only: client sends one **data frame** with payload `0x01` —
   ZMTP subscribe-all (empty topic). Wire: `00 01 01`. **[verified-upstream]**

Order used by every known-good client: SUB handshake → subscribe → DEALER
handshake. Whether the device requires this order is **[unknown]** —
replicate it.

### ZMTP framing

- Short frame: `flags(1) | length(1) | payload` (payload < 256 bytes)
- Long frame: `flags|0x02 (1) | length u64-BE (8) | payload`
- Flag bits: `0x01` MORE (multipart/topic), `0x02` LONG, `0x04` COMMAND
- After the handshake only data frames matter; command frames are skipped.
  MORE-flagged frames appear on 2001 as leading "topic" parts — skip them
  and read the final frame of the batch. **[code]**
- Handle long frames or large replies (edit buffer, content blobs) corrupt.
  **[verified-upstream]**

Implementation: `packages/protocol/src/zmtp.ts` (byte-exact, tested against
the upstream constants in `test/zmtp.test.ts`).

### The 12-byte envelope (port 2001 payloads)

```
u16 BE  version    — observed 0x0108
6 bytes reserved   — zero
u16 BE  sequence
u16 BE  length     — of the OSC message that follows
```

Multiple `[envelope + OSC]` records may be concatenated in one ZMTP frame.
The u16 length caps a wrapped message at 65 535 bytes. The 2001 stream can
ALSO carry raw OSC — `decodeOscPayloads()` auto-discriminates on the first
byte (`/` = raw). **[verified-upstream]** Port 2002 payloads are always raw
OSC. Implementation: `packages/protocol/src/envelope.ts`.

### OSC dialect

Standard OSC 1.0 layout (padded address, padded `,tags`, big-endian args).
Supported tags only: `i` int32, `h` int64, `f` float32, `s` string,
`b` blob (u32 length + padded bytes), `T`/`F` booleans. No bundles, no
timetags. **[code]**

Two quirks a port must preserve (`packages/protocol/src/osc.ts`):

- `T`/`F` consume an **argument slot** but emit no bytes.
- Decoding is deliberately lenient: truncated args decode as `null` and stop
  the scan (captures contain partial frames).

---

## 2. Message model

### Correlation

Every editor→device request carries a client-chosen **cmdId** as its first
argument (`i`). The device echoes it as the first argument of every
correlated reply. Reply forms:

| Address | Shape | Meaning |
|---|---|---|
| `/status` | `,iii [cmdId, code, flag]` | generic ack; `code` 0 = OK. Setters return flag `1`, preset loads flag `0`. **[verified-upstream]** |
| `/success` | `,ii [cmdId, 0]` | ack used by `/PropertyValueSet` + matrix sync writes |
| `/error` | `,iis [cmdId, code, "message"]` | e.g. `Msg dispatch failed: /CreateContent is NOT known!!!` |
| *address-specific* | varies | query replies (see catalogue) |

- Known `/status` error codes: `-4` invalid argument/position;
  `{-19, -8219, -8611, -8701, -8704, -8707}` = **not enough DSP headroom**
  (from the community mobile client). **[code]** → `describeStatusCode()`.
- The reply address for queries is either the camelCase `get*` twin
  (`/SnapshotCountGet` → `/getSnapshotCount`) or — for the content API —
  the **request address itself** (`/GetContentRef` → `/GetContentRef`).
- The edit-buffer reply address **varies in practice**; the community client
  matches any address containing `editbufferstate` case-insensitively. Ours
  does the same (`expectMatch: "contains-insensitive"`). **[code]**
- Pushes on 2001 carry a leading **sessionId** before the echoed cmdId
  (e.g. `/setParamValue ,iiiiiif [sessionId, cmdId, ...]`). How a client
  learns its own sessionId is **[unknown]** — all implementations ignore it.

### Request catalogue (editor → device, port 2002)

All **[verified-upstream]** unless noted. `cmdId` elided from arg lists.

**Reads**
| Address | Tags | Args after cmdId → reply |
|---|---|---|
| `/ProductInfoGet` | `,i` | → `/getProductInfo ,ib [cmdId, msgpack blob]` |
| `/EditBufferStateGet` | `,i` | → `/getEditBufferState ,iib [cmdId, 0, blob]` (address varies, see above) |
| `/PropertyValueGet` | `,is` | key → `/getPropertyValue ,isbi [cmdId, key, lavppgsm blob, 0]` |
| `/SnapshotCountGet` | `,i` | → `/getSnapshotCount ,ii [cmdId, count]` |
| `/ActiveSnapshotIndexGet` | `,i` | → `/getActiveSnapshotIndex ,ii [cmdId, index]` |
| `/SnapshotTargetsGet` | `,ii` | index → `/getSnapshotTargets ,iibi [cmdId, 0, msgpack blob, 0]` |
| `/GetContentRef` | `,ii` | contentId → same address `,ibi [cmdId, blob, 0]` |
| `/GetContainerContents` | `,ii` | containerId → same address `,ibi` |
| `/GetContentData` | `,ii` | contentId → same address `,ibi` |
| `/GetContentPath` | `,ii` | contentId → `,isi [cmdId, "path", 0]` |
| `/GetAllContentInfo` | `,ii` | contentType → `,iibi` |
| `/GetContentInfo` | `,iis` | type, name → `,iisi` |
| `/FindContentMatches` | `,iiss` | type, query, location → `/FindContentInfo ,iissbi` (semantics partly **[unknown]**) |
| `/PropertyDefWithKeyGet` | `,is` | key → `/keyPropertyDefinition` (msgpack) **[code]** |
| `/MatchingPropertyDefinitionsGet` | `,is` | pattern → `/getMatchingPropertyDefinitions` **[code]** |
| `/MatchingPropertyValuesGet` | `,is` | pattern → `/getMatchingPropertyValues` **[code]** |

**Edit buffer writes**
| Address | Tags | Args after cmdId |
|---|---|---|
| `/ParamValueSet` | `,iiiiifi` (float) / `,iiiiiii` (int) | path, block, slot(0), paramId, value, flags(-1) |
| `/HarnessParamValueSet` | `,iiii?i` | path, block, paramId, value, flags — for `harness: true` params |
| `/BlockEnableSet` | `,iiii` | path, block, enabled(0/1) |
| `/ModelSet` | `,iiiii` | path, block, slot(0), modelId (wire MID) |
| `/clrBlock` | `,iii` | flow, **visible position** (not bmap id) |
| `/SplitDestinationSet` | `,iiiii` | flow, position, linkedFlow, linkedBlock (visible positions) |
| `/JoinOriginSet` | `,iiiii` | same shape; invalid combos → `/status [-4, 1]` |
| `/doAgenda` | `,ib` | msgpack list of `{cmnd, flow, bloc}` — batch ops; only `"clrb"` (clear block) confirmed; other `cmnd` values **[unknown]** |
| `/PropertyValueSet` | `,iib` | propertyId(0), `lavppgsm` blob — acked by `/success` or `/status` |

**Snapshots**
| Address | Tags | Notes |
|---|---|---|
| `/activateSnapshot` | `,iii` | index, 0. `/status` ack does NOT follow the 0=success pattern — confirm via `ActiveSnapshotIndexGet` or the 2001 push `/activateSnapshot ,iii [sessionId, cmdId, index]` |
| `/SetSnapshotName` | `,iis` | index, name → push `/setSnapshotName ,iiis [sessionId, cmdId, index, name]` |
| `/CopySnapshot` | `,iii` | source, target |
| `/SnapshotColorSet` | `,iii` | index, colorEnum |

**Presets / content library**
| Address | Tags | Notes |
|---|---|---|
| `/LoadPresetWithCID` | `,ii` | works with raw preset ids and setlist refs; ack `/status [cmdId, 0, 0]` |
| `/LoadPresetAtContainerPosition` | `,iii` | containerId, position |
| `/SavePresetWithCID` | `,ii` | **no synchronous `/status` observed** — confirm via edited-flag/state |
| `/SetContentAttrs` | `,iib` | attrs msgpack blob; updating `name` renames (rename the **rcid** backing id, not the setlist ref — ref renames can be a no-op) |
| `/SetContentData` | `,iib` | full preset data blob |
| `/SetContentPath` | `,iis` | |
| `/AddContentsToContainer` | `,iibiii` | containerId, msgpack [cids], position, flagA(0), flagB(0) |
| `/ReorderContainerContent` | `,iibi` | **insertion index**, not final position (append to 6 items = 6) |
| `/RemoveContent` | `,iib` | containerId, msgpack [cids] |
| `/SetContentInfo` / `/DeleteContentInfo` | `,iiss` / `,iis` | device content-info store |
| `/CreateContent` | — | in the desktop binary but the device answers `/error … NOT known` — do not use |

**Well-known ids/keys**
- Containers: `-1` factory presets, `-2` user presets, `-5` setlist
  directory. Setlist entries are refs (`type` 1) to a backing raw preset
  (`rcid`); raw presets are `type` 2.
- Properties: `server.active.preset.id` (active preset CID),
  `server.mixer.state` (matrix mixer, type `v`),
  `global.modelselect.addcabblock` (auto-cab insert 0/1),
  `preset.meta.info` (preset notes text),
  `preset.floorboard.stomp.<row>.<n>.label` (scribble strips).

### Property blobs

`/PropertyValueSet` and property pushes wrap values as:

```
"lavppgsm" (8 ASCII bytes) + msgpack map { key_: string, type: "s"|"i"|..., val_: value }
```

Map keys are **FourCC uint32s** (`"key_"` = 0x6b65795f). Device msgpack
blobs sometimes carry a short binary prefix — decode by probing offsets
0/4/8/12/16. **[code]** Implementation: `packages/protocol/src/blobs.ts`.

### Device → editor pushes (port 2001)

`/heartbeat` (cadence **[unknown]** — measure in the capture baseline; arg
shape also unconfirmed), `/setParamValue`, `/setBlockEnable`,
`/setModelWithMID`, `/setSnapshotName`, `/activateSnapshot`,
`/setPropertyValue`, `/setControllerValue`, `/setSelectedBlock`, and the
matrix mixer family `/syncMixChannel{Volume,Pan,Mute,Solo}` +
`/syncMixAttachedOut` (layer at arg 2, channel at arg 3, value at arg 4;
layers 1=1/4", 2=XLR, 3=Phones; channels 1–23). Matrix mixer is
**readback only** — no network command has been found that moves the real
hardware mixer. **[verified-upstream]**

### Edit buffer shape

`/getEditBufferState` blob (msgpack, FourCC keys) contains `sfg_.flow[]` —
flows with `blks` as alternating `[pos, blockDict]` pairs (or an array
indexed via `bmap`). Visible positions: Row A `0`=input, `1–12` blocks,
`13`=output; Row B `14`, `15–26`, `27`. Writes are keyed by **visible
position**; raw `bmap` ids acknowledge but don't reliably change state.
Block dicts carry `id__`, model id (`mid_`/`mdls[].id__`), enable state.
Exact key set to be confirmed from our own captures. **[verified-upstream]**

---

## 3. Behavioural notes for implementers

- Editor startup fires a battery of reads back-to-back without waiting:
  ProductInfo, EditBufferState, ~12 PropertyValueGets, container walks.
  Pipelining works; correlation is by cmdId. **[code]**
- No client keepalive exists; there is no reconnect logic upstream. Our
  bridge adds both (heartbeat/traffic liveness + reconnect with backoff +
  re-discovery) — see `packages/protocol/src/state-machine.ts`.
- Device-local edits (touchscreen/knobs) do **not** traverse the editor
  command stream — only some hardware events broadcast on 2001. This shapes
  the capture wizard: Mode A (official editor + tcpdump) is the primary
  source of command signatures; Mode B (read-only observe) sees broadcasts.
  **[verified-upstream]**
- Bluetooth is audio-only; USB-C is firmware-update-only today (a live
  vendor bulk interface exists but no editor commands work over it).
  Wi-Fi/Ethernet TCP is the sole control path. **[verified-upstream]**

## 4. What our capture session must establish ([unknown] list)

1. `/heartbeat` cadence and argument shape (baseline step).
2. `/getProductInfo` blob schema on OUR firmware — exact model/firmware key
   names (then fix `firmware.ts:parseDeviceInfo`, currently best-guess).
3. Envelope version still `0x0108` on current firmware.
4. Exact `/getEditBufferState` reply tags + blob schema for our unit.
5. Footswitch and expression-pedal message signatures (not in upstream docs).
6. Setlist-switch signature (`/LoadPresetAtContainerPosition`? something else?).
7. Preset save/rename full sequences incl. string encoding.
8. Reconnect behaviour after power-cycle (optional step 22).
9. Whether two concurrent editor sessions are tolerated (bridge + editor).

## 5. Mock fidelity

`/mock` speaks the full stack (real ZMTP handshake, envelope, catalogue
above) but its *payload contents* are **[synthesized]**:
`getProductInfo`/`getEditBufferState` blob schemas, heartbeat `,i [count]`
shape, and preset/snapshot fixtures are invented. After the first capture
session, regenerate fixtures from real payloads:
`npm run cli -- decode-pcap <segment.pcap> --json` emits decoded messages;
paste representative blobs into `mock/src/device-model.ts` (or a fixtures
JSON) and align any response tags that differ.

## 6. Data we can reuse for Phases 2–3 (model browser, validation)

From the community repo (MIT, attribute in-app):

- `generated/helix-models/model_id_map.json` — 811 rows; 807 unique wire
  MIDs (3–844): the name/key → `/ModelSet` id join.
- `mobile/src/data/blockTypes.json` (3.4 MB) — the richest catalogue: wire
  MID **and wire param ids** per model, raw + display ranges/defaults,
  units, options, descriptions, per-model DSP `usage` + `auto_cab_usage`.
  This is the model-browser + param-editor seed.
- `mobile/src/data/ioModels.json`, `models.json` (based-on gear names),
  `paramHelp.json` (0.9 MB help text).
- Algorithms worth porting when needed: `scripts/compute_dsp_usage.py`
  (live DSP meter), `helix_control.py:resolve_model_id` (name resolution
  ladder), `generate_helix_model_json.py:compute_display_value` (raw 0..1 →
  display units).

Do not vendor these blindly into the repo yet — decide at Phase 2 whether to
copy (with attribution) or regenerate from our own device/app bundle.

## 7. Firmware compatibility log

| Firmware | Envelope | Validated | Notes |
|---|---|---|---|
| (none yet) | 0x0108 expected | — | pre-capture; update after first `npm run capture` and add the version to `VALIDATED_FIRMWARE_VERSIONS` in `packages/protocol/src/firmware.ts` |
