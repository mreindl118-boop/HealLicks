import { describe, expect, it } from "vitest";
import {
  buildActivateSnapshot,
  buildBlockEnableSet,
  buildDoAgenda,
  buildModelSet,
  buildParamValueSet,
  buildPropertyValueSet,
  buildSetSnapshotName,
  classifyCommandSocketMessage,
  classifyUpdateSocketMessage,
} from "../src/messages.js";
import { decodeMsgpackBlob, decodePropertyBlob } from "../src/blobs.js";
import { decodeOsc, encodeOsc } from "../src/osc.js";
import { HeartbeatMonitor } from "../src/heartbeat.js";

describe("request builders match the documented wire shapes", () => {
  it("float ParamValueSet uses ,iiiiifi with trailing -1", () => {
    const request = buildParamValueSet(7, 0, 3, 2, 0.5);
    expect(request.address).toBe("/ParamValueSet");
    expect(request.typeTags).toBe("iiiiifi");
    expect(request.args).toEqual([7, 0, 3, 0, 2, 0.5, -1]);
  });

  it("integer ParamValueSet switches to ,iiiiiii", () => {
    expect(buildParamValueSet(7, 0, 3, 2, 4).typeTags).toBe("iiiiiii");
  });

  it("ModelSet is ,iiiii [cmdId, path, block, slot, modelId]", () => {
    const request = buildModelSet(3, 0, 5, 12345);
    expect(request.typeTags).toBe("iiiii");
    expect(request.args).toEqual([3, 0, 5, 0, 12345]);
  });

  it("BlockEnableSet encodes booleans as ints", () => {
    expect(buildBlockEnableSet(1, 0, 4, true).args).toEqual([1, 0, 4, 1]);
    expect(buildBlockEnableSet(1, 0, 4, false).args).toEqual([1, 0, 4, 0]);
  });

  it("activateSnapshot is ,iii with trailing 0 and no expectAddress", () => {
    const request = buildActivateSnapshot(4, 2);
    expect(request.typeTags).toBe("iii");
    expect(request.args).toEqual([4, 2, 0]);
    expect(request.expectAddress).toBeUndefined();
  });

  it("SetSnapshotName carries the string name", () => {
    expect(buildSetSnapshotName(2, 1, "Chorus").args).toEqual([2, 1, "Chorus"]);
  });

  it("PropertyValueSet wraps the value in a lavppgsm blob", () => {
    const request = buildPropertyValueSet(8, "preset.meta.info", "note text", "s");
    expect(request.typeTags).toBe("iib");
    const blob = request.args[2] as Uint8Array;
    const decoded = decodePropertyBlob(blob) as Record<string, unknown>;
    expect(decoded["key_"]).toBe("preset.meta.info");
    expect(decoded["val_"]).toBe("note text");
  });

  it("doAgenda packs commands as msgpack", () => {
    const request = buildDoAgenda(5, [{ cmnd: "clrb", flow: 0, bloc: 1 }]);
    const decoded = decodeMsgpackBlob(request.args[1] as Uint8Array);
    expect(decoded).toEqual([{ cmnd: "clrb", flow: 0, bloc: 1 }]);
  });

  it("all builders produce encodable OSC", () => {
    const requests = [
      buildParamValueSet(1, 0, 1, 1, 0.25),
      buildModelSet(2, 0, 1, 99),
      buildDoAgenda(3, [{ cmnd: "clrb", flow: 0, bloc: 2 }]),
      buildPropertyValueSet(4, "k", 1, "i"),
    ];
    for (const request of requests) {
      const decoded = decodeOsc(encodeOsc(request.address, request.typeTags, request.args));
      expect(decoded!.address).toBe(request.address);
    }
  });
});

describe("classification", () => {
  it("classifies /status, /success, /error and replies", () => {
    expect(classifyCommandSocketMessage({ address: "/status", typeTags: "iii", args: [1, 0, 1] })).toMatchObject({
      kind: "status",
      cmdId: 1,
      code: 0,
      flag: 1,
    });
    expect(classifyCommandSocketMessage({ address: "/success", typeTags: "ii", args: [2, 0] })).toMatchObject({
      kind: "success",
      cmdId: 2,
    });
    expect(
      classifyCommandSocketMessage({ address: "/error", typeTags: "iis", args: [3, 0, "boom"] }),
    ).toMatchObject({ kind: "error", cmdId: 3, errorText: "boom" });
    expect(
      classifyCommandSocketMessage({ address: "/getSnapshotCount", typeTags: "ii", args: [4, 8] }),
    ).toMatchObject({ kind: "reply", cmdId: 4 });
  });

  it("update-socket heartbeats classify as heartbeat with sequence", () => {
    const reply = classifyUpdateSocketMessage({ address: "/heartbeat", typeTags: "i", args: [1] }, 77);
    expect(reply).toMatchObject({ kind: "heartbeat", sequence: 77 });
  });

  it("update-socket pushes keep their message", () => {
    const reply = classifyUpdateSocketMessage(
      { address: "/setParamValue", typeTags: "iiiiiif", args: [1, 2, 0, 3, 0, 5, 0.5] },
      3,
    );
    expect(reply.kind).toBe("push");
  });
});

describe("HeartbeatMonitor", () => {
  it("reports ok/stale/dead by silence duration", () => {
    const monitor = new HeartbeatMonitor(0, { staleAfterMs: 100, deadAfterMs: 300 });
    expect(monitor.check(50)).toBe("ok");
    expect(monitor.check(150)).toBe("stale");
    expect(monitor.check(300)).toBe("dead");
    monitor.noteTraffic(290, false);
    expect(monitor.check(310)).toBe("ok");
  });

  it("tracks heartbeat counts separately from generic traffic", () => {
    const monitor = new HeartbeatMonitor(0, { staleAfterMs: 100, deadAfterMs: 300 });
    monitor.noteTraffic(10, true);
    monitor.noteTraffic(20, false);
    monitor.noteTraffic(30, true);
    expect(monitor.stats(40)).toEqual({ silenceMs: 10, heartbeatCount: 2, lastHeartbeatAgoMs: 10 });
  });

  it("rejects nonsensical thresholds", () => {
    expect(() => new HeartbeatMonitor(0, { staleAfterMs: 500, deadAfterMs: 100 })).toThrow();
  });
});
