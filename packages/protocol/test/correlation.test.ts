import { describe, expect, it } from "vitest";
import { CmdIdAllocator, RequestCorrelator } from "../src/correlation.js";
import {
  buildProductInfoGet,
  buildSetSnapshotName,
  classifyCommandSocketMessage,
} from "../src/messages.js";
import type { OscMessage } from "../src/osc.js";

function msg(address: string, typeTags: string, args: OscMessage["args"]): OscMessage {
  return { address, typeTags, args };
}

describe("CmdIdAllocator", () => {
  it("starts at 1 and increments", () => {
    const alloc = new CmdIdAllocator();
    expect(alloc.allocate()).toBe(1);
    expect(alloc.allocate()).toBe(2);
  });
});

describe("RequestCorrelator", () => {
  it("resolves a mutation on its /status ack", async () => {
    const correlator = new RequestCorrelator();
    const request = buildSetSnapshotName(5, 0, "Verse A");
    const promise = correlator.track(request, 1000);
    const settled = correlator.handleReply(classifyCommandSocketMessage(msg("/status", "iii", [5, 0, 1])));
    expect(settled).toBe(true);
    const result = await promise;
    expect(result.ok).toBe(true);
    expect(result.reply!.kind).toBe("status");
  });

  it("fails a mutation on non-zero /status code under strictStatus", async () => {
    const correlator = new RequestCorrelator();
    const promise = correlator.track(buildSetSnapshotName(6, 0, "X"), 1000);
    correlator.handleReply(classifyCommandSocketMessage(msg("/status", "iii", [6, -4, 1])));
    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.failure).toBe("status");
  });

  it("a query ignores interim /status and resolves on its expected address", async () => {
    const correlator = new RequestCorrelator();
    const promise = correlator.track(buildProductInfoGet(3), 1000);
    // interim ack must NOT settle the query
    const settledByStatus = correlator.handleReply(
      classifyCommandSocketMessage(msg("/status", "iii", [3, 0, 0])),
    );
    expect(settledByStatus).toBe(false);
    const settled = correlator.handleReply(
      classifyCommandSocketMessage(msg("/getProductInfo", "ib", [3, new Uint8Array([0x90])])),
    );
    expect(settled).toBe(true);
    const result = await promise;
    expect(result.ok).toBe(true);
    expect(result.reply!.kind).toBe("reply");
  });

  it("resolves /error as a failure with the device message", async () => {
    const correlator = new RequestCorrelator();
    const promise = correlator.track(buildProductInfoGet(9), 1000);
    correlator.handleReply(
      classifyCommandSocketMessage(msg("/error", "iis", [9, 0, "Msg dispatch failed: /CreateContent is NOT known!!!"])),
    );
    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.failure).toBe("error");
    expect(result.detail).toContain("NOT known");
  });

  it("ignores replies for unknown cmdIds", () => {
    const correlator = new RequestCorrelator();
    const settled = correlator.handleReply(classifyCommandSocketMessage(msg("/status", "iii", [99, 0, 0])));
    expect(settled).toBe(false);
  });

  it("expires overdue requests and leaves fresh ones pending", async () => {
    const correlator = new RequestCorrelator();
    const overdue = correlator.track(buildProductInfoGet(1), 100);
    correlator.track(buildProductInfoGet(2), 5000);
    expect(correlator.expire(200)).toBe(1);
    const result = await overdue;
    expect(result.failure).toBe("timeout");
    expect(correlator.pendingCount).toBe(1);
  });

  it("aborts all in-flight requests on disconnect", async () => {
    const correlator = new RequestCorrelator();
    const p1 = correlator.track(buildProductInfoGet(1), 1000);
    const p2 = correlator.track(buildProductInfoGet(2), 1000);
    correlator.abortAll("link dropped");
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.failure).toBe("aborted");
    expect(r2.detail).toBe("link dropped");
    expect(correlator.pendingCount).toBe(0);
  });

  it("classifies pushes without cmdIds as unhandled", () => {
    const correlator = new RequestCorrelator();
    const reply = classifyCommandSocketMessage(msg("/somePush", "s", ["x"]));
    expect(correlator.handleReply(reply)).toBe(false);
  });
});
