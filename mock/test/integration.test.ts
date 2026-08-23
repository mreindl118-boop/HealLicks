/**
 * End-to-end proof without hardware: a real StadiumClient (the bridge's TCP
 * client) connects to the MockStadium over loopback TCP, performs the full
 * ZMTP handshake on both ports, subscribes, and exchanges queries, mutations,
 * pushes, and heartbeats.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildActivateSnapshot,
  buildActiveSnapshotIndexGet,
  buildGetContainerContents,
  buildParamValueSet,
  buildProductInfoGet,
  buildSetSnapshotName,
  buildSnapshotCountGet,
  decodeMsgpackBlob,
  USER_PRESETS_CID,
  type DeviceReply,
} from "@stadium-deck/protocol";
import { StadiumClient, type StadiumEvent } from "@stadium-deck/bridge/stadium-client";
import { MockStadium } from "../src/server.js";

let mock: MockStadium;
let client: StadiumClient;
let events: StadiumEvent[];

function waitForEvent(
  predicate: (event: StadiumEvent) => boolean,
  timeoutMs = 3000,
): Promise<StadiumEvent> {
  return new Promise((resolve, reject) => {
    const existing = events.find(predicate);
    if (existing) return resolve(existing);
    const started = Date.now();
    const timer = setInterval(() => {
      const found = events.find(predicate);
      if (found) {
        clearInterval(timer);
        resolve(found);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error("timed out waiting for event"));
      }
    }, 10);
  });
}

beforeEach(async () => {
  events = [];
  mock = new MockStadium({ updatePort: 0, commandPort: 0, heartbeatMs: 100 });
  const { updatePort, commandPort } = await mock.start();
  client = await StadiumClient.connect({
    host: "127.0.0.1",
    updatePort,
    commandPort,
    onEvent: (event) => events.push(event),
  });
});

afterEach(async () => {
  client.close();
  await mock.stop();
});

describe("mock <-> client integration", () => {
  it("completes both ZMTP handshakes and answers ProductInfoGet", async () => {
    const result = await client.request(buildProductInfoGet);
    expect(result.ok).toBe(true);
    expect(result.reply!.kind).toBe("reply");
    const reply = result.reply as Extract<DeviceReply, { kind: "reply" }>;
    expect(reply.message.address).toBe("/getProductInfo");
    const decoded = decodeMsgpackBlob(reply.message.args[1] as Uint8Array) as Record<string, unknown>;
    expect(decoded["model"]).toBe("Helix Stadium XL (Mock)");
    expect(decoded["mock"]).toBe(true);
  });

  it("delivers enveloped heartbeats on the subscribed stream", async () => {
    const heartbeat = await waitForEvent((e) => e.source === "update" && e.reply.kind === "heartbeat");
    expect(heartbeat.reply.kind).toBe("heartbeat");
    expect("sequence" in heartbeat.reply && heartbeat.reply.sequence).toBeGreaterThan(0);
    expect(client.heartbeatStats.heartbeatCount).toBeGreaterThan(0);
  });

  it("runs the snapshot query/mutate/push round-trip", async () => {
    const count = await client.request(buildSnapshotCountGet);
    expect(count.ok).toBe(true);
    const countReply = count.reply as Extract<DeviceReply, { kind: "reply" }>;
    expect(countReply.message.args[1]).toBe(8);

    const activate = await client.request((cmdId) => buildActivateSnapshot(cmdId, 3));
    expect(activate.ok).toBe(true);

    // Device pushes /activateSnapshot [session, cmdId, index] on the stream.
    const push = await waitForEvent(
      (e) => e.source === "update" && e.reply.message.address === "/activateSnapshot",
    );
    expect(push.reply.message.args[2]).toBe(3);

    const index = await client.request(buildActiveSnapshotIndexGet);
    const indexReply = index.reply as Extract<DeviceReply, { kind: "reply" }>;
    expect(indexReply.message.args[1]).toBe(3);
  });

  it("renames a snapshot and sees the observed ack + push pattern", async () => {
    const rename = await client.request((cmdId) => buildSetSnapshotName(cmdId, 0, "Verse A"));
    expect(rename.ok).toBe(true);
    expect(rename.reply!.kind).toBe("status");
    const push = await waitForEvent((e) => e.reply.message.address === "/setSnapshotName");
    expect(push.reply.message.args[3]).toBe("Verse A");
    expect(mock.device.snapshots[0]!.name).toBe("Verse A");
  });

  it("sets a parameter and receives /setParamValue with the float value", async () => {
    const result = await client.request((cmdId) => buildParamValueSet(cmdId, 0, 2, 1, 0.42));
    expect(result.ok).toBe(true);
    const push = await waitForEvent((e) => e.reply.message.address === "/setParamValue");
    expect(push.reply.message.args[6] as number).toBeCloseTo(0.42, 5);
    expect(mock.device.blockAt(2)!.params.get(1)).toBeCloseTo(0.42, 5);
  });

  it("browses container contents as msgpack refs", async () => {
    const result = await client.request((cmdId) => buildGetContainerContents(cmdId, USER_PRESETS_CID));
    expect(result.ok).toBe(true);
    const reply = result.reply as Extract<DeviceReply, { kind: "reply" }>;
    const refs = decodeMsgpackBlob(reply.message.args[1] as Uint8Array) as Array<Record<string, unknown>>;
    expect(refs.length).toBeGreaterThan(0);
    expect(refs[0]).toMatchObject({ name: "Couch Riff", posi: 0, type: 2 });
  });

  it("returns the device-style /error for unknown addresses", async () => {
    const result = await client.sendRaw("/CreateContent", "ii", [123]);
    expect(result.ok).toBe(false);
    expect(result.failure).toBe("error");
    expect(result.detail).toContain("NOT known");
  });

  it("handles 50 pipelined requests without cross-talk", async () => {
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        i % 2 === 0
          ? client.request(buildSnapshotCountGet)
          : client.request(buildActiveSnapshotIndexGet),
      ),
    );
    for (const result of results) {
      expect(result.ok).toBe(true);
    }
  });

  it("aborts in-flight requests when the mock dies", async () => {
    const pending = client.request(buildSnapshotCountGet, 5000);
    await mock.stop();
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(["aborted", "timeout"]).toContain(result.failure);
  });
});
