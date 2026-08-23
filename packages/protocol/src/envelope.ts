/**
 * The 12-byte Helix envelope used on the device->editor stream (port 2001).
 *
 * Layout (all big-endian):
 *   u16 version   — observed 0x0108
 *   6 bytes       — reserved (zero)
 *   u16 sequence
 *   u16 length    — byte length of the OSC message that follows
 *
 * Several wrapped messages may be concatenated inside a single ZMTP data
 * frame. Port 2002 payloads are raw OSC with no envelope, and the 2001 stream
 * has ALSO been observed carrying raw OSC, so decodeOscPayloads() handles
 * both forms — mirroring `decode_osc_payloads` in the reference tooling.
 */

import { decodeOsc, type OscMessage, concatBytes } from "./osc.js";

export const HELIX_ENVELOPE_VERSION = 0x0108;
export const HELIX_ENVELOPE_SIZE = 12;

export interface EnvelopedOsc {
  sequence: number;
  message: OscMessage;
}

/** Decode a run of 0x0108-wrapped OSC messages. Stops at the first non-conforming bytes. */
export function decodeEnvelopes(payload: Uint8Array): EnvelopedOsc[] {
  const events: EnvelopedOsc[] = [];
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  let offset = 0;
  while (offset + HELIX_ENVELOPE_SIZE <= payload.length) {
    const version = view.getUint16(offset, false);
    const sequence = view.getUint16(offset + 8, false);
    const msgLen = view.getUint16(offset + 10, false);
    if (version !== HELIX_ENVELOPE_VERSION || msgLen === 0 || offset + HELIX_ENVELOPE_SIZE + msgLen > payload.length) {
      break;
    }
    const body = payload.subarray(offset + HELIX_ENVELOPE_SIZE, offset + HELIX_ENVELOPE_SIZE + msgLen);
    const message = decodeOsc(body);
    if (message !== null) {
      events.push({ sequence, message });
    }
    offset += HELIX_ENVELOPE_SIZE + msgLen;
  }
  return events;
}

/** Wrap an encoded OSC message in the 12-byte envelope (used by the mock device). */
export function encodeEnvelope(oscBytes: Uint8Array, sequence: number): Uint8Array {
  const header = new Uint8Array(HELIX_ENVELOPE_SIZE);
  const view = new DataView(header.buffer);
  view.setUint16(0, HELIX_ENVELOPE_VERSION, false);
  view.setUint16(8, sequence & 0xffff, false);
  view.setUint16(10, oscBytes.length, false);
  return concatBytes([header, oscBytes]);
}

export interface DecodedPayload {
  message: OscMessage;
  /** Envelope sequence number when the message arrived wrapped; undefined for raw OSC. */
  sequence?: number;
}

/**
 * Decode a ZMTP data-frame payload that may be raw OSC or enveloped OSC.
 * Returns [] for empty/undecodable payloads.
 */
export function decodeOscPayloads(payload: Uint8Array): DecodedPayload[] {
  if (payload.length === 0) return [];
  if (payload[0] === 0x2f /* '/' */) {
    const message = decodeOsc(payload);
    return message ? [{ message }] : [];
  }
  const wrapped = decodeEnvelopes(payload);
  if (wrapped.length > 0) {
    return wrapped.map((w) => ({ message: w.message, sequence: w.sequence }));
  }
  const message = decodeOsc(payload);
  return message ? [{ message }] : [];
}
