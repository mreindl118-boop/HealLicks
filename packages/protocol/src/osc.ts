/**
 * OSC codec for Helix Stadium traffic.
 *
 * The Stadium speaks standard OSC 1.0 message layout (big-endian, 4-byte
 * aligned): padded address string, padded ",<typetags>" string, then typed
 * arguments. Observed type tags: i (int32), h (int64), f (float32),
 * s (string), b (blob), T/F (booleans, no payload).
 *
 * Ported from helix-stadium-tools `helix/osc.py` (MIT, Dwayne Charrington).
 * Decoding is deliberately lenient, matching the reference implementation:
 * truncated arguments decode to null and stop the scan, because live captures
 * contain partial frames and we prefer a partial decode over a hard failure.
 */

export type OscValue = number | bigint | string | Uint8Array | boolean | null;

export interface OscMessage {
  address: string;
  /** Type tags WITHOUT the leading comma, e.g. "iis". */
  typeTags: string;
  args: OscValue[];
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: false });

export function pad4(data: Uint8Array): Uint8Array {
  const rem = data.length % 4;
  if (rem === 0) return data;
  const out = new Uint8Array(data.length + (4 - rem));
  out.set(data);
  return out;
}

function paddedString(text: string): Uint8Array {
  const raw = encoder.encode(text);
  const withNul = new Uint8Array(raw.length + 1);
  withNul.set(raw);
  return pad4(withNul);
}

export function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/**
 * Encode an OSC message. `typeTags` excludes the leading comma.
 * Throws on malformed input (unknown tag, arg/tag mismatch, bad address).
 */
export function encodeOsc(address: string, typeTags: string, args: readonly OscValue[]): Uint8Array {
  if (!address.startsWith("/")) {
    throw new Error(`OSC address must start with '/': ${address}`);
  }
  const parts: Uint8Array[] = [paddedString(address), paddedString("," + typeTags)];
  let argIndex = 0;
  for (const tag of typeTags) {
    if (tag === "T" || tag === "F") {
      // Booleans carry their value in the tag and emit no bytes, but they DO
      // consume an argument slot (reference codec zips tags with args), so
      // interleaved booleans keep later args aligned.
      argIndex++;
      continue;
    }
    const arg = args[argIndex++];
    if (arg === undefined) {
      throw new Error(`missing argument for type tag '${tag}' in ${address}`);
    }
    switch (tag) {
      case "i": {
        const buf = new Uint8Array(4);
        new DataView(buf.buffer).setInt32(0, Number(arg) | 0, false);
        parts.push(buf);
        break;
      }
      case "h": {
        const buf = new Uint8Array(8);
        new DataView(buf.buffer).setBigInt64(0, BigInt(arg as number | bigint), false);
        parts.push(buf);
        break;
      }
      case "f": {
        const buf = new Uint8Array(4);
        new DataView(buf.buffer).setFloat32(0, Number(arg), false);
        parts.push(buf);
        break;
      }
      case "s": {
        parts.push(paddedString(String(arg)));
        break;
      }
      case "b": {
        if (!(arg instanceof Uint8Array)) {
          throw new Error(`blob argument for ${address} must be a Uint8Array`);
        }
        const len = new Uint8Array(4);
        new DataView(len.buffer).setUint32(0, arg.length, false);
        parts.push(len, pad4(arg));
        break;
      }
      default:
        throw new Error(`unsupported type tag '${tag}' in ${address}`);
    }
  }
  return concatBytes(parts);
}

export function encodeOscMessage(msg: OscMessage): Uint8Array {
  return encodeOsc(msg.address, msg.typeTags, msg.args);
}

function align4(idx: number): number {
  return idx + ((4 - (idx % 4)) % 4);
}

/**
 * Decode an OSC message. Returns null when no address can be read.
 * Truncated arguments decode as null (and stop the arg scan), matching the
 * reference Python decoder's tolerance of partial capture data.
 */
export function decodeOsc(msg: Uint8Array): OscMessage | null {
  const addrEnd = msg.indexOf(0);
  if (addrEnd === -1) return null;
  const address = decoder.decode(msg.subarray(0, addrEnd));
  let idx = align4(addrEnd + 1);

  if (idx >= msg.length || msg[idx] !== 0x2c /* ',' */) {
    return { address, typeTags: "", args: [] };
  }
  const ttEnd = msg.indexOf(0, idx);
  if (ttEnd === -1) {
    return { address, typeTags: "", args: [] };
  }
  const typeTags = decoder.decode(msg.subarray(idx + 1, ttEnd));
  idx = align4(ttEnd + 1);

  const view = new DataView(msg.buffer, msg.byteOffset, msg.byteLength);
  const args: OscValue[] = [];
  scan: for (const tag of typeTags) {
    switch (tag) {
      case "i": {
        if (idx + 4 > msg.length) {
          args.push(null);
          break scan;
        }
        args.push(view.getInt32(idx, false));
        idx += 4;
        break;
      }
      case "h": {
        if (idx + 8 > msg.length) {
          args.push(null);
          break scan;
        }
        args.push(view.getBigInt64(idx, false));
        idx += 8;
        break;
      }
      case "f": {
        if (idx + 4 > msg.length) {
          args.push(null);
          break scan;
        }
        args.push(view.getFloat32(idx, false));
        idx += 4;
        break;
      }
      case "s": {
        const end = msg.indexOf(0, idx);
        if (end === -1) {
          args.push(null);
          break scan;
        }
        args.push(decoder.decode(msg.subarray(idx, end)));
        idx = align4(end + 1);
        break;
      }
      case "b": {
        if (idx + 4 > msg.length) {
          args.push(null);
          break scan;
        }
        const blen = view.getUint32(idx, false);
        idx += 4;
        if (idx + blen > msg.length) {
          args.push(null);
          break scan;
        }
        args.push(msg.slice(idx, idx + blen));
        idx = align4(idx + blen);
        break;
      }
      case "T": {
        args.push(true);
        break;
      }
      case "F": {
        args.push(false);
        break;
      }
      default: {
        // Unknown tag: assume a 4-byte slot like the reference decoder.
        args.push(null);
        idx += 4;
        break;
      }
    }
  }
  return { address, typeTags, args };
}
