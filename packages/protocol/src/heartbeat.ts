/**
 * Heartbeat monitor for the subscribed device stream (port 2001).
 *
 * The device emits /heartbeat at a steady cadence. We treat ANY traffic on
 * the subscribed stream as proof of life (a busy stream can interleave many
 * pushes between heartbeats). Pure logic, caller-driven clock.
 *
 * The exact hardware cadence still needs confirming in a live capture
 * (Phase 0 wizard, baseline step); the default thresholds are conservative.
 */

export type HeartbeatHealth = "ok" | "stale" | "dead";

export interface HeartbeatOptions {
  /** After this long with no traffic the link is considered stale. */
  staleAfterMs?: number;
  /** After this long with no traffic the link is considered dead (reconnect). */
  deadAfterMs?: number;
}

export class HeartbeatMonitor {
  private lastSeenAt: number;
  private lastHeartbeatAt: number | null = null;
  private heartbeatCount = 0;
  readonly staleAfterMs: number;
  readonly deadAfterMs: number;

  constructor(now: number, options: HeartbeatOptions = {}) {
    this.lastSeenAt = now;
    this.staleAfterMs = options.staleAfterMs ?? 5_000;
    this.deadAfterMs = options.deadAfterMs ?? 15_000;
    if (this.deadAfterMs <= this.staleAfterMs) {
      throw new Error("deadAfterMs must be greater than staleAfterMs");
    }
  }

  /** Record any inbound message on the subscribed stream. */
  noteTraffic(now: number, isHeartbeat: boolean): void {
    this.lastSeenAt = now;
    if (isHeartbeat) {
      this.lastHeartbeatAt = now;
      this.heartbeatCount += 1;
    }
  }

  check(now: number): HeartbeatHealth {
    const silence = now - this.lastSeenAt;
    if (silence >= this.deadAfterMs) return "dead";
    if (silence >= this.staleAfterMs) return "stale";
    return "ok";
  }

  stats(now: number): { silenceMs: number; heartbeatCount: number; lastHeartbeatAgoMs: number | null } {
    return {
      silenceMs: now - this.lastSeenAt,
      heartbeatCount: this.heartbeatCount,
      lastHeartbeatAgoMs: this.lastHeartbeatAt === null ? null : now - this.lastHeartbeatAt,
    };
  }

  reset(now: number): void {
    this.lastSeenAt = now;
    this.lastHeartbeatAt = null;
    this.heartbeatCount = 0;
  }
}
