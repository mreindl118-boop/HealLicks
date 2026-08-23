import { describe, expect, it } from "vitest";
import { decodeOsc, encodeOsc, pad4 } from "../src/osc.js";

function hex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

describe("pad4", () => {
  it("pads to 4-byte boundaries", () => {
    expect(pad4(new Uint8Array([1])).length).toBe(4);
    expect(pad4(new Uint8Array([1, 2, 3, 4])).length).toBe(4);
    expect(pad4(new Uint8Array(0)).length).toBe(0);
    expect(pad4(new Uint8Array([1, 2, 3, 4, 5])).length).toBe(8);
  });
});

describe("encodeOsc", () => {
  it("encodes the documented /ParamValueSet shape byte-exactly", () => {
    // /ParamValueSet ,iiiiifi [cmdId, path, block, slot, paramId, value, -1]
    const msg = encodeOsc("/ParamValueSet", "iiiiifi", [7, 0, 3, 0, 2, 0.5, -1]);
    // Address: "/ParamValueSet" = 14 chars + NUL + pad -> 16 bytes
    expect(msg.length % 4).toBe(0);
    const dec = decodeOsc(msg);
    expect(dec).not.toBeNull();
    expect(dec!.address).toBe("/ParamValueSet");
    expect(dec!.typeTags).toBe("iiiiifi");
    expect(dec!.args.slice(0, 5)).toEqual([7, 0, 3, 0, 2]);
    expect(dec!.args[5]).toBeCloseTo(0.5);
    expect(dec!.args[6]).toBe(-1);
  });

  it("matches the reference encoding for a simple int message", () => {
    // "/a" + NUL + pad = 2f 61 00 00 ; ",i" + NUL + pad = 2c 69 00 00 ; int 1 BE
    const msg = encodeOsc("/a", "i", [1]);
    expect(hex(msg)).toBe("2f6100002c69000000000001");
  });

  it("encodes strings with padding and round-trips them", () => {
    const dec = decodeOsc(encodeOsc("/SetSnapshotName", "iis", [3, 0, "Verse A"]));
    expect(dec!.args).toEqual([3, 0, "Verse A"]);
  });

  it("round-trips blobs with 4-byte alignment", () => {
    const blob = new Uint8Array([1, 2, 3, 4, 5]);
    const msg = encodeOsc("/doAgenda", "ib", [9, blob]);
    expect(msg.length % 4).toBe(0);
    const dec = decodeOsc(msg);
    expect(dec!.args[0]).toBe(9);
    expect(Array.from(dec!.args[1] as Uint8Array)).toEqual([1, 2, 3, 4, 5]);
  });

  it("round-trips int64, booleans, and negative ints", () => {
    const dec = decodeOsc(encodeOsc("/x", "hiTF", [123456789012345n, -42, true, false]));
    expect(dec!.args).toEqual([123456789012345n, -42, true, false]);
  });

  it("interleaved booleans consume arg slots without emitting bytes (reference quirk)", () => {
    // ,iTFi with args [1, true, false, 2] must place 2 (not a coerced boolean)
    // in the final int slot — booleans zip against args in the reference codec.
    const dec = decodeOsc(encodeOsc("/Bool", "iTFi", [1, true, false, 2]));
    expect(dec!.args).toEqual([1, true, false, 2]);
    // Full round-trip: decode -> encode -> decode is stable.
    const again = decodeOsc(encodeOsc("/Bool", dec!.typeTags, dec!.args));
    expect(again!.args).toEqual([1, true, false, 2]);
  });

  it("round-trips a multi-string message (unicode)", () => {
    const dec = decodeOsc(encodeOsc("/FindContentMatches", "iiss", [1, 2, "Lead Töne", ""]));
    expect(dec!.args).toEqual([1, 2, "Lead Töne", ""]);
  });

  it("rejects addresses without a leading slash and unknown tags", () => {
    expect(() => encodeOsc("nope", "i", [1])).toThrow();
    expect(() => encodeOsc("/x", "q", [1])).toThrow();
    expect(() => encodeOsc("/x", "ii", [1])).toThrow();
  });
});

describe("decodeOsc leniency (capture tolerance)", () => {
  it("returns null when there is no address terminator", () => {
    expect(decodeOsc(new Uint8Array([0x2f, 0x61]))).toBeNull();
  });

  it("decodes truncated int args as null and stops", () => {
    const full = encodeOsc("/status", "iii", [5, 0, 1]);
    const truncated = full.subarray(0, full.length - 2);
    const dec = decodeOsc(truncated);
    expect(dec!.address).toBe("/status");
    expect(dec!.args).toEqual([5, 0, null]);
  });

  it("handles a message with no typetag section", () => {
    const dec = decodeOsc(pad4(new Uint8Array([0x2f, 0x61, 0x62, 0])));
    expect(dec!.address).toBe("/ab");
    expect(dec!.typeTags).toBe("");
    expect(dec!.args).toEqual([]);
  });
});
