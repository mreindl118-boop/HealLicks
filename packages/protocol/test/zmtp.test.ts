import { describe, expect, it } from "vitest";
import {
  SUBSCRIBE_ALL,
  ZMTP_CLIENT_GREETING,
  ZMTP_FLAG_COMMAND,
  ZMTP_FLAG_MORE,
  ZmtpFrameParser,
  encodeFrame,
  encodeReadyPayload,
  parseCommandPayload,
  validateGreeting,
} from "../src/zmtp.js";

function hex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

describe("greeting", () => {
  it("matches the observed 64-byte client greeting byte-for-byte", () => {
    const observed =
      "ff00000000000000017f03004e554c4c" +
      "00000000000000000000000000000000" +
      "00000000000000000000000000000000" +
      "00000000000000000000000000000000";
    expect(hex(ZMTP_CLIENT_GREETING)).toBe(observed);
  });

  it("validates its own greeting and rejects garbage", () => {
    expect(validateGreeting(ZMTP_CLIENT_GREETING).ok).toBe(true);
    expect(validateGreeting(new Uint8Array(64)).ok).toBe(false);
    expect(validateGreeting(new Uint8Array(10)).ok).toBe(false);
  });
});

describe("frame encoding", () => {
  it("encodes short frames as flags + 1-byte length", () => {
    const frame = encodeFrame(new Uint8Array([0xaa, 0xbb]), 0x00);
    expect(hex(frame)).toBe("0002aabb");
  });

  it("encodes 255-byte payloads as short and 256-byte as long", () => {
    const short = encodeFrame(new Uint8Array(255));
    expect(short[0]).toBe(0x00);
    expect(short[1]).toBe(255);
    const long = encodeFrame(new Uint8Array(256));
    expect(long[0]! & 0x02).toBe(0x02);
    expect(hex(long.subarray(1, 9))).toBe("0000000000000100");
  });

  it("preserves flags on long frames", () => {
    const frame = encodeFrame(new Uint8Array(300), ZMTP_FLAG_COMMAND);
    expect(frame[0]).toBe(ZMTP_FLAG_COMMAND | 0x02);
  });
});

describe("ZmtpFrameParser", () => {
  it("parses frames split across arbitrary TCP segment boundaries", () => {
    const payloadA = new Uint8Array([1, 2, 3]);
    const payloadB = new Uint8Array(300).fill(7);
    const wire = new Uint8Array([...encodeFrame(payloadA, ZMTP_FLAG_MORE), ...encodeFrame(payloadB)]);

    for (let split = 1; split < wire.length; split += 17) {
      const parser = new ZmtpFrameParser();
      const frames = [...parser.feed(wire.subarray(0, split)), ...parser.feed(wire.subarray(split))];
      expect(frames).toHaveLength(2);
      expect(frames[0]!.flags).toBe(ZMTP_FLAG_MORE);
      expect(Array.from(frames[0]!.payload)).toEqual([1, 2, 3]);
      expect(frames[1]!.payload.length).toBe(300);
      expect(parser.pendingBytes).toBe(0);
    }
  });

  it("parses many frames packed into one segment", () => {
    const wire = new Uint8Array([
      ...encodeFrame(new Uint8Array([1])),
      ...encodeFrame(new Uint8Array([2])),
      ...encodeFrame(new Uint8Array([3])),
    ]);
    const frames = new ZmtpFrameParser().feed(wire);
    expect(frames.map((f) => f.payload[0])).toEqual([1, 2, 3]);
  });

  it("byte-by-byte feeding still yields correct frames", () => {
    const wire = encodeFrame(new Uint8Array([9, 8, 7]), 0x00);
    const parser = new ZmtpFrameParser();
    const frames: ReturnType<ZmtpFrameParser["feed"]> = [];
    for (const byte of wire) frames.push(...parser.feed(new Uint8Array([byte])));
    expect(frames).toHaveLength(1);
    expect(Array.from(frames[0]!.payload)).toEqual([9, 8, 7]);
  });
});

describe("READY command", () => {
  it("builds the DEALER READY with empty Identity like the editor", () => {
    const payload = encodeReadyPayload("DEALER", new Uint8Array(0));
    const parsed = parseCommandPayload(payload);
    expect(parsed!.name).toBe("READY");
    expect(new TextDecoder().decode(parsed!.properties.get("Socket-Type"))).toBe("DEALER");
    expect(parsed!.properties.get("Identity")!.length).toBe(0);
  });

  it("builds the SUB READY without Identity", () => {
    const payload = encodeReadyPayload("SUB");
    const parsed = parseCommandPayload(payload);
    expect(new TextDecoder().decode(parsed!.properties.get("Socket-Type"))).toBe("SUB");
    expect(parsed!.properties.has("Identity")).toBe(false);
  });

  it("subscribe-all is the observed single 0x01 byte", () => {
    expect(hex(SUBSCRIBE_ALL)).toBe("01");
  });

  it("round-trips through frame encode + parse as a command frame", () => {
    const ready = encodeReadyPayload("SUB");
    const parser = new ZmtpFrameParser();
    const frames = parser.feed(encodeFrame(ready, ZMTP_FLAG_COMMAND));
    expect(frames).toHaveLength(1);
    expect(frames[0]!.flags & ZMTP_FLAG_COMMAND).toBe(ZMTP_FLAG_COMMAND);
    expect(parseCommandPayload(frames[0]!.payload)!.name).toBe("READY");
  });
});
