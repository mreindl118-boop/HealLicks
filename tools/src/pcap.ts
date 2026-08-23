/**
 * Minimal pcap -> OSC decoder for Mode A captures.
 *
 * Handles classic pcap files (not pcapng), Ethernet/NULL/RAW link types,
 * IPv4+TCP, and per-direction in-order payload reassembly — enough for a
 * clean LAN capture. Retransmissions of already-seen bytes are dropped;
 * genuine gaps (packet loss) abort that direction with a warning rather than
 * producing silently corrupt frames. ZMTP greetings are skipped, frames are
 * parsed with the shared parser, and payloads decoded as raw or enveloped
 * OSC exactly like the live client.
 */

import { readFileSync } from "node:fs";
import {
  ZmtpFrameParser,
  decodeOscPayloads,
  isCommandFrame,
  hasMoreFlag,
  type OscMessage,
} from "@stadium-deck/protocol";

export interface DecodedPacketMessage {
  timestamp: number;
  direction: "editor->device" | "device->editor";
  port: number;
  sequence: number | null;
  message: OscMessage;
}

interface TcpSegment {
  timestamp: number;
  seq: number;
  payload: Uint8Array;
}

interface FlowKey {
  key: string;
  srcPort: number;
  dstPort: number;
}

const LINKTYPE_NULL = 0;
const LINKTYPE_ETHERNET = 1;
const LINKTYPE_RAW = 101;
const LINKTYPE_LOOP = 108;

export function decodePcap(
  filePath: string,
  ports: readonly number[] = [2001, 2002],
  warn: (message: string) => void = () => {},
): DecodedPacketMessage[] {
  const buf = readFileSync(filePath);
  if (buf.length < 24) throw new Error("file too short to be a pcap");
  const magic = buf.readUInt32LE(0);
  let littleEndian: boolean;
  if (magic === 0xa1b2c3d4 || magic === 0xa1b23c4d) littleEndian = true;
  else if (buf.readUInt32BE(0) === 0xa1b2c3d4 || buf.readUInt32BE(0) === 0xa1b23c4d) littleEndian = false;
  else if (magic === 0x0a0d0d0a) throw new Error("pcapng not supported — capture with tcpdump -w (classic pcap)");
  else throw new Error("not a pcap file (bad magic)");

  const readU32 = (offset: number): number => (littleEndian ? buf.readUInt32LE(offset) : buf.readUInt32BE(offset));
  const linkType = readU32(20);

  // ---- collect TCP segments per flow ----
  const flows = new Map<string, { info: FlowKey; segments: TcpSegment[] }>();
  let offset = 24;
  while (offset + 16 <= buf.length) {
    const tsSec = readU32(offset);
    const tsFrac = readU32(offset + 4);
    const inclLen = readU32(offset + 8);
    offset += 16;
    if (offset + inclLen > buf.length) break;
    const frame = buf.subarray(offset, offset + inclLen);
    offset += inclLen;

    let ipStart: number;
    switch (linkType) {
      case LINKTYPE_ETHERNET: {
        if (frame.length < 14) continue;
        const etherType = frame.readUInt16BE(12);
        if (etherType !== 0x0800) continue; // IPv4 only
        ipStart = 14;
        break;
      }
      case LINKTYPE_NULL:
      case LINKTYPE_LOOP:
        ipStart = 4;
        break;
      case LINKTYPE_RAW:
        ipStart = 0;
        break;
      default:
        throw new Error(`unsupported pcap link type ${linkType}`);
    }
    if (frame.length < ipStart + 20) continue;
    const version = frame[ipStart]! >> 4;
    if (version !== 4) continue;
    const ihl = (frame[ipStart]! & 0x0f) * 4;
    const protocol = frame[ipStart + 9]!;
    if (protocol !== 6) continue; // TCP
    const ipTotal = frame.readUInt16BE(ipStart + 2);
    const src = frame.subarray(ipStart + 12, ipStart + 16).join(".");
    const dst = frame.subarray(ipStart + 16, ipStart + 20).join(".");
    const tcpStart = ipStart + ihl;
    if (frame.length < tcpStart + 20) continue;
    const srcPort = frame.readUInt16BE(tcpStart);
    const dstPort = frame.readUInt16BE(tcpStart + 2);
    if (!ports.includes(srcPort) && !ports.includes(dstPort)) continue;
    const seq = frame.readUInt32BE(tcpStart + 4);
    const dataOffset = ((frame[tcpStart + 12]! >> 4) & 0x0f) * 4;
    const payloadStart = tcpStart + dataOffset;
    const payloadEnd = Math.min(frame.length, ipStart + ipTotal);
    if (payloadEnd <= payloadStart) continue;
    const payload = frame.subarray(payloadStart, payloadEnd);

    const key = `${src}:${srcPort}->${dst}:${dstPort}`;
    let flow = flows.get(key);
    if (!flow) {
      flow = { info: { key, srcPort, dstPort }, segments: [] };
      flows.set(key, flow);
    }
    flow.segments.push({
      timestamp: tsSec + tsFrac / (magic === 0xa1b23c4d ? 1e9 : 1e6),
      seq,
      payload: new Uint8Array(payload),
    });
  }

  // ---- reassemble each flow in order and parse ZMTP+OSC ----
  const decoded: DecodedPacketMessage[] = [];
  for (const flow of flows.values()) {
    const devicePort = ports.includes(flow.info.srcPort) ? flow.info.srcPort : flow.info.dstPort;
    const direction: DecodedPacketMessage["direction"] = ports.includes(flow.info.srcPort)
      ? "device->editor"
      : "editor->device";

    flow.segments.sort((a, b) => a.seq - b.seq || a.timestamp - b.timestamp);
    const parser = new ZmtpFrameParser();
    let expectedSeq: number | null = null;
    let greetingSkipped = 0;
    for (const segment of flow.segments) {
      let payload = segment.payload;
      if (expectedSeq !== null) {
        const delta = (segment.seq - expectedSeq) | 0; // int32 handles wrap
        if (delta < 0) {
          if (-delta >= payload.length) continue; // pure retransmission
          payload = payload.subarray(-delta); // partial overlap
        } else if (delta > 0) {
          warn(`${flow.info.key}: ${delta} bytes lost mid-stream; stopping this direction to avoid corrupt decode`);
          break;
        }
      }
      expectedSeq = (segment.seq + segment.payload.length) >>> 0;

      // Skip the 64-byte ZMTP greeting at stream start (signature 0xff...0x7f).
      if (greetingSkipped < 64 && payload.length > 0 && (greetingSkipped > 0 || payload[0] === 0xff)) {
        const take = Math.min(64 - greetingSkipped, payload.length);
        greetingSkipped += take;
        payload = payload.subarray(take);
        if (payload.length === 0) continue;
      } else if (greetingSkipped === 0) {
        greetingSkipped = 64; // stream captured mid-session; no greeting present
      }

      let frames;
      try {
        frames = parser.feed(payload);
      } catch (error) {
        warn(`${flow.info.key}: frame parse failed (${error instanceof Error ? error.message : error})`);
        break;
      }
      for (const frame of frames) {
        if (isCommandFrame(frame) || hasMoreFlag(frame)) continue;
        for (const item of decodeOscPayloads(frame.payload)) {
          decoded.push({
            timestamp: segment.timestamp,
            direction,
            port: devicePort,
            sequence: item.sequence ?? null,
            message: item.message,
          });
        }
      }
    }
  }
  decoded.sort((a, b) => a.timestamp - b.timestamp);
  return decoded;
}

export function formatArg(value: OscMessage["args"][number]): string {
  if (value instanceof Uint8Array) return `<blob ${value.length}B>`;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return JSON.stringify(value);
  return String(value);
}
