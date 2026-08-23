/**
 * Maps editor->device OSC requests to the responses and subscribed pushes the
 * real Stadium was observed to emit (docs/TECHNICAL_DETAILS.md upstream).
 * Response tags follow the reference client's expectations:
 *   /getProductInfo      ,ib   blob at arg 1
 *   /getEditBufferState  ,iib  blob at arg 2
 *   /getPropertyValue    ,isb  blob at arg 2
 *   /GetContentRef       ,ibi  blob at arg 1
 *   /GetContentPath      ,isi  path at arg 1
 * Mutations ack with /status ,iii (or /success for PropertyValueSet) and
 * mirror the change as a push on the subscribed stream.
 */

import {
  REQ,
  buildPropertyBlob,
  decodePropertyBlob,
  encodeMsgpack,
  type OscMessage,
  type OscValue,
} from "@stadium-deck/protocol";
import { DeviceModel } from "./device-model.js";

export interface OutMessage {
  address: string;
  typeTags: string;
  args: OscValue[];
}

export interface ResponderResult {
  /** Replies to write to the command socket (port 2002). */
  replies: OutMessage[];
  /** Pushes to broadcast on the subscribed stream (port 2001). */
  pushes: OutMessage[];
}

function status(cmdId: number, code = 0, flag = 1): OutMessage {
  return { address: "/status", typeTags: "iii", args: [cmdId, code, flag] };
}

function error(cmdId: number, text: string): OutMessage {
  return { address: "/error", typeTags: "iis", args: [cmdId, 0, text] };
}

function int(value: OscValue | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "bigint") return Number(value);
  return null;
}

export class Responder {
  constructor(readonly device: DeviceModel) {}

  handle(message: OscMessage): ResponderResult {
    const none: ResponderResult = { replies: [], pushes: [] };
    const cmdId = int(message.args[0]);
    if (cmdId === null) return none;
    const device = this.device;
    const session = device.sessionId;

    switch (message.address) {
      case REQ.ProductInfoGet:
        return {
          replies: [
            { address: "/getProductInfo", typeTags: "ib", args: [cmdId, encodeMsgpack(device.productInfo())] },
          ],
          pushes: [],
        };

      case REQ.EditBufferStateGet:
        return {
          replies: [
            {
              address: "/getEditBufferState",
              typeTags: "iib",
              args: [cmdId, 0, encodeMsgpack(device.editBufferState())],
            },
          ],
          pushes: [],
        };

      case REQ.PropertyValueGet: {
        const key = typeof message.args[1] === "string" ? message.args[1] : "";
        const value =
          key === "server.active.preset.id" ? device.activePresetCid : device.properties.get(key);
        if (value === undefined) {
          return { replies: [error(cmdId, `Property not found: ${key}`)], pushes: [] };
        }
        const valueType = typeof value === "number" ? "i" : "s";
        return {
          replies: [
            {
              // Observed reply shape: ,isbi [cmdId, key, blob, 0]
              address: "/getPropertyValue",
              typeTags: "isbi",
              args: [cmdId, key, buildPropertyBlob(key, value, valueType), 0],
            },
          ],
          pushes: [],
        };
      }

      case REQ.PropertyValueSet: {
        const blob = message.args[2];
        if (!(blob instanceof Uint8Array)) return { replies: [status(cmdId, -1, 1)], pushes: [] };
        const decoded = decodePropertyBlob(blob);
        if (decoded !== null && typeof decoded === "object" && !Array.isArray(decoded) && !(decoded instanceof Uint8Array)) {
          const key = decoded["key_"];
          const value = decoded["val_"];
          if (typeof key === "string" && (typeof value === "string" || typeof value === "number")) {
            device.properties.set(key, value);
          }
        }
        return {
          replies: [{ address: "/success", typeTags: "ii", args: [cmdId, 0] }],
          pushes: [{ address: "/setPropertyValue", typeTags: "iib", args: [session, cmdId, blob] }],
        };
      }

      case REQ.SnapshotCountGet:
        return {
          replies: [
            { address: "/getSnapshotCount", typeTags: "ii", args: [cmdId, device.snapshots.length] },
          ],
          pushes: [],
        };

      case REQ.ActiveSnapshotIndexGet:
        return {
          replies: [
            { address: "/getActiveSnapshotIndex", typeTags: "ii", args: [cmdId, device.activeSnapshotIndex] },
          ],
          pushes: [],
        };

      case REQ.SnapshotTargetsGet:
        return {
          replies: [
            {
              address: "/getSnapshotTargets",
              typeTags: "iibi",
              args: [cmdId, 0, encodeMsgpack([16, 17, 18, 15, 14, 13]), 0],
            },
          ],
          pushes: [],
        };

      case REQ.ActivateSnapshot: {
        const index = int(message.args[1]);
        if (index === null || index < 0 || index >= device.snapshots.length) {
          return { replies: [status(cmdId, -4, 1)], pushes: [] };
        }
        device.activeSnapshotIndex = index;
        return {
          replies: [status(cmdId, 0, 1)],
          pushes: [{ address: "/activateSnapshot", typeTags: "iii", args: [session, cmdId, index] }],
        };
      }

      case REQ.SetSnapshotName: {
        const index = int(message.args[1]);
        const name = typeof message.args[2] === "string" ? message.args[2] : null;
        const snapshot = index === null ? undefined : device.snapshots[index];
        if (!snapshot || name === null) return { replies: [status(cmdId, -4, 1)], pushes: [] };
        snapshot.name = name;
        device.presetEdited = true;
        return {
          replies: [status(cmdId, 0, 1)],
          pushes: [{ address: "/setSnapshotName", typeTags: "iiis", args: [session, cmdId, index!, name] }],
        };
      }

      case REQ.CopySnapshot: {
        const source = int(message.args[1]);
        const target = int(message.args[2]);
        const from = source === null ? undefined : device.snapshots[source];
        if (!from || target === null || target < 0 || target >= device.snapshots.length) {
          return { replies: [status(cmdId, -4, 1)], pushes: [] };
        }
        device.snapshots[target] = { ...from };
        device.presetEdited = true;
        return { replies: [status(cmdId, 0, 1)], pushes: [] };
      }

      case REQ.SnapshotColorSet: {
        const index = int(message.args[1]);
        const color = int(message.args[2]);
        const snapshot = index === null ? undefined : device.snapshots[index];
        if (!snapshot || color === null) return { replies: [status(cmdId, -4, 1)], pushes: [] };
        snapshot.color = color;
        device.presetEdited = true;
        return { replies: [status(cmdId, 0, 1)], pushes: [] };
      }

      case REQ.LoadPresetWithCID: {
        const cid = int(message.args[1]);
        const preset = cid === null ? undefined : device.presetByCid(cid);
        if (!preset) return { replies: [status(cmdId, -4, 0)], pushes: [] };
        device.activePresetCid = preset.cid;
        device.presetEdited = false;
        return {
          replies: [status(cmdId, 0, 0)],
          pushes: [
            {
              address: "/setPropertyValue",
              typeTags: "iib",
              args: [session, cmdId, buildPropertyBlob("server.active.preset.id", preset.cid, "i")],
            },
          ],
        };
      }

      case REQ.LoadPresetAtContainerPosition: {
        const container = int(message.args[1]);
        const position = int(message.args[2]);
        const preset =
          container === null || position === null ? undefined : device.presetAt(container, position);
        if (!preset) return { replies: [status(cmdId, -4, 0)], pushes: [] };
        device.activePresetCid = preset.cid;
        device.presetEdited = false;
        return { replies: [status(cmdId, 0, 0)], pushes: [] };
      }

      case REQ.SavePresetWithCID:
        // Observed: accepts the request without a synchronous /status ack.
        device.presetEdited = false;
        return none;

      case REQ.GetContentRef: {
        const cid = int(message.args[1]);
        const preset = cid === null ? undefined : device.presetByCid(cid);
        if (!preset) return { replies: [error(cmdId, `Unknown content id ${cid}`)], pushes: [] };
        return {
          replies: [
            {
              address: "/GetContentRef",
              typeTags: "ibi",
              args: [cmdId, encodeMsgpack(device.contentRef(preset)), 0],
            },
          ],
          pushes: [],
        };
      }

      case REQ.GetContainerContents: {
        const container = int(message.args[1]);
        const contents = container === null ? [] : device.containerContents(container);
        return {
          replies: [
            {
              address: "/GetContainerContents",
              typeTags: "ibi",
              args: [cmdId, encodeMsgpack(contents.map((p) => device.contentRef(p))), 0],
            },
          ],
          pushes: [],
        };
      }

      case REQ.GetContentData: {
        const cid = int(message.args[1]);
        const preset = cid === null ? undefined : device.presetByCid(cid);
        if (!preset) return { replies: [error(cmdId, `Unknown content id ${cid}`)], pushes: [] };
        return {
          replies: [
            {
              address: "/GetContentData",
              typeTags: "ibi",
              args: [cmdId, encodeMsgpack({ name: preset.name, data: { mock: true } }), 0],
            },
          ],
          pushes: [],
        };
      }

      case REQ.GetContentPath: {
        const cid = int(message.args[1]);
        const preset = cid === null ? undefined : device.presetByCid(cid);
        if (!preset) return { replies: [error(cmdId, `Unknown content id ${cid}`)], pushes: [] };
        const root = preset.containerCid === -1 ? "Factory" : "User";
        return {
          replies: [
            {
              address: "/GetContentPath",
              typeTags: "isi",
              args: [cmdId, `/${root}/${preset.name}`, 0],
            },
          ],
          pushes: [],
        };
      }

      case REQ.ParamValueSet: {
        const path = int(message.args[1]);
        const position = int(message.args[2]);
        const paramId = int(message.args[4]);
        const rawValue = message.args[5];
        const value = typeof rawValue === "number" ? rawValue : null;
        const block = position === null ? undefined : device.blockAt(position);
        if (path === null || !block || paramId === null || value === null) {
          return { replies: [status(cmdId, -4, 1)], pushes: [] };
        }
        block.params.set(paramId, value);
        device.presetEdited = true;
        return {
          replies: [status(cmdId, 0, 1)],
          pushes: [
            {
              address: "/setParamValue",
              typeTags: "iiiiiif",
              args: [session, cmdId, path, position, 0, paramId, value],
            },
          ],
        };
      }

      case REQ.BlockEnableSet: {
        const path = int(message.args[1]);
        const position = int(message.args[2]);
        const enabled = int(message.args[3]);
        const block = position === null ? undefined : device.blockAt(position);
        if (path === null || !block || enabled === null) {
          return { replies: [status(cmdId, -4, 1)], pushes: [] };
        }
        block.enabled = enabled !== 0;
        device.presetEdited = true;
        return {
          replies: [status(cmdId, 0, 1)],
          pushes: [
            { address: "/setBlockEnable", typeTags: "iiiii", args: [session, cmdId, path, position, enabled] },
          ],
        };
      }

      case REQ.ModelSet: {
        const path = int(message.args[1]);
        const position = int(message.args[2]);
        const modelId = int(message.args[4]);
        const block = position === null ? undefined : device.blockAt(position);
        if (path === null || position === null || modelId === null) {
          return { replies: [status(cmdId, -4, 1)], pushes: [] };
        }
        if (block) {
          block.modelId = modelId;
          block.modelName = `Mock Model ${modelId}`;
        } else {
          device.blocks.push({
            position,
            modelId,
            modelName: `Mock Model ${modelId}`,
            enabled: true,
            params: new Map([[0, 0.5]]),
          });
        }
        device.presetEdited = true;
        return {
          replies: [status(cmdId, 0, 1)],
          pushes: [
            { address: "/setModelWithMID", typeTags: "iiiii", args: [session, cmdId, path, position, modelId] },
          ],
        };
      }

      case REQ.ClrBlock: {
        const position = int(message.args[2]);
        const index = device.blocks.findIndex((b) => b.position === position);
        if (index === -1) return { replies: [status(cmdId, -4, 1)], pushes: [] };
        device.blocks.splice(index, 1);
        device.presetEdited = true;
        return { replies: [status(cmdId, 0, 1)], pushes: [] };
      }

      case REQ.DoAgenda:
        return { replies: [status(cmdId, 0, 1)], pushes: [] };

      case REQ.SetContentAttrs:
      case REQ.SetContentData: {
        const cid = int(message.args[1]);
        const blob = message.args[2];
        if (message.address === REQ.SetContentAttrs && cid !== null && blob instanceof Uint8Array) {
          const preset = device.presetByCid(cid);
          const decoded = decodePropertyBlob(blob);
          if (
            preset &&
            decoded !== null &&
            typeof decoded === "object" &&
            !Array.isArray(decoded) &&
            !(decoded instanceof Uint8Array) &&
            typeof decoded["name"] === "string"
          ) {
            preset.name = decoded["name"];
          }
        }
        return { replies: [status(cmdId, 0, 1)], pushes: [] };
      }

      case REQ.SetContentPath:
        return { replies: [status(cmdId, 0, 1)], pushes: [] };

      default:
        return {
          replies: [error(cmdId, `Msg dispatch failed: ${message.address} is NOT known!!!`)],
          pushes: [],
        };
    }
  }
}
