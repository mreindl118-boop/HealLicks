/**
 * The same-origin WebSocket relay between the PWA and the Stadium link.
 *
 * Safety rails live here:
 *   - READ-ONLY mode (default ON) refuses every non-query request.
 *   - Outbound control messages are rate-limited with a token bucket.
 *   - Preset-modifying requests trigger a local state snapshot first.
 */

import type { IncomingMessage } from "node:http";
import type { Server as HttpServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import {
  REQ,
  WS_PROTOCOL_VERSION,
  fromJsonValues,
  parseAppToBridge,
  toJsonValues,
  type BridgeToApp,
  type JsonOscMessage,
  type OutboundRequest,
} from "@stadium-deck/protocol";
import type { StadiumLink } from "./stadium-link.js";
import type { StadiumEvent } from "./stadium-client.js";
import type { PresetSnapshotter } from "./snapshots.js";

/** Requests that never mutate device state (allowed in read-only mode). */
const READ_ONLY_SAFE = new Set<string>([
  REQ.ProductInfoGet,
  REQ.EditBufferStateGet,
  REQ.PropertyValueGet,
  REQ.SnapshotCountGet,
  REQ.ActiveSnapshotIndexGet,
  REQ.SnapshotTargetsGet,
  REQ.GetContentRef,
  REQ.GetContainerContents,
  REQ.GetContentData,
  REQ.GetContentPath,
  REQ.GetAllContentInfo,
  REQ.GetContentInfo,
  REQ.FindContentMatches,
]);

/**
 * Requests that modify (or clobber) preset state and deserve a pre-mutation
 * snapshot. Preset loads and snapshot switches are included because they
 * discard unsaved edit-buffer changes; PropertyValueSet covers notes,
 * scribble strips, and globals.
 */
const PRESET_MODIFYING = new Set<string>([
  REQ.ParamValueSet,
  REQ.HarnessParamValueSet,
  REQ.BlockEnableSet,
  REQ.ModelSet,
  REQ.ClrBlock,
  REQ.SplitDestinationSet,
  REQ.JoinOriginSet,
  REQ.DoAgenda,
  REQ.SetSnapshotName,
  REQ.CopySnapshot,
  REQ.SnapshotColorSet,
  REQ.ActivateSnapshot,
  REQ.SavePresetWithCID,
  REQ.LoadPresetWithCID,
  REQ.LoadPresetAtContainerPosition,
  REQ.PropertyValueSet,
  REQ.SetContentAttrs,
  REQ.SetContentData,
  REQ.SetContentPath,
  REQ.SetContentInfo,
  REQ.DeleteContentInfo,
  REQ.AddContentsToContainer,
  REQ.ReorderContainerContent,
  REQ.RemoveContent,
]);

class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly ratePerSecond: number,
    private readonly burst: number,
  ) {
    this.tokens = burst;
    this.lastRefill = Date.now();
  }

  take(): boolean {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.lastRefill) / 1000) * this.ratePerSecond);
    this.lastRefill = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

export interface WsRelayOptions {
  httpServer: HttpServer;
  link: StadiumLink;
  snapshotter: PresetSnapshotter;
  /** Start in read-only mode (safety rail; default true). */
  readOnly?: boolean;
  bridgeVersion: string;
  controlRatePerSecond?: number;
  controlBurst?: number;
  log?: (message: string) => void;
}

export class WsRelay {
  private readonly wss: WebSocketServer;
  private readonly options: WsRelayOptions;
  private readonly bucket: TokenBucket;
  readOnly: boolean;

  constructor(options: WsRelayOptions) {
    this.options = options;
    this.readOnly = options.readOnly ?? true;
    this.bucket = new TokenBucket(options.controlRatePerSecond ?? 25, options.controlBurst ?? 50);
    this.wss = new WebSocketServer({ server: options.httpServer, path: "/ws" });
    this.wss.on("connection", (socket, request) => this.onConnection(socket, request));
  }

  get clientCount(): number {
    return this.wss.clients.size;
  }

  broadcast(message: BridgeToApp): void {
    const raw = JSON.stringify(message);
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(raw);
    }
  }

  broadcastStatus(): void {
    this.broadcast({ type: "stadiumStatus", stadium: this.options.link.status() });
  }

  broadcastEvent(event: StadiumEvent): void {
    if (event.reply.kind === "heartbeat") return; // apps track liveness via status
    const message: JsonOscMessage = {
      address: event.reply.message.address,
      typeTags: event.reply.message.typeTags,
      args: toJsonValues(event.reply.message.args),
    };
    const payload: BridgeToApp =
      "sequence" in event.reply && event.reply.sequence !== undefined
        ? { type: "deviceEvent", source: event.source, message, sequence: event.reply.sequence }
        : { type: "deviceEvent", source: event.source, message };
    this.broadcast(payload);
  }

  private send(socket: WebSocket, message: BridgeToApp): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }

  private onConnection(socket: WebSocket, request: IncomingMessage): void {
    this.options.log?.(`ws: client connected (${request.socket.remoteAddress ?? "?"}), total ${this.clientCount}`);
    this.send(socket, {
      type: "hello",
      bridgeVersion: this.options.bridgeVersion,
      protocolVersion: WS_PROTOCOL_VERSION,
      readOnly: this.readOnly,
      stadium: this.options.link.status(),
    });

    socket.on("message", (data) => {
      // Error boundary: a throw anywhere in the request pipeline (bad blob
      // base64, tag/arg mismatch reaching encodeOsc, ...) must never become
      // an unhandled rejection that kills the daemon.
      this.onMessage(socket, typeof data === "string" ? data : data.toString()).catch((error) => {
        this.options.log?.(`ws: request failed: ${error instanceof Error ? error.message : error}`);
        this.send(socket, {
          type: "bridgeError",
          detail: `invalid request: ${error instanceof Error ? error.message : String(error)}`,
        });
      });
    });
    socket.on("close", () => {
      this.options.log?.(`ws: client disconnected, total ${this.clientCount}`);
    });
    socket.on("error", () => socket.close());
  }

  private async onMessage(socket: WebSocket, raw: string): Promise<void> {
    const message = parseAppToBridge(raw);
    if (message === null) {
      this.send(socket, { type: "bridgeError", detail: "unparseable message" });
      return;
    }
    switch (message.type) {
      case "ping":
        this.send(socket, { type: "pong", t: message.t });
        return;
      case "resync":
        this.send(socket, { type: "stadiumStatus", stadium: this.options.link.status() });
        return;
      case "setReadOnly":
        this.readOnly = message.readOnly;
        this.options.log?.(`ws: read-only mode ${this.readOnly ? "ENABLED" : "DISABLED"}`);
        this.broadcast({ type: "readOnlyChanged", readOnly: this.readOnly });
        return;
      case "request":
        await this.onRequest(socket, message);
        return;
    }
  }

  private async onRequest(
    socket: WebSocket,
    message: Extract<ReturnType<typeof parseAppToBridge>, { type: "request" }> & object,
  ): Promise<void> {
    const fail = (
      failure: "readOnly" | "offline" | "rateLimited",
      detail: string,
    ): void =>
      this.send(socket, { type: "response", requestId: message.requestId, ok: false, reply: null, failure, detail });

    const isQuery = READ_ONLY_SAFE.has(message.address);
    if (this.readOnly && !isQuery) {
      fail("readOnly", `read-only mode is on; refusing ${message.address}`);
      return;
    }
    if (!isQuery && !this.bucket.take()) {
      fail("rateLimited", "control message rate limit exceeded");
      return;
    }
    if (PRESET_MODIFYING.has(message.address)) {
      await this.options.snapshotter.snapshotBeforeMutation(this.options.link, message.address);
    }

    // The app sends args WITHOUT the cmdId (typeTags still include its leading
    // `i`); the bridge allocates the cmdId so ids stay unique across clients.
    const args = fromJsonValues(message.args);
    const result = await this.options.link.request((cmdId: number): OutboundRequest => {
      const base = {
        address: message.address,
        typeTags: message.typeTags,
        args: [cmdId, ...args],
        cmdId,
      };
      return message.expectAddress !== undefined ? { ...base, expectAddress: message.expectAddress } : base;
    }, message.timeoutMs);

    if (!result.ok) {
      this.send(socket, {
        type: "response",
        requestId: message.requestId,
        ok: false,
        reply:
          result.reply === null
            ? null
            : {
                address: result.reply.message.address,
                typeTags: result.reply.message.typeTags,
                args: toJsonValues(result.reply.message.args),
              },
        failure: result.failure ?? "aborted",
        detail: result.detail ?? "request failed",
      });
      return;
    }
    this.send(socket, {
      type: "response",
      requestId: message.requestId,
      ok: true,
      reply:
        result.reply === null
          ? null
          : {
              address: result.reply.message.address,
              typeTags: result.reply.message.typeTags,
              args: toJsonValues(result.reply.message.args),
            },
    });
  }

  close(): void {
    this.wss.close();
  }
}
