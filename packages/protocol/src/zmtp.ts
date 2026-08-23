/**
 * ZeroMQ ZMTP 3.0 client framing, as spoken by the Helix Stadium.
 *
 * The Stadium wraps every OSC payload in ZMTP 3.0 frames over TCP. Without a
 * completed ZMTP handshake the device resets the connection. Socket types:
 *   - port 2001 (device -> editor): client SUB, server ROUTER
 *   - port 2002 (editor -> device): client DEALER (empty Identity), server ROUTER
 *
 * This module is pure bytes: greeting constants, frame encode, an incremental
 * frame parser, and READY-command helpers. Actual sockets live in the bridge
 * and mock packages.
 *
 * Ported from helix-stadium-tools `helix/zmtp.py` (MIT, Dwayne Charrington).
 */

import { concatBytes } from "./osc.js";

export const ZMTP_FLAG_MORE = 0x01;
export const ZMTP_FLAG_LONG = 0x02;
export const ZMTP_FLAG_COMMAND = 0x04;

export const ZMTP_GREETING_SIZE = 64;

/**
 * The exact 64-byte NULL-mechanism client greeting observed on the wire:
 * signature ff 00x7 01 7f, version 3.0, mechanism "NULL", as-server 0, filler.
 */
export const ZMTP_CLIENT_GREETING: Uint8Array = buildGreeting();

export function buildGreeting(): Uint8Array {
  const g = new Uint8Array(ZMTP_GREETING_SIZE);
  g[0] = 0xff;
  g[8] = 0x01;
  g[9] = 0x7f;
  g[10] = 0x03; // version major
  g[11] = 0x00; // version minor
  g.set(new TextEncoder().encode("NULL"), 12); // mechanism, zero-padded to 20 bytes
  // byte 32: as-server = 0; rest is filler (zeros)
  return g;
}

/** Minimal validation of a peer greeting; lenient beyond the signature. */
export function validateGreeting(greeting: Uint8Array): { ok: boolean; reason?: string } {
  if (greeting.length < ZMTP_GREETING_SIZE) {
    return { ok: false, reason: `greeting too short: ${greeting.length} bytes` };
  }
  if (greeting[0] !== 0xff || greeting[9] !== 0x7f) {
    return { ok: false, reason: "bad ZMTP signature" };
  }
  if (greeting[10] !== 0x03) {
    return { ok: false, reason: `unexpected ZMTP major version ${greeting[10]}` };
  }
  return { ok: true };
}

export interface ZmtpFrame {
  flags: number;
  payload: Uint8Array;
}

export function isCommandFrame(frame: ZmtpFrame): boolean {
  return (frame.flags & ZMTP_FLAG_COMMAND) !== 0;
}

export function hasMoreFlag(frame: ZmtpFrame): boolean {
  return (frame.flags & ZMTP_FLAG_MORE) !== 0;
}

/** Encode one ZMTP frame: short (<256 bytes) or long (8-byte big-endian length). */
export function encodeFrame(payload: Uint8Array, flags = 0x00): Uint8Array {
  if (payload.length < 256) {
    const out = new Uint8Array(2 + payload.length);
    out[0] = flags;
    out[1] = payload.length;
    out.set(payload, 2);
    return out;
  }
  const out = new Uint8Array(9 + payload.length);
  out[0] = flags | ZMTP_FLAG_LONG;
  const view = new DataView(out.buffer);
  view.setBigUint64(1, BigInt(payload.length), false);
  out.set(payload, 9);
  return out;
}

/**
 * Incremental ZMTP frame parser. Feed raw TCP bytes; it yields complete
 * frames and buffers the remainder. Handles frames split across (or packed
 * within) TCP segments, including long frames.
 */
export class ZmtpFrameParser {
  private buf: Uint8Array = new Uint8Array(0);

  /** Bytes currently buffered but not yet parsed into a frame. */
  get pendingBytes(): number {
    return this.buf.length;
  }

  feed(data: Uint8Array): ZmtpFrame[] {
    this.buf = this.buf.length === 0 ? data.slice() : concatBytes([this.buf, data]);
    const frames: ZmtpFrame[] = [];
    for (;;) {
      const frame = this.tryParseOne();
      if (!frame) break;
      frames.push(frame);
    }
    return frames;
  }

  reset(): void {
    this.buf = new Uint8Array(0);
  }

  private tryParseOne(): ZmtpFrame | null {
    if (this.buf.length < 2) return null;
    const flags = this.buf[0]!;
    if (flags & ZMTP_FLAG_LONG) {
      if (this.buf.length < 9) return null;
      const view = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
      const size64 = view.getBigUint64(1, false);
      if (size64 > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error(`ZMTP long frame too large: ${size64}`);
      }
      const size = Number(size64);
      if (this.buf.length < 9 + size) return null;
      const payload = this.buf.slice(9, 9 + size);
      this.buf = this.buf.slice(9 + size);
      return { flags, payload };
    }
    const size = this.buf[1]!;
    if (this.buf.length < 2 + size) return null;
    const payload = this.buf.slice(2, 2 + size);
    this.buf = this.buf.slice(2 + size);
    return { flags, payload };
  }
}

/** SUB sockets subscribe by sending 0x01 + topic as a data frame; empty topic = all. */
export const SUBSCRIBE_ALL: Uint8Array = new Uint8Array([0x01]);

export type ZmtpSocketType = "DEALER" | "SUB" | "ROUTER" | "PUB";

/**
 * Build a READY command payload: "\x05READY" then metadata properties
 * (1-byte name length + name, 4-byte big-endian value length + value).
 * `identity` may be an empty Uint8Array (the editor sends an empty Identity
 * on its DEALER socket) or undefined to omit the property entirely.
 */
export function encodeReadyPayload(socketType: ZmtpSocketType, identity?: Uint8Array): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const cmd = enc.encode("READY");
  parts.push(new Uint8Array([cmd.length]), cmd);
  parts.push(property("Socket-Type", enc.encode(socketType)));
  if (identity !== undefined) {
    parts.push(property("Identity", identity));
  }
  return concatBytes(parts);

  function property(name: string, value: Uint8Array): Uint8Array {
    const nameBytes = enc.encode(name);
    const head = new Uint8Array(1 + nameBytes.length + 4);
    head[0] = nameBytes.length;
    head.set(nameBytes, 1);
    new DataView(head.buffer).setUint32(1 + nameBytes.length, value.length, false);
    return concatBytes([head, value]);
  }
}

export interface ZmtpCommand {
  name: string;
  properties: Map<string, Uint8Array>;
}

/** Parse a command frame payload (READY etc.) into name + metadata properties. */
export function parseCommandPayload(payload: Uint8Array): ZmtpCommand | null {
  if (payload.length < 1) return null;
  const nameLen = payload[0]!;
  if (payload.length < 1 + nameLen) return null;
  const dec = new TextDecoder();
  const name = dec.decode(payload.subarray(1, 1 + nameLen));
  const properties = new Map<string, Uint8Array>();
  let idx = 1 + nameLen;
  while (idx < payload.length) {
    const propNameLen = payload[idx]!;
    idx += 1;
    if (idx + propNameLen > payload.length) return { name, properties };
    const propName = dec.decode(payload.subarray(idx, idx + propNameLen));
    idx += propNameLen;
    if (idx + 4 > payload.length) return { name, properties };
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const valueLen = view.getUint32(idx, false);
    idx += 4;
    if (idx + valueLen > payload.length) return { name, properties };
    properties.set(propName, payload.slice(idx, idx + valueLen));
    idx += valueLen;
  }
  return { name, properties };
}
