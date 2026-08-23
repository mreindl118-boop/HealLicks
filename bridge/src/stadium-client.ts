/**
 * Node TCP client for a (real or mock) Helix Stadium.
 *
 * Owns the two sockets and the byte-level lifecycle:
 *   update socket  (2001): ZMTP SUB handshake -> SUBSCRIBE-all -> enveloped pushes
 *   command socket (2002): ZMTP DEALER handshake -> raw OSC request/response
 * Correlation, classification, and heartbeat logic come from
 * @stadium-deck/protocol; this module only moves bytes and drives timers.
 */

import { Socket, connect as netConnect } from "node:net";
import {
  CmdIdAllocator,
  HeartbeatMonitor,
  RequestCorrelator,
  SUBSCRIBE_ALL,
  ZMTP_CLIENT_GREETING,
  ZMTP_FLAG_COMMAND,
  ZMTP_GREETING_SIZE,
  ZmtpFrameParser,
  classifyCommandSocketMessage,
  classifyUpdateSocketMessage,
  decodeOscPayloads,
  encodeFrame,
  encodeOsc,
  encodeReadyPayload,
  hasMoreFlag,
  isCommandFrame,
  validateGreeting,
  type CorrelatedResult,
  type DeviceReply,
  type OscValue,
  type OutboundRequest,
  type ZmtpSocketType,
} from "@stadium-deck/protocol";

export interface StadiumClientOptions {
  host: string;
  updatePort: number;
  commandPort: number;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  heartbeat?: { staleAfterMs?: number; deadAfterMs?: number };
  /** Called for every push/heartbeat on the subscribed stream and unsolicited command-socket traffic. */
  onEvent?: (event: StadiumEvent) => void;
  /** Called once when the link dies (socket close/error or heartbeat death). */
  onDown?: (reason: string) => void;
  /** Raw traffic tap for logging/capture. */
  onTraffic?: (record: TrafficRecord) => void;
}

export interface StadiumEvent {
  source: "update" | "command";
  reply: DeviceReply;
}

export interface TrafficRecord {
  direction: "in" | "out";
  socket: "update" | "command";
  address: string;
  typeTags: string;
  args: readonly OscValue[];
  sequence?: number;
  at: number;
}

async function openSocket(host: string, port: number, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`timed out connecting to ${host}:${port}`));
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.setNoDelay(true);
      resolve(socket);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (error.code === "ECONNREFUSED") {
        // The device refuses TCP connects when Remote Access is set to Deny.
        reject(
          new Error(
            `connection refused by ${host}:${port} — check the Stadium's Remote Access setting (Global Settings): it must be Allow, not Deny`,
          ),
        );
        return;
      }
      reject(error);
    });
  });
}

interface HandshakenStream {
  socket: Socket;
  parser: ZmtpFrameParser;
  /** Data frames that arrived packed behind the READY reply. */
  leftover: ReturnType<ZmtpFrameParser["feed"]>;
}

/**
 * Perform the client-side ZMTP 3.0 handshake:
 * greeting out -> 64-byte greeting in -> READY out -> READY in.
 */
async function performHandshake(
  socket: Socket,
  socketType: ZmtpSocketType,
  identity: Uint8Array | undefined,
  timeoutMs: number,
): Promise<HandshakenStream> {
  return new Promise((resolve, reject) => {
    const parser = new ZmtpFrameParser();
    let greetingBytes = new Uint8Array(0);
    let phase: "greeting" | "ready" = "greeting";
    const leftover: ReturnType<ZmtpFrameParser["feed"]> = [];

    const timer = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(new Error(`ZMTP handshake timed out (${socketType})`));
    }, timeoutMs);

    function cleanup(): void {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    }

    function onError(error: Error): void {
      cleanup();
      reject(error);
    }

    function onClose(): void {
      cleanup();
      reject(new Error(`socket closed during ZMTP handshake (${socketType})`));
    }

    function onData(chunk: Buffer): void {
      let data = new Uint8Array(chunk);
      if (phase === "greeting") {
        const merged = new Uint8Array(greetingBytes.length + data.length);
        merged.set(greetingBytes);
        merged.set(data, greetingBytes.length);
        greetingBytes = merged;
        if (greetingBytes.length < ZMTP_GREETING_SIZE) return;
        const check = validateGreeting(greetingBytes.subarray(0, ZMTP_GREETING_SIZE));
        if (!check.ok) {
          cleanup();
          socket.destroy();
          reject(new Error(`bad server greeting: ${check.reason}`));
          return;
        }
        phase = "ready";
        socket.write(encodeFrame(encodeReadyPayload(socketType, identity), ZMTP_FLAG_COMMAND));
        data = greetingBytes.subarray(ZMTP_GREETING_SIZE).slice();
        greetingBytes = new Uint8Array(0);
        if (data.length === 0) return;
      }
      const frames = parser.feed(data);
      for (let i = 0; i < frames.length; i++) {
        const frame = frames[i]!;
        if (isCommandFrame(frame)) {
          // Server READY consumed; keep any frames packed behind it.
          leftover.push(...frames.slice(i + 1));
          cleanup();
          resolve({ socket, parser, leftover });
          return;
        }
        leftover.push(frame);
      }
    }

    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
    socket.write(ZMTP_CLIENT_GREETING);
  });
}

export class StadiumClient {
  readonly host: string;
  readonly updatePort: number;
  readonly commandPort: number;
  readonly cmdIds = new CmdIdAllocator();
  private readonly correlator = new RequestCorrelator();
  private readonly options: StadiumClientOptions;
  private updateSocket: Socket;
  private commandSocket: Socket;
  private heartbeatMonitor: HeartbeatMonitor;
  private housekeepingTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private downReason: string | null = null;
  private readonly requestTimeoutMs: number;

  private constructor(
    options: StadiumClientOptions,
    updateSocket: Socket,
    commandSocket: Socket,
  ) {
    this.options = options;
    this.host = options.host;
    this.updatePort = options.updatePort;
    this.commandPort = options.commandPort;
    this.updateSocket = updateSocket;
    this.commandSocket = commandSocket;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 5000;
    this.heartbeatMonitor = new HeartbeatMonitor(Date.now(), options.heartbeat ?? {});
  }

  /** Connect both sockets, run both handshakes, subscribe, and start housekeeping. */
  static async connect(options: StadiumClientOptions): Promise<StadiumClient> {
    const connectTimeout = options.connectTimeoutMs ?? 5000;
    const updateSocket = await openSocket(options.host, options.updatePort, connectTimeout);
    let commandSocket: Socket;
    try {
      commandSocket = await openSocket(options.host, options.commandPort, connectTimeout);
    } catch (error) {
      updateSocket.destroy();
      throw error;
    }

    const client = new StadiumClient(options, updateSocket, commandSocket);
    try {
      const update = await performHandshake(updateSocket, "SUB", undefined, connectTimeout);
      // Subscribe to everything (single 0x01 byte, empty topic).
      updateSocket.write(encodeFrame(SUBSCRIBE_ALL));
      const command = await performHandshake(commandSocket, "DEALER", new Uint8Array(0), connectTimeout);
      client.wireSteadyState(update, command);
      return client;
    } catch (error) {
      updateSocket.destroy();
      commandSocket.destroy();
      throw error;
    }
  }

  private wireSteadyState(update: HandshakenStream, command: HandshakenStream): void {
    this.heartbeatMonitor.reset(Date.now());

    const onUpdateFrames = (frames: ReturnType<ZmtpFrameParser["feed"]>): void => {
      for (const frame of frames) {
        if (isCommandFrame(frame) || hasMoreFlag(frame)) continue; // commands + topic frames
        for (const decoded of decodeOscPayloads(frame.payload)) {
          const reply = classifyUpdateSocketMessage(decoded.message, decoded.sequence);
          this.heartbeatMonitor.noteTraffic(Date.now(), reply.kind === "heartbeat");
          this.tapTraffic("in", "update", decoded.message.address, decoded.message.typeTags, decoded.message.args, decoded.sequence);
          this.options.onEvent?.({ source: "update", reply });
        }
      }
    };

    const onCommandFrames = (frames: ReturnType<ZmtpFrameParser["feed"]>): void => {
      for (const frame of frames) {
        if (isCommandFrame(frame) || hasMoreFlag(frame)) continue;
        for (const decoded of decodeOscPayloads(frame.payload)) {
          this.tapTraffic("in", "command", decoded.message.address, decoded.message.typeTags, decoded.message.args, decoded.sequence);
          const reply = classifyCommandSocketMessage(decoded.message);
          if (!this.correlator.handleReply(reply)) {
            this.options.onEvent?.({ source: "command", reply });
          }
        }
      }
    };

    onUpdateFrames(update.leftover);
    onCommandFrames(command.leftover);
    this.updateSocket.on("data", (chunk: Buffer) => onUpdateFrames(update.parser.feed(new Uint8Array(chunk))));
    this.commandSocket.on("data", (chunk: Buffer) => onCommandFrames(command.parser.feed(new Uint8Array(chunk))));

    for (const [socket, name] of [
      [this.updateSocket, "update"],
      [this.commandSocket, "command"],
    ] as const) {
      socket.on("error", (error: Error) => this.markDown(`${name} socket error: ${error.message}`));
      socket.on("close", () => this.markDown(`${name} socket closed`));
    }

    this.housekeepingTimer = setInterval(() => {
      this.correlator.expire(Date.now());
      if (this.heartbeatMonitor.check(Date.now()) === "dead") {
        this.markDown("heartbeat timeout: no traffic on the subscribed stream");
      }
    }, 250);
    this.housekeepingTimer.unref?.();
  }

  private tapTraffic(
    direction: "in" | "out",
    socket: "update" | "command",
    address: string,
    typeTags: string,
    args: readonly OscValue[],
    sequence?: number,
  ): void {
    if (!this.options.onTraffic) return;
    const record: TrafficRecord = { direction, socket, address, typeTags, args, at: Date.now() };
    if (sequence !== undefined) record.sequence = sequence;
    this.options.onTraffic(record);
  }

  get heartbeatStats(): ReturnType<HeartbeatMonitor["stats"]> {
    return this.heartbeatMonitor.stats(Date.now());
  }

  get isUp(): boolean {
    return !this.closed && this.downReason === null;
  }

  private markDown(reason: string): void {
    if (this.closed || this.downReason !== null) return;
    this.downReason = reason;
    this.correlator.abortAll(reason);
    this.teardown();
    this.options.onDown?.(reason);
  }

  /** Send a request built by one of the typed builders; resolves with the correlated result. */
  async request(
    build: (cmdId: number) => OutboundRequest,
    timeoutMs?: number,
  ): Promise<CorrelatedResult> {
    const outbound = build(this.cmdIds.allocate());
    return this.sendOutbound(outbound, timeoutMs);
  }

  /**
   * Escape hatch for experimental messages (tools only — never the app UI).
   * `argsAfterCmdId` excludes the cmdId; it is allocated and prepended here
   * (typeTags must still include its leading `i`).
   */
  async sendRaw(
    address: string,
    typeTags: string,
    argsAfterCmdId: readonly OscValue[],
    expectAddress?: string,
    timeoutMs?: number,
  ): Promise<CorrelatedResult> {
    const cmdId = this.cmdIds.allocate();
    const args = [cmdId, ...argsAfterCmdId];
    const outbound: OutboundRequest =
      expectAddress !== undefined
        ? { address, typeTags, args, cmdId, expectAddress }
        : { address, typeTags, args, cmdId };
    return this.sendOutbound(outbound, timeoutMs);
  }

  private async sendOutbound(outbound: OutboundRequest, timeoutMs?: number): Promise<CorrelatedResult> {
    if (!this.isUp) {
      return { ok: false, reply: null, failure: "aborted", detail: this.downReason ?? "client closed" };
    }
    const encoded = encodeOsc(outbound.address, outbound.typeTags, outbound.args);
    const pending = this.correlator.track(outbound, Date.now() + (timeoutMs ?? this.requestTimeoutMs));
    this.tapTraffic("out", "command", outbound.address, outbound.typeTags, outbound.args);
    this.commandSocket.write(encodeFrame(encoded));
    return pending;
  }

  /** Fire-and-forget send on the command socket (no correlation). */
  send(address: string, typeTags: string, args: readonly OscValue[]): void {
    if (!this.isUp) return;
    this.tapTraffic("out", "command", address, typeTags, args);
    this.commandSocket.write(encodeFrame(encodeOsc(address, typeTags, args)));
  }

  private teardown(): void {
    if (this.housekeepingTimer) clearInterval(this.housekeepingTimer);
    this.housekeepingTimer = null;
    this.updateSocket.destroy();
    this.commandSocket.destroy();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.correlator.abortAll("client closed");
    this.teardown();
  }
}
