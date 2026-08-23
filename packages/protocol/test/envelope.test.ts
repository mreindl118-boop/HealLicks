import { describe, expect, it } from "vitest";
import { decodeEnvelopes, decodeOscPayloads, encodeEnvelope, HELIX_ENVELOPE_SIZE } from "../src/envelope.js";
import { concatBytes, encodeOsc } from "../src/osc.js";

describe("Helix 0x0108 envelope", () => {
  it("round-trips a single wrapped message with its sequence number", () => {
    const osc = encodeOsc("/setParamValue", "iiiiiif", [1, 2, 0, 3, 0, 5, 0.75]);
    const wrapped = encodeEnvelope(osc, 42);
    expect(wrapped.length).toBe(HELIX_ENVELOPE_SIZE + osc.length);
    // version 0x0108 big-endian at offset 0
    expect(wrapped[0]).toBe(0x01);
    expect(wrapped[1]).toBe(0x08);
    const events = decodeEnvelopes(wrapped);
    expect(events).toHaveLength(1);
    expect(events[0]!.sequence).toBe(42);
    expect(events[0]!.message.address).toBe("/setParamValue");
  });

  it("decodes multiple concatenated envelopes in one payload", () => {
    const a = encodeEnvelope(encodeOsc("/heartbeat", "i", [1]), 1);
    const b = encodeEnvelope(encodeOsc("/activateSnapshot", "iii", [9, 5, 2]), 2);
    const events = decodeEnvelopes(concatBytes([a, b]));
    expect(events.map((e) => e.message.address)).toEqual(["/heartbeat", "/activateSnapshot"]);
    expect(events.map((e) => e.sequence)).toEqual([1, 2]);
  });

  it("stops at non-conforming bytes without throwing", () => {
    const good = encodeEnvelope(encodeOsc("/heartbeat", "i", [1]), 7);
    const junk = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0, 0, 0, 0, 0, 0, 0, 9]);
    const events = decodeEnvelopes(concatBytes([good, junk]));
    expect(events).toHaveLength(1);
  });
});

describe("decodeOscPayloads dual-form handling", () => {
  it("decodes raw OSC (leading '/')", () => {
    const events = decodeOscPayloads(encodeOsc("/status", "iii", [1, 0, 0]));
    expect(events).toHaveLength(1);
    expect(events[0]!.message.address).toBe("/status");
    expect(events[0]!.sequence).toBeUndefined();
  });

  it("decodes wrapped OSC and reports sequences", () => {
    const events = decodeOscPayloads(encodeEnvelope(encodeOsc("/heartbeat", "i", [3]), 11));
    expect(events).toHaveLength(1);
    expect(events[0]!.sequence).toBe(11);
  });

  it("returns [] for empty payloads", () => {
    expect(decodeOscPayloads(new Uint8Array(0))).toEqual([]);
  });
});
