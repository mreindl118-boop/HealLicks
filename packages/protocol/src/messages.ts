/**
 * Typed request builders and response classification for the Stadium protocol.
 *
 * Every editor->device request carries a client-chosen cmdId as its first
 * argument; the device echoes it as the first argument of the response
 * (`/status`, `/success`, `/error`, or an address-specific reply), which is
 * how request/response correlation works (see correlation.ts).
 */

import { REQ, RESP } from "./addresses.js";
import { buildPropertyBlob, encodeMsgpack, type PropertyValueType } from "./blobs.js";
import type { OscMessage, OscValue } from "./osc.js";

/** A fully-formed outbound OSC request (not yet encoded). */
export interface OutboundRequest {
  address: string;
  typeTags: string;
  args: OscValue[];
  cmdId: number;
  /** Address of the expected correlated reply; generic acks (/status, /success, /error) always match. */
  expectAddress?: string;
  /**
   * "exact" (default) or "contains-insensitive" — the edit-buffer reply
   * address has been observed to vary, so the community client matches it by
   * case-insensitive substring.
   */
  expectMatch?: "exact" | "contains-insensitive";
}

function req(
  cmdId: number,
  address: string,
  typeTags: string,
  args: OscValue[],
  expectAddress?: string,
): OutboundRequest {
  return expectAddress !== undefined
    ? { address, typeTags, args, cmdId, expectAddress }
    : { address, typeTags, args, cmdId };
}

// ---------------------------------------------------------------------------
// Reads / queries
// ---------------------------------------------------------------------------

export const buildProductInfoGet = (cmdId: number): OutboundRequest =>
  req(cmdId, REQ.ProductInfoGet, "i", [cmdId], RESP.GetProductInfo);

export const buildEditBufferStateGet = (cmdId: number): OutboundRequest => ({
  ...req(cmdId, REQ.EditBufferStateGet, "i", [cmdId], "editbufferstate"),
  expectMatch: "contains-insensitive",
});

export const buildPropertyValueGet = (cmdId: number, key: string): OutboundRequest =>
  req(cmdId, REQ.PropertyValueGet, "is", [cmdId, key], RESP.GetPropertyValue);

export const buildSnapshotCountGet = (cmdId: number): OutboundRequest =>
  req(cmdId, REQ.SnapshotCountGet, "i", [cmdId], RESP.GetSnapshotCount);

export const buildActiveSnapshotIndexGet = (cmdId: number): OutboundRequest =>
  req(cmdId, REQ.ActiveSnapshotIndexGet, "i", [cmdId], RESP.GetActiveSnapshotIndex);

export const buildSnapshotTargetsGet = (cmdId: number, snapshotIndex: number): OutboundRequest =>
  req(cmdId, REQ.SnapshotTargetsGet, "ii", [cmdId, snapshotIndex], RESP.GetSnapshotTargets);

export const buildGetContentRef = (cmdId: number, contentId: number): OutboundRequest =>
  req(cmdId, REQ.GetContentRef, "ii", [cmdId, contentId], RESP.GetContentRef);

export const buildGetContainerContents = (cmdId: number, containerId: number): OutboundRequest =>
  req(cmdId, REQ.GetContainerContents, "ii", [cmdId, containerId], RESP.GetContainerContents);

export const buildGetContentData = (cmdId: number, contentId: number): OutboundRequest =>
  req(cmdId, REQ.GetContentData, "ii", [cmdId, contentId], RESP.GetContentData);

export const buildGetContentPath = (cmdId: number, contentId: number): OutboundRequest =>
  req(cmdId, REQ.GetContentPath, "ii", [cmdId, contentId], RESP.GetContentPath);

export const buildGetAllContentInfo = (cmdId: number, contentType: number): OutboundRequest =>
  req(cmdId, REQ.GetAllContentInfo, "ii", [cmdId, contentType], RESP.GetAllContentInfo);

export const buildGetContentInfo = (cmdId: number, contentType: number, name: string): OutboundRequest =>
  req(cmdId, REQ.GetContentInfo, "iis", [cmdId, contentType, name], RESP.GetContentInfo);

export const buildFindContentMatches = (
  cmdId: number,
  contentType: number,
  query: string,
  location = "",
): OutboundRequest =>
  req(cmdId, REQ.FindContentMatches, "iiss", [cmdId, contentType, query, location], RESP.FindContentInfo);

export const buildPropertyDefWithKeyGet = (cmdId: number, key: string): OutboundRequest =>
  req(cmdId, REQ.PropertyDefWithKeyGet, "is", [cmdId, key], RESP.KeyPropertyDefinition);

export const buildMatchingPropertyDefinitionsGet = (cmdId: number, pattern: string): OutboundRequest =>
  req(cmdId, REQ.MatchingPropertyDefinitionsGet, "is", [cmdId, pattern], RESP.GetMatchingPropertyDefinitions);

export const buildMatchingPropertyValuesGet = (cmdId: number, pattern: string): OutboundRequest =>
  req(cmdId, REQ.MatchingPropertyValuesGet, "is", [cmdId, pattern], RESP.GetMatchingPropertyValues);

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

/**
 * Switch the active snapshot. NOTE: the /status ack for this request does not
 * follow the usual success pattern; confirm via ActiveSnapshotIndexGet or the
 * port-2001 /activateSnapshot push.
 */
export const buildActivateSnapshot = (cmdId: number, snapshotIndex: number): OutboundRequest =>
  req(cmdId, REQ.ActivateSnapshot, "iii", [cmdId, snapshotIndex, 0]);

export const buildSetSnapshotName = (cmdId: number, snapshotIndex: number, name: string): OutboundRequest =>
  req(cmdId, REQ.SetSnapshotName, "iis", [cmdId, snapshotIndex, name]);

export const buildCopySnapshot = (cmdId: number, sourceIndex: number, targetIndex: number): OutboundRequest =>
  req(cmdId, REQ.CopySnapshot, "iii", [cmdId, sourceIndex, targetIndex]);

export const buildSnapshotColorSet = (cmdId: number, snapshotIndex: number, colorEnum: number): OutboundRequest =>
  req(cmdId, REQ.SnapshotColorSet, "iii", [cmdId, snapshotIndex, colorEnum]);

// ---------------------------------------------------------------------------
// Preset recall / save / content management
// ---------------------------------------------------------------------------

export const buildLoadPresetWithCID = (cmdId: number, contentId: number): OutboundRequest =>
  req(cmdId, REQ.LoadPresetWithCID, "ii", [cmdId, contentId]);

export const buildLoadPresetAtContainerPosition = (
  cmdId: number,
  containerId: number,
  position: number,
): OutboundRequest =>
  req(cmdId, REQ.LoadPresetAtContainerPosition, "iii", [cmdId, containerId, position]);

/** May not emit a synchronous /status ack; confirm via the edited flag or state re-read. */
export const buildSavePresetWithCID = (cmdId: number, contentId: number): OutboundRequest =>
  req(cmdId, REQ.SavePresetWithCID, "ii", [cmdId, contentId]);

export const buildSetContentAttrs = (cmdId: number, contentId: number, attrsBlob: Uint8Array): OutboundRequest =>
  req(cmdId, REQ.SetContentAttrs, "iib", [cmdId, contentId, attrsBlob]);

export const buildSetContentData = (cmdId: number, contentId: number, dataBlob: Uint8Array): OutboundRequest =>
  req(cmdId, REQ.SetContentData, "iib", [cmdId, contentId, dataBlob]);

export const buildSetContentPath = (cmdId: number, contentId: number, path: string): OutboundRequest =>
  req(cmdId, REQ.SetContentPath, "iis", [cmdId, contentId, path]);

export const buildAddContentsToContainer = (
  cmdId: number,
  containerId: number,
  contentIds: readonly number[],
  position: number,
  flagA = 0,
  flagB = 0,
): OutboundRequest =>
  req(cmdId, REQ.AddContentsToContainer, "iibiii", [
    cmdId,
    containerId,
    encodeMsgpack([...contentIds]),
    position,
    flagA,
    flagB,
  ]);

/** `position` is an insertion index, not a final position (append to N items = N). */
export const buildReorderContainerContent = (
  cmdId: number,
  containerId: number,
  contentIds: readonly number[],
  position: number,
): OutboundRequest =>
  req(cmdId, REQ.ReorderContainerContent, "iibi", [cmdId, containerId, encodeMsgpack([...contentIds]), position]);

export const buildRemoveContent = (
  cmdId: number,
  containerId: number,
  contentIds: readonly number[],
): OutboundRequest =>
  req(cmdId, REQ.RemoveContent, "iib", [cmdId, containerId, encodeMsgpack([...contentIds])]);

export const buildSetContentInfo = (
  cmdId: number,
  contentType: number,
  key: string,
  value: string,
): OutboundRequest =>
  req(cmdId, REQ.SetContentInfo, "iiss", [cmdId, contentType, key, value]);

export const buildDeleteContentInfo = (cmdId: number, contentType: number, key: string): OutboundRequest =>
  req(cmdId, REQ.DeleteContentInfo, "iis", [cmdId, contentType, key]);

// ---------------------------------------------------------------------------
// Edit buffer: params, blocks, routing
// ---------------------------------------------------------------------------

/** Float parameter set: [cmdId, path, block, slot, paramId, value, flags(-1)]. */
export const buildParamValueSet = (
  cmdId: number,
  path: number,
  block: number,
  paramId: number,
  value: number,
  slot = 0,
  flags = -1,
): OutboundRequest =>
  Number.isInteger(value)
    ? req(cmdId, REQ.ParamValueSet, "iiiiiii", [cmdId, path, block, slot, paramId, value, flags])
    : req(cmdId, REQ.ParamValueSet, "iiiiifi", [cmdId, path, block, slot, paramId, value, flags]);

export const buildBlockEnableSet = (
  cmdId: number,
  path: number,
  block: number,
  enabled: boolean,
): OutboundRequest =>
  req(cmdId, REQ.BlockEnableSet, "iiii", [cmdId, path, block, enabled ? 1 : 0]);

export const buildModelSet = (
  cmdId: number,
  path: number,
  block: number,
  modelId: number,
  slot = 0,
): OutboundRequest =>
  req(cmdId, REQ.ModelSet, "iiiii", [cmdId, path, block, slot, modelId]);

/** Clears by visible flow position, not raw bmap block id. */
export const buildClrBlock = (cmdId: number, flow: number, position: number): OutboundRequest =>
  req(cmdId, REQ.ClrBlock, "iii", [cmdId, flow, position]);

export const buildSplitDestinationSet = (
  cmdId: number,
  flow: number,
  position: number,
  linkedFlow: number,
  linkedBlock: number,
): OutboundRequest =>
  req(cmdId, REQ.SplitDestinationSet, "iiiii", [cmdId, flow, position, linkedFlow, linkedBlock]);

export const buildJoinOriginSet = (
  cmdId: number,
  flow: number,
  position: number,
  linkedFlow: number,
  linkedBlock: number,
): OutboundRequest =>
  req(cmdId, REQ.JoinOriginSet, "iiiii", [cmdId, flow, position, linkedFlow, linkedBlock]);

/** Batched actions, e.g. [{ cmnd: "clrb", flow: 0, bloc: 1 }]. */
export interface AgendaCommand {
  cmnd: string;
  flow: number;
  bloc: number;
}

export const buildDoAgenda = (cmdId: number, commands: readonly AgendaCommand[]): OutboundRequest =>
  req(cmdId, REQ.DoAgenda, "ib", [cmdId, encodeMsgpack(commands.map((c) => ({ ...c })))]);

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

export const buildPropertyValueSet = (
  cmdId: number,
  key: string,
  value: string | number | Uint8Array,
  valueType: PropertyValueType = "s",
  propertyId = 0,
): OutboundRequest =>
  req(cmdId, REQ.PropertyValueSet, "iib", [cmdId, propertyId, buildPropertyBlob(key, value, valueType)]);

// ---------------------------------------------------------------------------
// Response classification
// ---------------------------------------------------------------------------

export type DeviceReply =
  | { kind: "status"; cmdId: number; code: number; flag: number | null; message: OscMessage }
  | { kind: "success"; cmdId: number; message: OscMessage }
  | { kind: "error"; cmdId: number; code: number; errorText: string; message: OscMessage }
  | { kind: "reply"; cmdId: number; message: OscMessage }
  | { kind: "push"; message: OscMessage; sequence?: number }
  | { kind: "heartbeat"; message: OscMessage; sequence?: number };

function intArg(msg: OscMessage, index: number): number | null {
  const v = msg.args[index];
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "bigint") return Number(v);
  return null;
}

/**
 * Classify a decoded message from the command socket (2002). Messages whose
 * first argument is a cmdId become status/success/error/reply; anything else
 * is treated as a push (the 2002 stream can carry unsolicited /status too).
 */
export function classifyCommandSocketMessage(message: OscMessage): DeviceReply {
  const cmdId = intArg(message, 0);
  if (cmdId === null) {
    return { kind: "push", message };
  }
  switch (message.address) {
    case RESP.Status: {
      const code = intArg(message, 1) ?? 0;
      const flag = intArg(message, 2);
      return { kind: "status", cmdId, code, flag, message };
    }
    case RESP.Success:
      return { kind: "success", cmdId, message };
    case RESP.Error: {
      const code = intArg(message, 1) ?? 0;
      const text = typeof message.args[2] === "string" ? message.args[2] : "";
      return { kind: "error", cmdId, code, errorText: text, message };
    }
    default:
      return { kind: "reply", cmdId, message };
  }
}

/** Classify a decoded message from the subscribed update socket (2001). */
export function classifyUpdateSocketMessage(message: OscMessage, sequence?: number): DeviceReply {
  if (message.address === "/heartbeat") {
    return sequence !== undefined
      ? { kind: "heartbeat", message, sequence }
      : { kind: "heartbeat", message };
  }
  return sequence !== undefined ? { kind: "push", message, sequence } : { kind: "push", message };
}
