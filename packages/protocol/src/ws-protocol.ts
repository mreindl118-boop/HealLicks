/**
 * The bridge <-> app WebSocket protocol: typed JSON envelopes relaying the
 * Stadium link. Shared by the bridge (Node) and the PWA (browser), so this
 * module must stay runtime-neutral.
 *
 * OSC arguments are not all JSON-safe; toJsonValues()/fromJsonValues()
 * round-trip blobs as { $blob: base64 } and int64s as { $i64: decimal string }.
 */

import type { OscValue } from "./osc.js";
import type { ConnectionState } from "./state-machine.js";
import type { DeviceInfo } from "./firmware.js";

export type JsonOscValue =
  | number
  | string
  | boolean
  | null
  | { $blob: string }
  | { $i64: string };

export interface JsonOscMessage {
  address: string;
  typeTags: string;
  args: JsonOscValue[];
}

// ---------------------------------------------------------------------------
// Bridge -> app
// ---------------------------------------------------------------------------

export interface StadiumStatusPayload {
  state: ConnectionState;
  device: DeviceInfoJson | null;
  host: string | null;
  /** Human-readable reason for the most recent offline/degraded transition. */
  reason: string | null;
}

export interface DeviceInfoJson {
  model: string | null;
  firmwareVersion: string | null;
  compatibility: "validated" | "unknown" | "untested-firmware";
  warnings: string[];
}

export type BridgeToApp =
  | {
      type: "hello";
      bridgeVersion: string;
      protocolVersion: number;
      readOnly: boolean;
      stadium: StadiumStatusPayload;
    }
  | { type: "stadiumStatus"; stadium: StadiumStatusPayload }
  | { type: "readOnlyChanged"; readOnly: boolean }
  | { type: "deviceEvent"; source: "update" | "command"; message: JsonOscMessage; sequence?: number }
  | {
      type: "response";
      requestId: string;
      ok: boolean;
      reply: JsonOscMessage | null;
      failure?: "timeout" | "error" | "status" | "aborted" | "readOnly" | "offline" | "rateLimited";
      detail?: string;
    }
  | { type: "pong"; t: number }
  | { type: "bridgeError"; detail: string };

// ---------------------------------------------------------------------------
// App -> bridge
// ---------------------------------------------------------------------------

export type AppToBridge =
  | {
      /**
       * Send a control request to the Stadium. Refused while read-only.
       * `args` EXCLUDES the leading cmdId (the bridge allocates it), while
       * `typeTags` still includes its leading `i`.
       */
      type: "request";
      requestId: string;
      address: string;
      typeTags: string;
      args: JsonOscValue[];
      /** Optional expected reply address for queries. */
      expectAddress?: string;
      timeoutMs?: number;
    }
  | { type: "setReadOnly"; readOnly: boolean }
  | { type: "resync" }
  | { type: "ping"; t: number };

export const WS_PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// Value conversion
// ---------------------------------------------------------------------------

function bytesToBase64(bytes: Uint8Array): string {
  // btoa exists in browsers and Node >= 16; build the binary string in chunks.
  let binary = "";
  const chunk = 0x2000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function toJsonValue(value: OscValue): JsonOscValue {
  if (value instanceof Uint8Array) return { $blob: bytesToBase64(value) };
  if (typeof value === "bigint") return { $i64: value.toString() };
  return value;
}

export function fromJsonValue(value: JsonOscValue): OscValue {
  if (value !== null && typeof value === "object") {
    if ("$blob" in value) return base64ToBytes(value.$blob);
    if ("$i64" in value) return BigInt(value.$i64);
  }
  return value as OscValue;
}

export function toJsonValues(values: readonly OscValue[]): JsonOscValue[] {
  return values.map(toJsonValue);
}

export function fromJsonValues(values: readonly JsonOscValue[]): OscValue[] {
  return values.map(fromJsonValue);
}

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const TYPE_TAGS_RE = /^i[ihfsbTF]*$/;

function isValidJsonOscValue(value: unknown): value is JsonOscValue {
  if (value === null || typeof value === "number" || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if ("$blob" in record) {
    return typeof record["$blob"] === "string" && BASE64_RE.test(record["$blob"]);
  }
  if ("$i64" in record) {
    return typeof record["$i64"] === "string" && /^-?\d+$/.test(record["$i64"]);
  }
  return false;
}

export function parseAppToBridge(raw: string): AppToBridge | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || typeof (parsed as { type?: unknown }).type !== "string") {
    return null;
  }
  const msg = parsed as AppToBridge;
  switch (msg.type) {
    case "request":
      if (
        typeof msg.requestId !== "string" ||
        typeof msg.address !== "string" ||
        !msg.address.startsWith("/") ||
        typeof msg.typeTags !== "string" ||
        // Leading `i` is the bridge-allocated cmdId; only known tags allowed.
        !TYPE_TAGS_RE.test(msg.typeTags) ||
        !Array.isArray(msg.args) ||
        // Every tag consumes one arg slot; args exclude the cmdId.
        msg.args.length !== msg.typeTags.length - 1 ||
        !msg.args.every(isValidJsonOscValue) ||
        (msg.expectAddress !== undefined && typeof msg.expectAddress !== "string") ||
        (msg.timeoutMs !== undefined && typeof msg.timeoutMs !== "number")
      ) {
        return null;
      }
      return msg;
    case "setReadOnly":
      return typeof msg.readOnly === "boolean" ? msg : null;
    case "resync":
      return msg;
    case "ping":
      return typeof msg.t === "number" ? msg : null;
    default:
      return null;
  }
}
