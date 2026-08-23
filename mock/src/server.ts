/**
 * The mock Stadium: two TCP listeners speaking ZMTP+OSC exactly like the
 * device — update/subscribe stream (default 2001, enveloped pushes and
 * heartbeats) and command socket (default 2002, raw OSC request/response) —
 * plus optional Bonjour advertisement as _stadiumserver._tcp.
 */

import { createServer, type Server, type Socket } from "node:net";
import {
  decodeOscPayloads,
  encodeEnvelope,
  encodeOsc,
  hasMoreFlag,
} from "@stadium-deck/protocol";
import { DeviceModel } from "./device-model.js";
import { Responder, type OutMessage } from "./responder.js";
import { serveZmtpConnection, type ZmtpServerConnection } from "./zmtp-server.js";

export interface MockStadiumOptions {
  host?: string;
  updatePort?: number;
  commandPort?: number;
  heartbeatMs?: number;
  /** Advertise _stadiumserver._tcp via Bonjour (needs a real LAN; off by default). */
  mdns?: boolean;
  instanceName?: string;
  verbose?: boolean;
  device?: DeviceModel;
}

interface Subscriber {
  conn: ZmtpServerConnection;
  subscribed: boolean;
}

export class MockStadium {
  readonly device: DeviceModel;
  readonly responder: Responder;
  readonly host: string;
  readonly heartbeatMs: number;
  private updateServer: Server | null = null;
  private commandServer: Server | null = null;
  private subscribers = new Set<Subscriber>();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private sequence = 0;
  private heartbeatCounter = 0;
  private mdnsService: { stop?: CallableFunction } | null = null;
  private readonly options: MockStadiumOptions;
  updatePort = 0;
  commandPort = 0;

  constructor(options: MockStadiumOptions = {}) {
    this.options = options;
    this.device = options.device ?? new DeviceModel();
    this.responder = new Responder(this.device);
    this.host = options.host ?? "127.0.0.1";
    this.heartbeatMs = options.heartbeatMs ?? 1000;
  }

  private log(...parts: unknown[]): void {
    if (this.options.verbose) {
      console.log("[mock]", ...parts);
    }
  }

  async start(): Promise<{ updatePort: number; commandPort: number }> {
    this.updatePort = await this.listen(
      (server) => (this.updateServer = server),
      this.options.updatePort ?? 2001,
      (socket) => this.acceptUpdateConnection(socket),
    );
    this.commandPort = await this.listen(
      (server) => (this.commandServer = server),
      this.options.commandPort ?? 2002,
      (socket) => this.acceptCommandConnection(socket),
    );
    this.heartbeatTimer = setInterval(() => this.emitHeartbeat(), this.heartbeatMs);
    if (this.options.mdns) {
      await this.advertise();
    }
    this.log(`listening: update=${this.host}:${this.updatePort} command=${this.host}:${this.commandPort}`);
    return { updatePort: this.updatePort, commandPort: this.commandPort };
  }

  private listen(
    store: (server: Server) => void,
    port: number,
    onConnection: (socket: Socket) => void,
  ): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer(onConnection);
      store(server);
      server.once("error", reject);
      server.listen(port, this.host, () => {
        const address = server.address();
        resolve(typeof address === "object" && address !== null ? address.port : port);
      });
    });
  }

  private async advertise(): Promise<void> {
    const { Bonjour } = await import("bonjour-service");
    const bonjour = new Bonjour();
    this.mdnsService = bonjour.publish({
      name: this.options.instanceName ?? "p35x1-mock",
      type: "stadiumserver",
      protocol: "tcp",
      port: this.updatePort,
    });
    this.log("advertising _stadiumserver._tcp via Bonjour");
  }

  private acceptUpdateConnection(socket: Socket): void {
    const subscriber: Subscriber = { conn: null as unknown as ZmtpServerConnection, subscribed: false };
    subscriber.conn = serveZmtpConnection(socket, (frame) => {
      // SUB subscription frame: 0x01 + topic (empty topic = everything).
      if (frame.payload.length >= 1 && frame.payload[0] === 0x01 && !hasMoreFlag(frame)) {
        subscriber.subscribed = true;
        this.log("subscriber attached");
      }
    });
    this.subscribers.add(subscriber);
    socket.on("close", () => this.subscribers.delete(subscriber));
    socket.on("error", () => socket.destroy());
  }

  private acceptCommandConnection(socket: Socket): void {
    let topicPending = false;
    serveZmtpConnection(socket, (frame, conn) => {
      if (hasMoreFlag(frame)) {
        topicPending = true; // multipart prefix; final part carries the OSC
        return;
      }
      topicPending = false;
      for (const decoded of decodeOscPayloads(frame.payload)) {
        this.log("<-", decoded.message.address, decoded.message.args);
        const result = this.responder.handle(decoded.message);
        for (const reply of result.replies) {
          this.sendCommandReply(conn, reply);
        }
        for (const push of result.pushes) {
          this.broadcast(push);
        }
      }
    });
    socket.on("error", () => socket.destroy());
  }

  private sendCommandReply(conn: ZmtpServerConnection, message: OutMessage): void {
    this.log("->", message.address, message.args);
    conn.sendFrame(encodeOsc(message.address, message.typeTags, message.args));
  }

  /** Broadcast a push to all subscribers, wrapped in the 12-byte envelope. */
  broadcast(message: OutMessage): void {
    const osc = encodeOsc(message.address, message.typeTags, message.args);
    this.sequence = (this.sequence + 1) & 0xffff;
    const wrapped = encodeEnvelope(osc, this.sequence);
    for (const subscriber of this.subscribers) {
      if (subscriber.subscribed) {
        subscriber.conn.sendFrame(wrapped);
      }
    }
  }

  private emitHeartbeat(): void {
    this.heartbeatCounter += 1;
    this.broadcast({ address: "/heartbeat", typeTags: "i", args: [this.heartbeatCounter] });
  }

  async stop(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    for (const subscriber of this.subscribers) {
      subscriber.conn.socket.destroy();
    }
    this.subscribers.clear();
    await Promise.all(
      [this.updateServer, this.commandServer].map(
        (server) =>
          new Promise<void>((resolve) => {
            if (!server) return resolve();
            server.close(() => resolve());
          }),
      ),
    );
    if (this.mdnsService?.stop) {
      await new Promise<void>((resolve) => this.mdnsService!.stop!(() => resolve()));
    }
  }
}
