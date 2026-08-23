import { describe, expect, it } from "vitest";
import {
  buildPropertyBlob,
  decodeMsgpackBlob,
  decodePropertyBlob,
  encodeMsgpack,
  fourccInt,
  fourccStr,
  PROPERTY_BLOB_MAGIC,
} from "../src/blobs.js";

describe("fourcc", () => {
  it("round-trips ASCII fourccs", () => {
    expect(fourccStr(fourccInt("key_"))).toBe("key_");
    expect(fourccStr(fourccInt("val_"))).toBe("val_");
    expect(fourccStr(fourccInt("cid_"))).toBe("cid_");
  });

  it("returns null for non-printable or non-int values", () => {
    expect(fourccStr(0)).toBeNull();
    expect(fourccStr(1.5)).toBeNull();
    expect(fourccStr("abc")).toBeNull();
  });

  it("rejects wrong-length fourcc text", () => {
    expect(() => fourccInt("abcde")).toThrow();
  });
});

describe("property blobs", () => {
  it("prefixes lavppgsm and decodes back with normalised keys", () => {
    const blob = buildPropertyBlob("preset.meta.info", "hello\nworld", "s");
    expect(new TextDecoder().decode(blob.subarray(0, 8))).toBe(PROPERTY_BLOB_MAGIC);
    const decoded = decodePropertyBlob(blob) as Record<string, unknown>;
    expect(decoded).not.toBeNull();
    expect(decoded["key_"]).toBe("preset.meta.info");
    expect(decoded["type"]).toBe("s");
    expect(decoded["val_"]).toBe("hello\nworld");
  });

  it("builds integer-typed properties (auto-cab toggle shape)", () => {
    const blob = buildPropertyBlob("global.modelselect.addcabblock", 1, "i");
    const decoded = decodePropertyBlob(blob) as Record<string, unknown>;
    expect(decoded["key_"]).toBe("global.modelselect.addcabblock");
    expect(decoded["type"]).toBe("i");
    expect(decoded["val_"]).toBe(1);
  });
});

describe("decodeMsgpackBlob offset probing", () => {
  it("decodes plain msgpack at offset 0", () => {
    const decoded = decodeMsgpackBlob(encodeMsgpack([16, 17, 18]));
    expect(decoded).toEqual([16, 17, 18]);
  });

  it("decodes past small binary prefixes", () => {
    const inner = encodeMsgpack({ name: "Setlist 1" });
    const prefixed = new Uint8Array(4 + inner.length);
    prefixed.set([0xde, 0xad, 0xbe, 0xef], 0);
    prefixed.set(inner, 4);
    // 0xde is a valid msgpack map16 header, so offset 0 may parse garbage or
    // fail; the probe ladder must still find a decode. Use an unambiguous prefix:
    const hardPrefix = new Uint8Array(4 + inner.length);
    hardPrefix.set([0xc1, 0xc1, 0xc1, 0xc1], 0); // 0xc1 is never used by msgpack
    hardPrefix.set(inner, 4);
    const decoded = decodeMsgpackBlob(hardPrefix);
    expect(decoded).toEqual({ name: "Setlist 1" });
  });

  it("returns null for undecodable blobs", () => {
    expect(decodeMsgpackBlob(new Uint8Array([0xc1, 0xc1, 0xc1]))).toBeNull();
  });
});
