import { describe, expect, it } from "vitest";
import { fromJsonValues, parseAppToBridge, toJsonValues } from "../src/ws-protocol.js";

describe("JSON value round-trips", () => {
  it("round-trips blobs and int64s", () => {
    const original = [1, "x", true, null, new Uint8Array([0, 1, 254, 255]), 9007199254740993n];
    const json = toJsonValues(original);
    expect(json[4]).toHaveProperty("$blob");
    expect(json[5]).toEqual({ $i64: "9007199254740993" });
    const restored = fromJsonValues(json);
    expect(restored[0]).toBe(1);
    expect(Array.from(restored[4] as Uint8Array)).toEqual([0, 1, 254, 255]);
    expect(restored[5]).toBe(9007199254740993n);
    // must survive an actual JSON round-trip
    const rehydrated = fromJsonValues(JSON.parse(JSON.stringify(json)));
    expect(Array.from(rehydrated[4] as Uint8Array)).toEqual([0, 1, 254, 255]);
  });
});

describe("parseAppToBridge validation", () => {
  it("accepts a well-formed request (args exclude the cmdId)", () => {
    const parsed = parseAppToBridge(
      JSON.stringify({
        type: "request",
        requestId: "r1",
        address: "/SnapshotCountGet",
        typeTags: "i",
        args: [],
      }),
    );
    expect(parsed).toMatchObject({ type: "request", requestId: "r1" });
  });

  it("rejects malformed arg contents that would throw deep in the pipeline", () => {
    const base = { type: "request", requestId: "r", address: "/PropertyValueGet" };
    // non-numeric $i64 (would throw in BigInt())
    expect(parseAppToBridge(JSON.stringify({ ...base, typeTags: "is", args: [{ $i64: "x" }] }))).toBeNull();
    // invalid base64 $blob (would throw in atob())
    expect(parseAppToBridge(JSON.stringify({ ...base, typeTags: "ib", args: [{ $blob: "@@@" }] }))).toBeNull();
    // arity mismatch (would throw in encodeOsc)
    expect(parseAppToBridge(JSON.stringify({ ...base, typeTags: "is", args: [] }))).toBeNull();
    expect(parseAppToBridge(JSON.stringify({ ...base, typeTags: "i", args: ["extra"] }))).toBeNull();
    // unknown tag characters
    expect(parseAppToBridge(JSON.stringify({ ...base, typeTags: "iq", args: [1] }))).toBeNull();
    // typeTags must start with the cmdId's i
    expect(parseAppToBridge(JSON.stringify({ ...base, typeTags: "si", args: ["x"] }))).toBeNull();
    // arbitrary objects are not valid values
    expect(parseAppToBridge(JSON.stringify({ ...base, typeTags: "is", args: [{ evil: 1 }] }))).toBeNull();
    // valid shapes still pass
    expect(
      parseAppToBridge(JSON.stringify({ ...base, typeTags: "is", args: ["server.active.preset.id"] })),
    ).not.toBeNull();
    expect(
      parseAppToBridge(JSON.stringify({ ...base, typeTags: "iihb", args: [1, { $i64: "-9" }, { $blob: "AQI=" }] })),
    ).not.toBeNull();
  });

  it("rejects malformed JSON, unknown types, and bad addresses", () => {
    expect(parseAppToBridge("{nope")).toBeNull();
    expect(parseAppToBridge(JSON.stringify({ type: "hack" }))).toBeNull();
    expect(
      parseAppToBridge(
        JSON.stringify({ type: "request", requestId: "r", address: "no-slash", typeTags: "", args: [] }),
      ),
    ).toBeNull();
    expect(parseAppToBridge(JSON.stringify({ type: "setReadOnly", readOnly: "yes" }))).toBeNull();
    expect(parseAppToBridge(JSON.stringify({ type: "ping", t: 5 }))).toMatchObject({ type: "ping" });
  });
});
