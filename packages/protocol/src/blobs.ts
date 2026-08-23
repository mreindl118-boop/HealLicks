/**
 * msgpack blob helpers for Helix Stadium property payloads.
 *
 * Property values travel as msgpack maps whose keys are FourCC integers
 * ("key_", "type", "val_"), prefixed with the 8-byte ASCII magic "lavppgsm".
 * Device query responses (edit buffer state, content refs, ...) are plain
 * msgpack blobs, sometimes with a small binary prefix — the reference decoder
 * probes offsets 0/4/8/12/16 and we keep that behaviour.
 *
 * Ported from helix-stadium-tools `helix/blobs.py` (MIT, Dwayne Charrington).
 */

import { encode as msgpackEncode, decode as msgpackDecode } from "@msgpack/msgpack";
import { concatBytes } from "./osc.js";

export const PROPERTY_BLOB_MAGIC = "lavppgsm";

/** JSON-ish value tree produced by blob decoding. */
export type BlobValue =
  | null
  | boolean
  | number
  | bigint
  | string
  | Uint8Array
  | BlobValue[]
  | { [key: string]: BlobValue };

export function fourccInt(text: string): number {
  if (text.length !== 4) throw new Error("fourcc must be 4 chars");
  const bytes = new TextEncoder().encode(text);
  if (bytes.length !== 4) throw new Error("fourcc must be 4 ASCII bytes");
  return ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0;
}

export function fourccStr(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    return null;
  }
  const bytes = [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
  if (bytes.every((b) => b >= 32 && b <= 126)) {
    return String.fromCharCode(...bytes);
  }
  return null;
}

function convert(value: unknown): BlobValue {
  if (value === null || value === undefined) return null;
  if (
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return value.map(convert);
  if (value instanceof Map) {
    const out: { [key: string]: BlobValue } = {};
    for (const [k, v] of value.entries()) {
      const key = fourccStr(k) ?? String(k);
      out[key] = convert(v);
    }
    return out;
  }
  if (typeof value === "object") {
    const out: { [key: string]: BlobValue } = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const numeric = Number(k);
      const key = (Number.isInteger(numeric) ? fourccStr(numeric) : null) ?? k;
      out[key] = convert(v);
    }
    return out;
  }
  return null;
}

/**
 * Decode a msgpack blob, probing the small prefix offsets the device uses.
 * Returns null when nothing decodes. FourCC integer map keys are normalised
 * to their ASCII form ("key_", "cid_", ...).
 */
export function decodeMsgpackBlob(blob: Uint8Array): BlobValue | null {
  for (const offset of [0, 4, 8, 12, 16]) {
    if (offset >= blob.length) break;
    try {
      // Integer map keys decode into numeric-string object properties, which
      // convert() then normalises back to their FourCC ASCII form.
      const decoded = msgpackDecode(blob.subarray(offset));
      return convert(decoded);
    } catch {
      continue;
    }
  }
  return null;
}

/** Alias matching the reference tooling's name for property payload decoding. */
export function decodePropertyBlob(blob: Uint8Array): BlobValue | null {
  return decodeMsgpackBlob(blob);
}

export type PropertyValueType = "s" | "i" | "f" | "b" | "v";

function encodeUint32Key(value: number): Uint8Array {
  // msgpack uint32: 0xce + 4 bytes big-endian (FourCC keys always fit).
  const out = new Uint8Array(5);
  out[0] = 0xce;
  new DataView(out.buffer).setUint32(1, value >>> 0, false);
  return out;
}

/**
 * Encode a msgpack map with integer keys. @msgpack/msgpack cannot encode JS
 * Maps (objects stringify their keys), so the map header and keys are written
 * by hand and the values delegated to the library.
 */
export function encodeIntKeyedMap(entries: ReadonlyArray<readonly [number, unknown]>): Uint8Array {
  if (entries.length > 15) {
    throw new Error("encodeIntKeyedMap supports at most 15 entries (fixmap)");
  }
  const parts: Uint8Array[] = [new Uint8Array([0x80 | entries.length])];
  for (const [key, value] of entries) {
    parts.push(encodeUint32Key(key), msgpackEncode(value));
  }
  return concatBytes(parts);
}

/**
 * Build a `/PropertyValueSet` blob: "lavppgsm" + msgpack({key_, type, val_})
 * with FourCC integer keys.
 */
export function buildPropertyBlob(
  key: string,
  value: string | number | Uint8Array,
  valueType: PropertyValueType = "s",
): Uint8Array {
  const packed = encodeIntKeyedMap([
    [fourccInt("key_"), key],
    [fourccInt("type"), valueType],
    [fourccInt("val_"), value],
  ]);
  return concatBytes([new TextEncoder().encode(PROPERTY_BLOB_MAGIC), packed]);
}

/** Encode an arbitrary value as msgpack (content-id lists for container ops, agenda blobs, ...). */
export function encodeMsgpack(value: unknown): Uint8Array {
  return msgpackEncode(value);
}
