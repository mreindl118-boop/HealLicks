/**
 * StadiumLink: the always-on connection manager.
 *
 * Drives the pure protocol state machine with real effects — mDNS discovery,
 * StadiumClient sockets, reconnect timers — and fetches product info at every
 * steady state for firmware compatibility reporting. Consumers (WS relay,
 * capture wizard) see a simple status + event surface.
 */

import {
  DEFAULT_BACKOFF,
  buildProductInfoGet,
  checkCompatibility,
  decodeMsgpackBlob,
  initialContext,
  parseDeviceInfo,
  transition,
  type ConnectionAction,
  type ConnectionEvent,
  type ConnectionState,
  type CorrelatedResult,
  type DeviceInfo,
  type MachineContext,
  type OutboundRequest,
  type StadiumStatusPayload,
} from "@stadium-deck/protocol";
import { discoverFirstStadium } from "./discovery.js";
import { StadiumClient, type StadiumEvent, type TrafficRecord } from "./stadium-client.js";

export interface StadiumLinkOptions {
  /** Skip discovery and connect to this host directly. */
  host?: string;
  updatePort?: number;
  commandPort?: number;
  discoverTimeoutMs?: number;
  requestTimeoutMs?: number;
  onStatus?: (status: StadiumStatusPayload) => void;
  onEvent?: (event: StadiumEvent) => void;
  onTraffic?: (record: TrafficRecord) => void;
  log?: (message: string) => void;
}

export class StadiumLink {
  private state: ConnectionState = "idle";
  private context: MachineContext = initialContext();
  private client: StadiumClient | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private deviceInfo: DeviceInfo | null = null;
  private lastReason: string | null = null;
  private readonly options: StadiumLinkOptions;
  private discovering = false;

  constructor(options: StadiumLinkOptions = {}) {
    this.options = options;
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  get info(): DeviceInfo | null {
    return this.deviceInfo;
  }

  status(): StadiumStatusPayload {
    const info = this.deviceInfo;
    return {
      state: this.state,
      host: this.context.target?.host ?? this.options.host ?? null,
      reason: this.lastReason,
      device:
        info === null
          ? null
          : {
              model: info.model,
              firmwareVersion: info.firmwareVersion,
              compatibility: checkCompatibility(info).compatible,
              warnings: checkCompatibility(info).warnings,
            },
    };
  }

  start(): void {
    this.dispatch({ type: "start" });
  }

  async stop(): Promise<void> {
    this.dispatch({ type: "close" });
  }

  private log(message: string): void {
    this.options.log?.(message);
  }

  private dispatch(event: ConnectionEvent): void {
    const result = transition(this.state, this.context, event, DEFAULT_BACKOFF);
    const prevState = this.state;
    this.state = result.state;
    this.context = result.context;
    if (prevState !== result.state) {
      this.log(`link: ${prevState} -> ${result.state}${"error" in event ? ` (${event.error})` : ""}`);
    }
    for (const action of result.actions) {
      this.perform(action);
    }
    this.options.onStatus?.(this.status());
  }

  private perform(action: ConnectionAction): void {
    switch (action.type) {
      case "startDiscovery":
        void this.runDiscovery();
        break;
      case "openSockets":
        void this.runConnect(action.host, action.updatePort, action.commandPort);
        break;
      case "performHandshake":
        // Handshake happens inside StadiumClient.connect; nothing extra here.
        break;
      case "beginSteadyState":
        void this.fetchDeviceInfo();
        break;
      case "teardownSockets":
        this.client?.close();
        this.client = null;
        break;
      case "scheduleReconnect":
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.log(`link: reconnecting in ${action.delayMs}ms (attempt ${action.attempt})`);
        this.reconnectTimer = setTimeout(() => this.dispatch({ type: "backoffElapsed" }), action.delayMs);
        break;
      case "notifyOffline":
        this.lastReason = action.reason;
        break;
      case "notifyOnline":
        this.lastReason = null;
        break;
    }
  }

  private async runDiscovery(): Promise<void> {
    if (this.discovering) return;
    this.discovering = true;
    try {
      if (this.options.host !== undefined) {
        this.dispatch({
          type: "serviceFound",
          host: this.options.host,
          updatePort: this.options.updatePort ?? 2001,
          commandPort: this.options.commandPort ?? 2002,
        });
        return;
      }
      const found = await discoverFirstStadium(this.options.discoverTimeoutMs ?? 5000);
      if (this.state !== "discovering") return; // superseded by close/reconnect
      if (found === null) {
        this.dispatch({ type: "socketError", error: "no _stadiumserver._tcp instance found via mDNS" });
        return;
      }
      this.log(`link: discovered "${found.instanceName}" at ${found.host} (${found.updatePort}/${found.commandPort})`);
      this.dispatch({
        type: "serviceFound",
        host: found.host,
        updatePort: found.updatePort,
        commandPort: found.commandPort,
      });
    } finally {
      this.discovering = false;
    }
  }

  private async runConnect(host: string, updatePort: number, commandPort: number): Promise<void> {
    try {
      const clientOptions: Parameters<typeof StadiumClient.connect>[0] = {
        host,
        updatePort,
        commandPort,
        onDown: (reason) => this.dispatch({ type: "socketError", error: reason }),
        onEvent: (event) => this.options.onEvent?.(event),
      };
      if (this.options.requestTimeoutMs !== undefined) {
        clientOptions.requestTimeoutMs = this.options.requestTimeoutMs;
      }
      if (this.options.onTraffic) {
        clientOptions.onTraffic = this.options.onTraffic;
      }
      // StadiumClient.connect performs open + handshake in one step.
      this.dispatch({ type: "socketsConnected" });
      this.client = await StadiumClient.connect(clientOptions);
      if (this.state !== "handshaking") {
        this.client.close();
        this.client = null;
        return;
      }
      this.dispatch({ type: "handshakeComplete" });
    } catch (error) {
      if (this.state === "connecting" || this.state === "handshaking") {
        this.dispatch({ type: "socketError", error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  private async fetchDeviceInfo(): Promise<void> {
    const client = this.client;
    if (!client) return;
    const result = await client.request(buildProductInfoGet);
    if (result.ok && result.reply?.kind === "reply") {
      const blob = result.reply.message.args[1];
      const decoded = blob instanceof Uint8Array ? decodeMsgpackBlob(blob) : null;
      this.deviceInfo = parseDeviceInfo(decoded);
      const compat = checkCompatibility(this.deviceInfo);
      this.log(
        `link: device "${this.deviceInfo.model ?? "unknown"}" firmware ${this.deviceInfo.firmwareVersion ?? "unknown"} (${compat.compatible})`,
      );
      for (const warning of compat.warnings) this.log(`link: WARNING ${warning}`);
    } else {
      this.log(`link: product info query failed (${result.detail ?? result.failure ?? "unknown"})`);
    }
    this.options.onStatus?.(this.status());
  }

  /** Send a correlated request; fails fast when the link is not ready. */
  async request(build: (cmdId: number) => OutboundRequest, timeoutMs?: number): Promise<CorrelatedResult> {
    if (this.state !== "ready" || this.client === null) {
      return { ok: false, reply: null, failure: "aborted", detail: `stadium link is ${this.state}` };
    }
    return this.client.request(build, timeoutMs);
  }

  get rawClient(): StadiumClient | null {
    return this.client;
  }
}
