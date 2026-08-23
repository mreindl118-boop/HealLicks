/**
 * Request/response correlation for the command socket (port 2002).
 *
 * The device echoes the client-chosen cmdId as the first argument of every
 * correlated reply. A request resolves on:
 *   - its address-specific reply (`expectAddress`),
 *   - a generic `/status` / `/success` ack, or
 *   - `/error` (resolved as a failure, not thrown — callers decide).
 * Requests time out via a caller-driven clock so the correlator stays pure
 * and testable (no real timers inside).
 */

import type { DeviceReply, OutboundRequest } from "./messages.js";

function addressMatches(
  address: string,
  expected: string,
  mode: OutboundRequest["expectMatch"],
): boolean {
  if (mode === "contains-insensitive") {
    return address.toLowerCase().includes(expected.toLowerCase().replace(/^\//, ""));
  }
  return address === expected;
}

export interface CorrelatedResult {
  ok: boolean;
  reply: DeviceReply | null;
  /** Set when ok=false: "timeout" | "error" | "status" | "aborted". */
  failure?: "timeout" | "error" | "status" | "aborted";
  detail?: string;
}

interface Pending {
  request: OutboundRequest;
  expiresAt: number;
  resolve: (result: CorrelatedResult) => void;
}

export interface CorrelatorOptions {
  /** Treat a /status reply with a non-zero code as a failure. Default true. */
  strictStatus?: boolean;
}

export class RequestCorrelator {
  private pending = new Map<number, Pending>();
  private readonly strictStatus: boolean;

  constructor(options: CorrelatorOptions = {}) {
    this.strictStatus = options.strictStatus ?? true;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Track an in-flight request. Returns a promise that settles when a
   * correlated reply arrives, the deadline passes (via expire()), or abort().
   */
  track(request: OutboundRequest, expiresAt: number): Promise<CorrelatedResult> {
    return new Promise((resolve) => {
      const existing = this.pending.get(request.cmdId);
      if (existing) {
        existing.resolve({ ok: false, reply: null, failure: "aborted", detail: "cmdId reused" });
      }
      this.pending.set(request.cmdId, { request, expiresAt, resolve });
    });
  }

  /**
   * Feed a classified inbound message. Returns true when it settled a pending
   * request, false when it should be handled as an unsolicited message.
   */
  handleReply(reply: DeviceReply): boolean {
    if (reply.kind === "push" || reply.kind === "heartbeat") return false;
    const pending = this.pending.get(reply.cmdId);
    if (!pending) return false;

    const expected = pending.request.expectAddress;
    if (expected !== undefined) {
      // A query waits for its address-specific reply; interim /status or
      // /success acks for the same cmdId must not settle it (only /error does).
      if (reply.kind === "status" || reply.kind === "success") return false;
      if (reply.kind === "reply" && !addressMatches(reply.message.address, expected, pending.request.expectMatch)) {
        return false;
      }
    }

    this.pending.delete(reply.cmdId);
    if (reply.kind === "error") {
      pending.resolve({ ok: false, reply, failure: "error", detail: reply.errorText });
    } else if (reply.kind === "status" && this.strictStatus && reply.code !== 0) {
      pending.resolve({ ok: false, reply, failure: "status", detail: `status code ${reply.code}` });
    } else {
      pending.resolve({ ok: true, reply });
    }
    return true;
  }

  /** Expire requests whose deadline has passed. Call on a timer with the current time. */
  expire(now: number): number {
    let expired = 0;
    for (const [cmdId, pending] of this.pending) {
      if (now >= pending.expiresAt) {
        this.pending.delete(cmdId);
        pending.resolve({
          ok: false,
          reply: null,
          failure: "timeout",
          detail: `timed out waiting for reply to ${pending.request.address} (cmdId=${cmdId})`,
        });
        expired += 1;
      }
    }
    return expired;
  }

  /** Fail all in-flight requests (connection dropped). */
  abortAll(detail = "connection closed"): void {
    for (const [cmdId, pending] of this.pending) {
      this.pending.delete(cmdId);
      pending.resolve({ ok: false, reply: null, failure: "aborted", detail });
    }
  }
}

/** Monotonic cmdId allocator starting at 1, mirroring the editor's behaviour. */
export class CmdIdAllocator {
  private next = 1;

  allocate(): number {
    const id = this.next;
    this.next += 1;
    if (this.next > 0x7fffffff) this.next = 1;
    return id;
  }
}
